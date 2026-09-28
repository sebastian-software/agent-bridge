import { isAbsolute } from "node:path";

import type { JsonValue, ObservedIdentity, Usage } from "../contract.js";
import type { AdapterEvent } from "./types.js";

export const PI_WORKER_PROTOCOL_VERSION = 1;
export const MAX_PI_WORKER_MESSAGE_BYTES = 1_048_576;
export const MAX_PI_WORKER_EVENT_BYTES = 64 * 1024;
export const MAX_PI_TEXT_FRAME_BYTES = 48 * 1024;

export const PI_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type PiToolName = (typeof PI_TOOL_NAMES)[number];

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export type PiWorkerStart = {
  readonly type: "start";
  readonly protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
  readonly workingDirectory: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly thinkingLevel: PiThinkingLevel;
  };
  readonly modelFiles: {
    readonly authPath: string;
    readonly modelsPath: string;
    readonly modelsStorePath: string;
  };
  readonly prompt: string;
  readonly tools: readonly PiToolName[];
};

export type PiWorkerControl =
  | PiWorkerStart
  | {
      readonly type: "tool_process_registered" | "tool_process_cleaned" | "tool_process_cleanup_done";
      readonly requestId: string;
      readonly processGroupId: number;
    }
  | { readonly type: "cancel" };

export type PiWorkerOutput =
  | { readonly type: "event"; readonly event: AdapterEvent }
  | { readonly type: "content"; readonly index: number; readonly text: string; readonly final: boolean }
  | { readonly type: "identity"; readonly identity: ObservedIdentity }
  | {
      readonly type: "tool_process_started" | "tool_process_finished" | "tool_process_reaped";
      readonly requestId: string;
      readonly processGroupId: number;
      readonly exitCode?: number | null;
      readonly signal?: string | null;
      readonly cause?: "completed" | "cancelled" | "timed_out";
    }
  | {
      readonly type: "terminal";
      readonly settled: true;
      readonly status: "succeeded" | "failed";
      readonly stopReason?: string;
      readonly failure?: { readonly code: string; readonly message: string };
      readonly observedIdentity: ObservedIdentity;
      readonly usage?: Usage;
    };

export type PiToolRunnerStart = {
  readonly type: "start";
  readonly requestId: string;
  readonly shell: string;
  readonly shellArgs: readonly string[];
  readonly commandTransport: "argv" | "stdin";
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export async function* readBoundedLines(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  maximumBytes: number,
): AsyncGenerator<string> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);
    while (true) {
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        break;
      }
      if (newline > maximumBytes) {
        throw new Error("Pi worker protocol line exceeded its limit.");
      }
      yield buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
    }
    if (buffered.byteLength > maximumBytes) {
      throw new Error("Pi worker protocol line exceeded its limit.");
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumBytes) {
      throw new Error("Pi worker protocol line exceeded its limit.");
    }
    yield buffered.toString("utf8");
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && value.length > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(jsonValue);
  }
  const record = object(value);
  return record !== undefined && Object.values(record).every(jsonValue);
}

function jsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  const record = object(value);
  return record !== undefined && Object.values(record).every(jsonValue);
}

function observedValue(value: unknown): boolean {
  const record = object(value);
  return (
    record !== undefined &&
    ["unverified", "inferred", "reported", "verified"].includes(String(record.evidence)) &&
    (record.value === undefined || string(record.value)) &&
    (record.source === undefined || string(record.source))
  );
}

function observedIdentity(value: unknown): value is ObservedIdentity {
  const record = object(value);
  return (
    record !== undefined &&
    observedValue(record.provider) &&
    observedValue(record.model) &&
    observedValue(record.harnessVersion) &&
    observedValue(record.nativeSessionId)
  );
}

function usage(value: unknown): value is Usage {
  const record = object(value);
  if (record === undefined || record.evidence !== "reported" || !string(record.source)) {
    return false;
  }
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"].every(
    (key) => record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key])),
  );
}

function adapterEvent(value: unknown): value is AdapterEvent {
  const record = object(value);
  if (
    record === undefined ||
    !["activity", "diagnostic", "output"].includes(String(record.category))
  ) {
    return false;
  }
  if (record.data !== undefined && !jsonRecord(record.data)) {
    return false;
  }
  if (record.native !== undefined && !jsonRecord(record.native)) {
    return false;
  }
  if (
    record.content !== undefined &&
    (!Array.isArray(record.content) ||
      !record.content.every((part) => {
        const item = object(part);
        return item !== undefined && item.type === "text" && string(item.text);
      }))
  ) {
    return false;
  }
  if (record.failure !== undefined) {
    const failure = object(record.failure);
    if (failure === undefined || !nonEmptyString(failure.code) || !nonEmptyString(failure.message)) {
      return false;
    }
  }
  if (
    record.effects !== undefined &&
    (!Array.isArray(record.effects) ||
      !record.effects.every((effectValue) => {
        const effect = object(effectValue);
        return (
          effect !== undefined &&
          nonEmptyString(effect.path) &&
          ["created", "deleted", "modified", "renamed", "unknown"].includes(
            String(effect.kind),
          ) &&
          ["git-status", "harness-reported"].includes(String(effect.evidence)) &&
          (effect.previousPath === undefined || string(effect.previousPath)) &&
          (effect.outsideWorkspace === undefined || effect.outsideWorkspace === true)
        );
      }))
  ) {
    return false;
  }
  if (record.usage !== undefined && !usage(record.usage)) {
    return false;
  }
  return true;
}

export function parsePiWorkerStart(value: unknown): PiWorkerStart {
  const record = object(value);
  const model = object(record?.model);
  const modelFiles = object(record?.modelFiles);
  const tools = record?.tools;
  const levels: readonly string[] = PI_THINKING_LEVELS;
  if (
    record?.type !== "start" ||
    record.protocolVersion !== PI_WORKER_PROTOCOL_VERSION ||
    !string(record.workingDirectory) ||
    record.workingDirectory.includes("\0") ||
    !isAbsolute(record.workingDirectory) ||
    model === undefined ||
    !nonEmptyString(model.provider) ||
    !nonEmptyString(model.id) ||
    !levels.includes(String(model.thinkingLevel)) ||
    modelFiles === undefined ||
    !string(modelFiles.authPath) ||
    modelFiles.authPath.includes("\0") ||
    !isAbsolute(modelFiles.authPath) ||
    !string(modelFiles.modelsPath) ||
    modelFiles.modelsPath.includes("\0") ||
    !isAbsolute(modelFiles.modelsPath) ||
    !string(modelFiles.modelsStorePath) ||
    modelFiles.modelsStorePath.includes("\0") ||
    !isAbsolute(modelFiles.modelsStorePath) ||
    !string(record.prompt) ||
    !Array.isArray(tools) ||
    !tools.every((tool) => PI_TOOL_NAMES.includes(tool as PiToolName))
  ) {
    throw new Error("Pi worker received an invalid start message.");
  }

  return {
    type: "start",
    protocolVersion: PI_WORKER_PROTOCOL_VERSION,
    workingDirectory: record.workingDirectory,
    model: {
      provider: model.provider,
      id: model.id,
      thinkingLevel: model.thinkingLevel as PiThinkingLevel,
    },
    modelFiles: {
      authPath: modelFiles.authPath,
      modelsPath: modelFiles.modelsPath,
      modelsStorePath: modelFiles.modelsStorePath,
    },
    prompt: record.prompt,
    tools: tools as PiToolName[],
  };
}

export function parsePiWorkerOutput(value: unknown): PiWorkerOutput {
  const record = object(value);
  if (record === undefined) {
    throw new Error("Pi worker emitted a non-object message.");
  }
  if (record.type === "event" && adapterEvent(record.event)) {
    return { type: "event", event: record.event };
  }
  if (
    record.type === "content" &&
    safeInteger(record.index) &&
    record.index >= 0 &&
    string(record.text) &&
    record.final === true
  ) {
    return { type: "content", index: record.index, text: record.text, final: true };
  }
  if (record.type === "identity" && observedIdentity(record.identity)) {
    return { type: "identity", identity: record.identity };
  }
  if (
    ["tool_process_started", "tool_process_finished", "tool_process_reaped"].includes(
      String(record.type),
    ) &&
    nonEmptyString(record.requestId) &&
    safeInteger(record.processGroupId) &&
    record.processGroupId > 0 &&
    (record.exitCode === undefined ||
      record.exitCode === null ||
      safeInteger(record.exitCode)) &&
    (record.signal === undefined || record.signal === null || string(record.signal)) &&
    (record.cause === undefined ||
      ["completed", "cancelled", "timed_out"].includes(String(record.cause)))
  ) {
    return {
      type: record.type as "tool_process_started" | "tool_process_finished" | "tool_process_reaped",
      requestId: record.requestId,
      processGroupId: record.processGroupId,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number | null }),
      ...(record.signal === undefined ? {} : { signal: record.signal as string | null }),
      ...(record.cause === undefined
        ? {}
        : { cause: record.cause as "completed" | "cancelled" | "timed_out" }),
    };
  }
  if (
    record.type === "terminal" &&
    record.settled === true &&
    ["succeeded", "failed"].includes(String(record.status)) &&
    observedIdentity(record.observedIdentity) &&
    (record.stopReason === undefined || string(record.stopReason)) &&
    (record.usage === undefined || usage(record.usage))
  ) {
    const failure = object(record.failure);
    if (
      record.status === "failed" &&
      (failure === undefined || !nonEmptyString(failure.code) || !nonEmptyString(failure.message))
    ) {
      throw new Error("Pi worker terminal failure is missing its error detail.");
    }
    if (record.status === "succeeded" && record.failure !== undefined) {
      throw new Error("Pi worker success cannot include a failure detail.");
    }
    return {
      type: "terminal",
      settled: true,
      status: record.status as "succeeded" | "failed",
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
      ...(failure === undefined
        ? {}
        : { failure: { code: failure.code as string, message: failure.message as string } }),
      observedIdentity: record.observedIdentity,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
  }
  throw new Error("Pi worker emitted an invalid message.");
}

export function parsePiWorkerControl(value: unknown): PiWorkerControl {
  const record = object(value);
  if (record === undefined) {
    throw new Error("Pi worker received a non-object control message.");
  }
  if (record.type === "start") {
    return parsePiWorkerStart(value);
  }
  if (record.type === "cancel") {
    return { type: "cancel" };
  }
  if (
    ["tool_process_registered", "tool_process_cleaned", "tool_process_cleanup_done"].includes(
      String(record.type),
    ) &&
    nonEmptyString(record.requestId) &&
    safeInteger(record.processGroupId) &&
    record.processGroupId > 0
  ) {
    return {
      type: record.type as
        | "tool_process_registered"
        | "tool_process_cleaned"
        | "tool_process_cleanup_done",
      requestId: record.requestId,
      processGroupId: record.processGroupId,
    };
  }
  throw new Error("Pi worker received an invalid control message.");
}

export function parsePiToolRunnerStart(value: unknown): PiToolRunnerStart {
  const record = object(value);
  const env = object(record?.env);
  if (
    record?.type !== "start" ||
    !nonEmptyString(record.requestId) ||
    !nonEmptyString(record.shell) ||
    !Array.isArray(record.shellArgs) ||
    !record.shellArgs.every(string) ||
    !["argv", "stdin"].includes(String(record.commandTransport)) ||
    !string(record.command) ||
    !string(record.cwd) ||
    record.cwd.includes("\0") ||
    !isAbsolute(record.cwd) ||
    env === undefined ||
    !Object.values(env).every(string)
  ) {
    throw new Error("Pi tool runner received an invalid start message.");
  }
  return {
    type: "start",
    requestId: record.requestId,
    shell: record.shell,
    shellArgs: record.shellArgs,
    commandTransport: record.commandTransport as "argv" | "stdin",
    command: record.command,
    cwd: record.cwd as string,
    env: env as Readonly<Record<string, string>>,
  };
}

export function parsePiWorkerLine(line: string): PiWorkerOutput {
  if (Buffer.byteLength(line, "utf8") > MAX_PI_WORKER_EVENT_BYTES) {
    throw new Error("Pi worker event exceeded the configured message limit.");
  }
  return parsePiWorkerOutput(JSON.parse(line) as unknown);
}

export function parsePiWorkerControlLine(line: string): PiWorkerControl {
  if (Buffer.byteLength(line, "utf8") > MAX_PI_WORKER_MESSAGE_BYTES) {
    throw new Error("Pi worker control message exceeded the configured message limit.");
  }
  return parsePiWorkerControl(JSON.parse(line) as unknown);
}
