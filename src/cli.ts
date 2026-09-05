#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Broker } from "./broker.js";
import { createClient } from "./client.js";
import { BridgeError, errorDetail } from "./errors.js";
import { BrokerServer, IpcClient } from "./ipc.js";
import { McpServer } from "./mcp.js";
import { brokerPaths } from "./paths.js";
import { loadBrokerConfig, type BrokerConfigValues } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `agent-bridge — local harness delegation gateway

Usage:
  agent-bridge describe [--json]
  agent-bridge routes [--refresh] [--json]
  agent-bridge start --provider <id> --model <id> --text <text> [options]
  agent-bridge run --provider <id> --model <id> [options] [prompt]
  agent-bridge list [--active] [--correlation <id>] [--json]
  agent-bridge inspect <invocation-id> [--json]
  agent-bridge get <invocation-id> [--json]
  agent-bridge result <invocation-id> [--json]
  agent-bridge wait <invocation-id> [--timeout-ms <milliseconds>] [--json]
  agent-bridge events <invocation-id> [--after <cursor>] [--follow] [--json]
  agent-bridge cancel <invocation-id> [--json]
  agent-bridge request <operation> [--params <json>] [--json]
  agent-bridge broker serve [configuration flags]
  agent-bridge broker status [--json]
  agent-bridge broker logs [--follow] [--json]
  agent-bridge broker restart [--force] [--json]
  agent-bridge broker stop [--force] [--json]
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
  --prompt-file <path>          Read the prompt from a file; use - for stdin
  --input-json <path|->          Read complete content parts as JSON
  --filesystem <mode>           inherit, read-only, or workspace-write
  --commands <mode>             allow, deny, or inherit
  --network <mode>              allow, deny, or inherit
  --add-dir <path>              Additional directory; repeatable
  --evidence <level>             Minimum observed identity evidence

Broker configuration flags:
  --retention-completed-days <n>  Completed invocation retention
  --retention-max-bytes <n>      Retained state byte budget
  --diagnostic-mode              Persist bounded native diagnostics in full
  --idle-shutdown-minutes <n>    Idle broker shutdown delay; zero disables
  --effects-max-files <n>        Workspace snapshot file limit
  --effects-max-bytes <n>        Workspace snapshot byte limit
  --termination-grace-ms <n>     Grace period before force-killing a process

Environment:
  AGENT_BRIDGE_RUNTIME_DIR      Override the user runtime directory
  AGENT_BRIDGE_STATE_DIR        Override the persisted state directory
  AGENT_BRIDGE_SOCKET_PATH      Override the Unix socket path
`;

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

const BOOLEAN_OPTIONS = new Set(["active", "diagnostic-mode", "fail-on-error", "follow", "force", "help", "json", "refresh", "until-terminal", "version"]);

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

function nonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BridgeError({
      code: "invalid_request",
      message: `--${name} must be a non-negative integer.`,
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

const client = createClient();

function human(value: unknown): void {
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function textContent(value: unknown): string {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
    return "";
  }
  return value.content
    .filter((part): part is { readonly type: "text"; readonly text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function eventSummary(event: unknown): string {
  if (typeof event !== "object" || event === null) {
    return "event";
  }
  const category = "category" in event && typeof event.category === "string" ? event.category : "event";
  if ("data" in event && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)) {
    const data = event.data as Readonly<Record<string, unknown>>;
    if (typeof data.state === "string") {
      return `${category}: ${data.state}`;
    }
    if (typeof data.message === "string") {
      return `${category}: ${data.message}`;
    }
  }
  if ("content" in event && Array.isArray(event.content)) {
    const text = textContent(event);
    if (text !== "") {
      return `${category}: ${text.replaceAll(/\s+/g, " ").slice(0, 160)}`;
    }
  }
  return category;
}

async function promptAndInput(parsed: ParsedArguments): Promise<readonly Record<string, unknown>[]> {
  const inputJson = option(parsed, "input-json");
  const promptFile = option(parsed, "prompt-file");
  const text = option(parsed, "text");
  if (inputJson !== undefined && (promptFile !== undefined || text !== undefined || parsed.positionals.length > 0)) {
    throw new BridgeError({ code: "invalid_request", message: "Use only one prompt source.", retryable: false });
  }
  if (inputJson !== undefined) {
    const raw = inputJson === "-" ? await readStandardInput() : await readFile(inputJson, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new BridgeError({ code: "invalid_request", message: "--input-json must contain valid JSON.", retryable: false }, { cause: error });
    }
    if (!Array.isArray(decoded)) {
      throw new BridgeError({ code: "invalid_request", message: "--input-json must contain a content-part array.", retryable: false });
    }
    return decoded as readonly Record<string, unknown>[];
  }
  let prompt: string | undefined = text;
  if (promptFile !== undefined) {
    prompt = promptFile === "-" ? await readStandardInput() : await readFile(promptFile, "utf8");
  } else if (prompt === undefined && parsed.positionals.length > 0) {
    prompt = parsed.positionals.join(" ");
  } else if (prompt === undefined && !process.stdin.isTTY) {
    prompt = await readStandardInput();
  }
  if (prompt === undefined || prompt === "") {
    throw new BridgeError({ code: "invalid_request", message: "Provide a prompt, --prompt-file, --input-json, or stdin.", retryable: false });
  }
  return [{ type: "text", text: prompt }];
}

async function startParams(parsed: ParsedArguments): Promise<Readonly<Record<string, unknown>>> {
  const provider = requiredOption(parsed, "provider");
  const model = requiredOption(parsed, "model");
  const effort = option(parsed, "effort");
  const via = option(parsed, "via");
  const evidence = option(parsed, "evidence");
  const timeoutMs = positiveInteger(option(parsed, "timeout-ms"), "timeout-ms");
  const idempotencyKey = option(parsed, "idempotency-key");
  const callerCorrelationId = option(parsed, "correlation-id");
  const filesystem = option(parsed, "filesystem");
  const commands = option(parsed, "commands");
  const network = option(parsed, "network");
  const additionalDirectories = parsed.options.get("add-dir") ?? [];
  const input = await promptAndInput(parsed);
  return {
    selector: {
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(via === undefined ? {} : { via }),
      requiredCapabilities: parsed.options.get("capability") ?? [],
      ...(evidence === undefined ? {} : { minimumObservedEvidence: evidence }),
    },
    input,
    workingDirectory: option(parsed, "cwd") ?? process.cwd(),
    interactionStrategy: option(parsed, "interaction") ?? "orchestrator",
    requestedPolicy: {
      ...(filesystem === undefined ? {} : { filesystem }),
      ...(commands === undefined ? {} : { commands }),
      ...(network === undefined ? {} : { network }),
      ...(additionalDirectories.length === 0 ? {} : { additionalDirectories }),
      minimumAssurance: option(parsed, "minimum-assurance") ?? "none",
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(callerCorrelationId === undefined ? {} : { callerCorrelationId }),
  };
}

function routeTable(value: unknown): string {
  if (typeof value !== "object" || value === null || !("routes" in value) || !Array.isArray(value.routes)) {
    return JSON.stringify(value, null, 2);
  }
  const lines = ["ROUTE                              READINESS    VERSION       AUTH       STRATEGIES"];
  for (const route of value.routes) {
    if (typeof route !== "object" || route === null) continue;
    const item = route as Readonly<Record<string, unknown>>;
    const strategies = Array.isArray(item.interactionStrategies) ? item.interactionStrategies.join(",") : "";
    lines.push(`${String(item.routeId ?? "").padEnd(34)} ${String(item.readiness ?? "").padEnd(11)} ${String(item.harnessVersion ?? "").padEnd(13)} ${String(item.authenticationMode ?? "").padEnd(10)} ${strategies}`);
  }
  return lines.join("\n");
}

function summaryTable(value: unknown): string {
  if (typeof value !== "object" || value === null || !("invocations" in value) || !Array.isArray(value.invocations)) {
    return JSON.stringify(value, null, 2);
  }
  const lines = ["INVOCATION                         STATE              CREATED                 ROUTE"];
  for (const entry of value.invocations) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Readonly<Record<string, unknown>>;
    lines.push(`${String(item.invocationId ?? "").padEnd(35)} ${String(item.state ?? "").padEnd(18)} ${String(item.createdAt ?? "").padEnd(24)} ${String(item.resolvedRouteId ?? "")}`);
  }
  return lines.join("\n");
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

async function startBroker(configOverrides: Partial<BrokerConfigValues> = {}): Promise<void> {
  const paths = brokerPaths();
  const config = await loadBrokerConfig(configOverrides);
  const broker = new Broker(paths, { config });
  await broker.initialize();
  const server = new BrokerServer(broker, paths.socketPath, paths.runtimeDirectory, config.idleShutdownMinutes, `${paths.stateDirectory}/broker.log`);
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
  return client.execute(operation, params);
}

async function requestRunningBroker(operation: string, params: unknown): Promise<unknown> {
  if (operation === "system.status") {
    return client.status();
  }
  const status = await client.status();
  if (!status.running) {
    return { running: false, socketPath: status.socketPath };
  }
  return new IpcClient(status.socketPath).request(operation, params);
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
  if (argv[0] === "--version" || command === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (command === undefined || command === "help" || parsed.options.has("help")) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "broker") {
    const action = positional(parsed, 0, "broker action");
    if (action === "serve") {
      const overrides: { -readonly [Key in keyof BrokerConfigValues]?: BrokerConfigValues[Key] } = {};
      const retentionCompletedDays = nonNegativeInteger(option(parsed, "retention-completed-days"), "retention-completed-days");
      const retentionMaxBytes = positiveInteger(option(parsed, "retention-max-bytes"), "retention-max-bytes");
      const idleShutdownMinutes = nonNegativeInteger(option(parsed, "idle-shutdown-minutes"), "idle-shutdown-minutes");
      const effectsMaxFiles = positiveInteger(option(parsed, "effects-max-files"), "effects-max-files");
      const effectsMaxBytes = positiveInteger(option(parsed, "effects-max-bytes"), "effects-max-bytes");
      const terminationGraceMs = positiveInteger(option(parsed, "termination-grace-ms"), "termination-grace-ms");
      if (retentionCompletedDays !== undefined) overrides.retentionCompletedDays = retentionCompletedDays;
      if (retentionMaxBytes !== undefined) overrides.retentionMaxBytes = retentionMaxBytes;
      if (parsed.options.has("diagnostic-mode")) overrides.diagnosticMode = true;
      if (idleShutdownMinutes !== undefined) overrides.idleShutdownMinutes = idleShutdownMinutes;
      if (effectsMaxFiles !== undefined) overrides.effectsMaxFiles = effectsMaxFiles;
      if (effectsMaxBytes !== undefined) overrides.effectsMaxBytes = effectsMaxBytes;
      if (terminationGraceMs !== undefined) overrides.terminationGraceMs = terminationGraceMs;
      await startBroker(overrides);
      return;
    }
    if (action === "stop") {
      const paths = brokerPaths();
      output(await new IpcClient(paths.socketPath).request("system.shutdown", { force: parsed.options.has("force") }), json);
      return;
    }
    if (action === "status") {
      const status = await requestRunningBroker("system.status", {});
      json ? output(status, true) : human(status);
      return;
    }
    if (action === "logs") {
      const paths = brokerPaths();
      if (parsed.options.has("follow")) {
        let offset = 0;
        while (true) {
          let text = "";
          try {
            text = await readFile(`${paths.stateDirectory}/broker.log`, "utf8");
          } catch (error) {
            if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
              throw error;
            }
          }
          if (text.length > offset) {
            process.stdout.write(text.slice(offset));
            offset = text.length;
          }
          await delay(250);
        }
      }
      try {
        output(await readFile(`${paths.stateDirectory}/broker.log`, "utf8"), json);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          output("", json);
          return;
        }
        throw error;
      }
      return;
    }
    if (action === "restart") {
      await requestRunningBroker("system.shutdown", { force: parsed.options.has("force") });
      await delay(100);
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
    const described = await requestBroker("system.describe", {});
    json ? output(described, true) : human(described);
    return;
  }
  if (command === "routes") {
    const routes = await requestBroker("route.discover", { refresh: parsed.options.has("refresh") });
    json ? output(routes, true) : process.stdout.write(`${routeTable(routes)}\n`);
    return;
  }
  if (command === "start" || command === "run") {
    const params = await startParams(parsed);
    const started = await client.start(params as never);
    if (command === "start") {
      json ? output(started, true) : human(`${started.invocationId} ${started.state}`);
      return;
    }
    let interrupted = false;
    const onSignal = (): void => {
      interrupted = true;
      void client.cancel(started.invocationId);
    };
    process.once("SIGINT", onSignal);
    try {
      if (json) {
        for await (const event of client.follow(started.invocationId)) {
          output(event, true);
        }
      } else {
        for await (const event of client.follow(started.invocationId)) {
          process.stderr.write(`${eventSummary(event)}\n`);
        }
      }
      const result = await client.result(started.invocationId);
      if (json) {
        output(result, true);
      } else {
        const content = textContent(result.outcome);
        if (content !== "") process.stdout.write(`${content}\n`);
        if (result.outcome.error !== undefined) process.stderr.write(`${result.outcome.error.message}\n`);
      }
      if (interrupted || result.outcome.status !== "succeeded") {
        process.exitCode = interrupted ? exitCode("cancelled") : exitCode(result.outcome.status);
      }
    return;
    } finally {
      process.removeListener("SIGINT", onSignal);
    }
  }
  if (command === "list") {
    const correlation = option(parsed, "correlation");
    const list = await client.list({
      ...(correlation === undefined ? {} : { callerCorrelationId: correlation }),
      ...(parsed.options.has("active") ? {} : {}),
    });
    const filtered = parsed.options.has("active")
      ? { ...list, invocations: list.invocations.filter((entry) => !["cancelled", "failed", "interrupted", "succeeded", "timed_out"].includes(entry.state)) }
      : list;
    json ? output(filtered, true) : process.stdout.write(`${summaryTable(filtered)}\n`);
    return;
  }
  if (command === "inspect" || command === "get") {
    const operation = command === "get" ? "invocation.get" : "invocation.inspect";
    const inspected = await requestBroker(operation, {
      invocationId: positional(parsed, 0, "invocation ID"),
    });
    json ? output(inspected, true) : human(inspected);
    return;
  }
  if (command === "result") {
    const result = await requestBroker("invocation.result", {
      invocationId: positional(parsed, 0, "invocation ID"),
    });
    if (json) {
      output(result, true);
    } else {
      const content = textContent(result);
      if (content !== "") process.stdout.write(`${content}\n`);
      if (parsed.options.has("fail-on-error") && typeof result === "object" && result !== null && "state" in result && result.state !== "succeeded") {
        process.exitCode = exitCode(String(result.state));
      }
    }
    return;
  }
  if (command === "wait") {
    const timeoutMs = boundedPositiveInteger(option(parsed, "timeout-ms"), "timeout-ms", 30_000);
    const invocationId = positional(parsed, 0, "invocation ID");
    const waited = parsed.options.has("until-terminal")
      ? await client.wait(invocationId)
      : await requestBroker("invocation.wait", { invocationId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    json ? output(waited, true) : human(typeof waited === "object" && waited !== null && "state" in waited ? `${String(waited.state)}${"waited" in waited && waited.waited === false ? " (still active)" : ""}` : waited);
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
        json ? output(event, true) : process.stdout.write(`${eventSummary(event)}\n`);
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
