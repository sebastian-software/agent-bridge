#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Broker } from "./broker.js";
import { BridgeError, errorDetail } from "./errors.js";
import { BrokerServer, IpcClient } from "./ipc.js";
import { McpServer } from "./mcp.js";
import { brokerPaths } from "./paths.js";

const HELP = `agent-bridge — local harness delegation gateway

Usage:
  agent-bridge describe [--json]
  agent-bridge routes [--json]
  agent-bridge start --provider <id> --model <id> --text <text> [options]
  agent-bridge inspect <invocation-id> [--json]
  agent-bridge get <invocation-id> [--json]
  agent-bridge result <invocation-id> [--json]
  agent-bridge wait <invocation-id> [--timeout-ms <milliseconds>] [--json]
  agent-bridge events <invocation-id> [--after <cursor>] [--follow] [--json]
  agent-bridge cancel <invocation-id> [--json]
  agent-bridge request <operation> [--params <json>] [--json]
  agent-bridge broker serve
  agent-bridge broker status [--json]
  agent-bridge broker stop [--json]
  agent-bridge mcp serve

Start options:
  --effort <level>              Requested effort level
  --via <harness>               Required harness family
  --capability <id>             Required capability; repeatable
  --cwd <absolute-path>         Working directory; defaults to the current directory
  --timeout-ms <milliseconds>   Positive invocation timeout
  --interaction <strategy>      orchestrator, deny, or unattended
  --minimum-assurance <level>   none, native, or isolated
  --idempotency-key <key>       Deduplicate an equivalent start request
  --correlation-id <id>         Opaque caller-owned correlation value

Environment:
  AGENT_BRIDGE_RUNTIME_DIR      Override the user runtime directory
  AGENT_BRIDGE_STATE_DIR        Override the persisted state directory
  AGENT_BRIDGE_SOCKET_PATH      Override the Unix socket path
`;

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

const BOOLEAN_OPTIONS = new Set(["follow", "help", "json"]);

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "") {
      throw new BridgeError({
        code: "invalid_request",
        message: "An option name cannot be empty.",
        retryable: false,
      });
    }
    const values = options.get(name) ?? [];
    if (BOOLEAN_OPTIONS.has(name)) {
      options.set(name, [...values, "true"]);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BridgeError({
        code: "invalid_request",
        message: `--${name} requires a value.`,
        retryable: false,
      });
    }
    options.set(name, [...values, value]);
    index += 1;
  }
  return { positionals, options };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name);
  if (value === undefined || value === "") {
    throw new BridgeError({
      code: "invalid_request",
      message: `--${name} is required.`,
      retryable: false,
    });
  }
  return value;
}

function positional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value === "") {
    throw new BridgeError({
      code: "invalid_request",
      message: `${label} is required.`,
      retryable: false,
    });
  }
  return value;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BridgeError({
      code: "invalid_request",
      message: `--${name} must be a positive integer.`,
      retryable: false,
    });
  }
  return parsed;
}

function boundedPositiveInteger(value: string | undefined, name: string, maximum: number): number | undefined {
  const parsed = positiveInteger(value, name);
  if (parsed !== undefined && parsed > maximum) {
    throw new BridgeError({
      code: "invalid_request",
      message: `--${name} must not exceed ${maximum}.`,
      retryable: false,
    });
  }
  return parsed;
}

function exitCode(code: string): number {
  switch (code) {
    case "invalid_request":
      return 2;
    case "broker_unavailable":
      return 3;
    case "invocation_not_found":
    case "invocation_evicted":
    case "invocation_not_active":
      return 4;
    case "route_ambiguous":
    case "route_unavailable":
      return 5;
    case "invocation_conflict":
      return 6;
    default:
      return 1;
  }
}

function output(value: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
}

async function readStandardInput(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  process.stdin.setEncoding("utf8");
  let result = "";
  for await (const chunk of process.stdin) {
    result += chunk;
    if (Buffer.byteLength(result, "utf8") > 1_048_576) {
      throw new BridgeError({
        code: "invalid_request",
        message: "Standard input exceeds the one-MiB CLI limit.",
        retryable: false,
      });
    }
  }
  return result;
}

async function startBroker(): Promise<void> {
  const paths = brokerPaths();
  const broker = new Broker(paths);
  await broker.initialize();
  const server = new BrokerServer(broker, paths.socketPath);
  await server.start();
  if (process.env.AGENT_BRIDGE_DAEMON !== "1") {
    process.stderr.write(`agent-bridge broker listening at ${paths.socketPath}\n`);
  }
  const signal = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await Promise.race([signal, server.closed]);
  await server.stop();
}

async function requestBroker(operation: string, params: unknown): Promise<unknown> {
  const paths = brokerPaths();
  const client = new IpcClient(paths.socketPath);
  try {
    return await client.request(operation, params);
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "broker_unavailable" || !error.retryable) {
      throw error;
    }
  }

  const cliPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [cliPath, "broker", "serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENT_BRIDGE_DAEMON: "1" },
  });
  child.unref();

  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(50);
    try {
      return await client.request(operation, params);
    } catch (error) {
      lastError = error;
      if (!(error instanceof BridgeError) || error.code !== "broker_unavailable") {
        throw error;
      }
    }
  }
  throw new BridgeError({
    code: "broker_unavailable",
    message: `The broker did not become ready at ${paths.socketPath}.`,
    retryable: true,
  }, { cause: lastError });
}

async function startMcp(): Promise<void> {
  await new McpServer((operation, params) => requestBroker(operation, params)).serve();
}

function parseEventsPage(value: unknown): {
  readonly events: readonly unknown[];
  readonly nextCursor?: string;
  readonly terminal: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: "The broker returned an invalid events result.",
      retryable: true,
    });
  }
  if (!("events" in value) || !Array.isArray(value.events) || !("terminal" in value) || typeof value.terminal !== "boolean") {
    throw new BridgeError({
      code: "broker_unavailable",
      message: "The broker returned an incomplete events result.",
      retryable: true,
    });
  }
  const nextCursor = "nextCursor" in value && typeof value.nextCursor === "string"
    ? value.nextCursor
    : undefined;
  return {
    events: value.events,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    terminal: value.terminal,
  };
}

async function runCommand(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const parsed = parseArguments(argv.slice(1));
  const json = parsed.options.has("json");
  if (command === undefined || command === "help" || parsed.options.has("help")) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "broker") {
    const action = positional(parsed, 0, "broker action");
    if (action === "serve") {
      await startBroker();
      return;
    }
    if (action === "stop") {
      const paths = brokerPaths();
      output(await new IpcClient(paths.socketPath).request("system.shutdown", {}), json);
      return;
    }
    if (action === "status") {
      output(await requestBroker("system.status", {}), json);
      return;
    }
    if (action !== "serve") {
      throw new BridgeError({
        code: "invalid_request",
        message: "Supported broker actions are serve, status, and stop.",
        retryable: false,
      });
    }
  }
  if (command === "mcp") {
    const action = positional(parsed, 0, "MCP action");
    if (action === "serve") {
      await startMcp();
      return;
    }
    throw new BridgeError({
      code: "invalid_request",
      message: "Supported MCP action is serve.",
      retryable: false,
    });
  }
  if (command === "describe") {
    output(await requestBroker("system.describe", {}), json);
    return;
  }
  if (command === "routes") {
    output(await requestBroker("route.discover", {}), json);
    return;
  }
  if (command === "start") {
    const effort = option(parsed, "effort");
    const via = option(parsed, "via");
    const timeoutMs = positiveInteger(option(parsed, "timeout-ms"), "timeout-ms");
    const idempotencyKey = option(parsed, "idempotency-key");
    const callerCorrelationId = option(parsed, "correlation-id");
    const interactionStrategy = option(parsed, "interaction") ?? "orchestrator";
    const minimumAssurance = option(parsed, "minimum-assurance") ?? "none";
    const params = {
      selector: {
        provider: requiredOption(parsed, "provider"),
        model: requiredOption(parsed, "model"),
        ...(effort === undefined ? {} : { effort }),
        ...(via === undefined ? {} : { via }),
        requiredCapabilities: parsed.options.get("capability") ?? [],
      },
      input: [{ type: "text", text: requiredOption(parsed, "text") }],
      workingDirectory: option(parsed, "cwd") ?? process.cwd(),
      interactionStrategy,
      requestedPolicy: { minimumAssurance },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(callerCorrelationId === undefined ? {} : { callerCorrelationId }),
    };
    output(await requestBroker("invocation.start", params), json);
    return;
  }
  if (command === "inspect" || command === "get") {
    const operation = command === "get" ? "invocation.get" : "invocation.inspect";
    output(await requestBroker(operation, {
      invocationId: positional(parsed, 0, "invocation ID"),
    }), json);
    return;
  }
  if (command === "result") {
    output(await requestBroker("invocation.result", {
      invocationId: positional(parsed, 0, "invocation ID"),
    }), json);
    return;
  }
  if (command === "wait") {
    const timeoutMs = boundedPositiveInteger(option(parsed, "timeout-ms"), "timeout-ms", 30_000);
    output(await requestBroker("invocation.wait", {
      invocationId: positional(parsed, 0, "invocation ID"),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }), json);
    return;
  }
  if (command === "events") {
    const invocationId = positional(parsed, 0, "invocation ID");
    let after = option(parsed, "after");
    if (!parsed.options.has("follow")) {
      output(await requestBroker("invocation.events", {
        invocationId,
        ...(after === undefined ? {} : { after }),
      }), json);
      return;
    }
    while (true) {
      const page = parseEventsPage(await requestBroker("invocation.events", {
        invocationId,
        ...(after === undefined ? {} : { after }),
        waitMs: 30_000,
      }));
      for (const event of page.events) {
        output(event, true);
      }
      if (page.nextCursor !== undefined) {
        after = page.nextCursor;
      }
      if (page.terminal) {
        return;
      }
    }
  }
  if (command === "cancel") {
    output(await requestBroker("invocation.cancel", {
      invocationId: positional(parsed, 0, "invocation ID"),
    }), json);
    return;
  }
  if (command === "request") {
    const operation = positional(parsed, 0, "operation");
    const paramsText = option(parsed, "params") ?? await readStandardInput();
    let params: unknown = {};
    if (paramsText.trim() !== "") {
      try {
        params = JSON.parse(paramsText) as unknown;
      } catch (error) {
        throw new BridgeError({
          code: "invalid_request",
          message: "Request params must be valid JSON.",
          retryable: false,
        }, { cause: error });
      }
    }
    output(await requestBroker(operation, params), json);
    return;
  }
  throw new BridgeError({
    code: "invalid_request",
    message: `Unknown command: ${command}`,
    retryable: false,
  });
}

runCommand(process.argv.slice(2)).catch((error: unknown) => {
  const detail = errorDetail(error);
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
  } else {
    process.stderr.write(`agent-bridge: ${detail.message} (${detail.code})\n`);
  }
  process.exitCode = exitCode(detail.code);
});
