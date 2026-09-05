import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { errorDetail } from "./errors.js";
import { OPERATION_DEFINITIONS, OPERATIONS_VERSION } from "./operations.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
const TOOL_PREFIX = "agent_bridge_";

type RpcId = string | number | null;
type OperationHandler = (operation: string, params: unknown) => Promise<unknown>;
type UnknownRecord = Record<string, unknown>;

interface RpcRequest {
  readonly id?: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function id(value: unknown): RpcId | undefined {
  return value === null || typeof value === "string" || typeof value === "number" ? value : undefined;
}

function toolName(operation: string): string {
  return `${TOOL_PREFIX}${operation.replaceAll(".", "_")}`;
}

function operationName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.startsWith(TOOL_PREFIX)) {
    return undefined;
  }
  const candidate = name.slice(TOOL_PREFIX.length).replaceAll("_", ".");
  return OPERATION_DEFINITIONS.some((definition) => definition.name === candidate && definition.availability === "implemented")
    ? candidate
    : undefined;
}

function schemaFile(name: string): Readonly<Record<string, unknown>> {
  const candidates = [
    new URL(`../../schemas/${name}.schema.json`, import.meta.url),
    new URL(`../schemas/${name}.schema.json`, import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(candidate), "utf8")) as Readonly<Record<string, unknown>>;
    } catch {
      // Try the source-tree path when tests execute TypeScript directly.
    }
  }
  return { type: "object", additionalProperties: true };
}

function inlineSchema(value: unknown, root: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => inlineSchema(entry, root));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = value as Readonly<Record<string, unknown>>;
  if (typeof source.$ref === "string" && source.$ref.startsWith("#/$defs/")) {
    const definition = source.$ref.slice("#/$defs/".length);
    const defs = root.$defs;
    if (typeof defs === "object" && defs !== null && !Array.isArray(defs) && definition in defs) {
      return inlineSchema((defs as Readonly<Record<string, unknown>>)[definition], root);
    }
  }
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => key !== "$defs")
    .map(([key, entry]) => [key, inlineSchema(entry, root)]));
}

const INVOCATION_REQUEST_SCHEMA = inlineSchema(schemaFile("invocation-request"), schemaFile("invocation-request"));

function definition(name: string): (typeof OPERATION_DEFINITIONS)[number] | undefined {
  return OPERATION_DEFINITIONS.find((entry) => entry.name === name);
}

function toolSchema(name: string, key: "input" | "output"): unknown {
  if (name === "invocation.start" && key === "input") {
    return INVOCATION_REQUEST_SCHEMA;
  }
  return definition(name)?.[key] ?? { type: "object", additionalProperties: true };
}

function response(requestId: RpcId, result: unknown): UnknownRecord {
  return { jsonrpc: "2.0", id: requestId, result };
}

function rpcError(requestId: RpcId, code: number, message: string, data?: unknown): UnknownRecord {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function parseRequest(value: unknown): RpcRequest {
  const source = record(value);
  const requestId = source === undefined ? undefined : id(source.id);
  if (source === undefined || typeof source.method !== "string" || ("id" in source && requestId === undefined)) {
    throw new Error("MCP request must contain a method and an optional scalar id.");
  }
  return {
    ...(requestId === undefined ? {} : { id: requestId }),
    method: source.method,
    ...(source.params === undefined ? {} : { params: source.params }),
  };
}

export class McpServer {
  readonly #handleOperation: OperationHandler;

  constructor(handleOperation: OperationHandler) {
    this.#handleOperation = handleOperation;
  }

  async handle(line: string): Promise<string | undefined> {
    let request: RpcRequest;
    try {
      request = parseRequest(JSON.parse(line) as unknown);
    } catch (error) {
      return JSON.stringify(rpcError(null, -32700, error instanceof Error ? error.message : "Invalid MCP request."));
    }
    if (request.id === undefined) {
      return undefined;
    }
    if (request.method === "initialize") {
      const params = record(request.params);
      const requestedVersion = params?.protocolVersion;
      const protocolVersion = typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : MCP_PROTOCOL_VERSION;
      return JSON.stringify(response(request.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-bridge", version: OPERATIONS_VERSION },
      }));
    }
    if (request.method === "ping") {
      return JSON.stringify(response(request.id, {}));
    }
    if (request.method === "tools/list") {
      return JSON.stringify(response(request.id, {
        tools: OPERATION_DEFINITIONS.filter((definition) => definition.availability === "implemented").map((definition) => ({
          name: toolName(definition.name),
          description: definition.summary,
          inputSchema: toolSchema(definition.name, "input"),
          outputSchema: toolSchema(definition.name, "output"),
        })),
      }));
    }
    if (request.method === "tools/call") {
      const params = record(request.params);
      const operation = operationName(params?.name);
      if (operation === undefined) {
        return JSON.stringify(response(request.id, {
          isError: true,
          content: [{ type: "text", text: "Unknown agent-bridge tool." }],
        }));
      }
      const argumentsValue = params?.arguments ?? {};
      try {
        const result = await this.#handleOperation(operation, argumentsValue);
        return JSON.stringify(response(request.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        }));
      } catch (error) {
        const detail = errorDetail(error);
        return JSON.stringify(response(request.id, {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: detail }) }],
          structuredContent: { error: detail },
        }));
      }
    }
    return JSON.stringify(rpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`));
  }

  async serve(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const lines = createInterface({ input });
    for await (const line of lines) {
      const result = await this.handle(line);
      if (result !== undefined) {
        output.write(`${result}\n`);
      }
    }
  }
}
