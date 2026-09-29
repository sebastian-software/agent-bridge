import type {
  ModelRuntime,
  AgentSession as PiAgentSession,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { ObservedIdentity, Usage, WorkspaceEffect } from "../contract.js";
import type { AdapterEvent } from "./types.js";

import {
  assertPiAuthStorageContentSafe,
  assertPiModelRuntimeConfigurationSafe,
  assertPiRuntimeConfigurationSafe,
  PiRuntimeConfigurationError,
  type PiRuntimeConfigurationFailureCode,
} from "./pi-config-guard.js";
import {
  MAX_PI_PENDING_STEERING_BYTES,
  MAX_PI_PENDING_STEERING_INPUTS,
  MAX_PI_STEERING_INPUT_BYTES,
  MAX_PI_TEXT_FRAME_BYTES,
  MAX_PI_WORKER_EVENT_BYTES,
  MAX_PI_WORKER_MESSAGE_BYTES,
  parsePiWorkerControl,
  parsePiWorkerStart,
  PI_WORKER_PROTOCOL_VERSION,
  type PiToolRunnerStart,
  type PiWorkerControl,
  type PiWorkerOutput,
  type PiWorkerSessionRequest,
  type PiWorkerSessionSnapshot,
  type PiWorkerStart,
  readBoundedLines,
} from "./pi-protocol.js";

const PI_HARNESS_VERSION = "0.87.1";
const MAX_QUEUED_OUTPUT_BYTES = 34 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ASSISTANT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;

type PiRuntimeCredentialStore = NonNullable<
  NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]
>;
type PiAuthOperationOptions = Parameters<PiRuntimeCredentialStore["read"]>[1];
type PiAuthLockResult<T> = { readonly result: T; readonly next?: string };
type PiAuthStorageBackend = {
  readonly withLock: <T>(callback: (current: string | undefined) => PiAuthLockResult<T>) => T;
  readonly withLockAsync: <T>(
    callback: (current: string | undefined) => Promise<PiAuthLockResult<T>>,
    options?: PiAuthOperationOptions,
  ) => Promise<T>;
};
type PiAuthStorageModule = {
  readonly FileAuthStorageBackend: new (authPath: string) => PiAuthStorageBackend;
  readonly AuthStorage: {
    readonly fromStorage: (storage: PiAuthStorageBackend) => PiRuntimeCredentialStore;
  };
};

type PiSdk = {
  readonly SessionManager: {
    readonly open: (
      path: string,
      sessionDirectory?: string,
      cwdOverride?: string,
    ) => PiSessionManager;
    readonly create: (cwd: string, sessionDirectory?: string) => PiSessionManager;
    readonly inMemory: (cwd?: string) => PiSessionManager;
  };
};

class PiSessionCheckpointError extends Error {
  readonly code: "continuation_route_changed" | "continuation_unavailable";

  constructor(code: "continuation_route_changed" | "continuation_unavailable", message: string) {
    super(message);
    this.name = "PiSessionCheckpointError";
    this.code = code;
  }
}

type RunnerResult = {
  readonly type: "result";
  readonly exitCode: null | number;
  readonly signal: null | string;
  readonly error?: string;
};

type Deferred = {
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingAck = {
  readonly processGroupId: number;
  readonly deferred: Deferred;
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

export function supportsPiNodeVersion(version: string): boolean {
  const [majorText, minorText, patchText] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  return (
    Number.isSafeInteger(major) &&
    Number.isSafeInteger(minor) &&
    Number.isSafeInteger(patch) &&
    (major > 22 || (major === 22 && minor >= 19))
  );
}

function failureCode(error: unknown): string {
  if (error instanceof PiSessionCheckpointError || error instanceof PiRuntimeConfigurationError) {
    return error.code;
  }
  if (error instanceof Error && error.message.includes("Pi assistant output exceeded")) {
    return "pi_output_limit";
  }
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
  ) {
    return "pi_sdk_unavailable";
  }
  return "pi_worker_failed";
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPiAuthStorageModule(value: unknown): value is PiAuthStorageModule {
  const module = recordFromUnknown(value);
  const authStorage = module?.AuthStorage;
  if (
    typeof module?.FileAuthStorageBackend !== "function" ||
    (typeof authStorage !== "function" && recordFromUnknown(authStorage) === undefined)
  ) {
    return false;
  }
  return typeof Reflect.get(authStorage as object, "fromStorage") === "function";
}

function isPiCredentialStore(value: unknown): value is PiRuntimeCredentialStore {
  const store = recordFromUnknown(value);
  return (
    typeof store?.read === "function" &&
    typeof store.list === "function" &&
    typeof store.modify === "function" &&
    typeof store.delete === "function"
  );
}

function piAuthStorageFailure(
  error: unknown,
  state: { failureCode?: PiRuntimeConfigurationFailureCode },
): PiRuntimeConfigurationError {
  if (error instanceof PiRuntimeConfigurationError) {
    state.failureCode = error.code;
  } else {
    state.failureCode = "pi_config_unavailable";
  }
  return new PiRuntimeConfigurationError(state.failureCode);
}

async function createGuardedPiCredentials(authPath: string): Promise<{
  readonly credentials: PiRuntimeCredentialStore;
  readonly assertHealthy: () => void;
}> {
  let authStorageModuleValue: unknown;
  try {
    const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    authStorageModuleValue = await import(new URL("core/auth-storage.js", sdkEntry).href);
  } catch {
    throw new PiRuntimeConfigurationError("pi_config_unavailable");
  }
  if (!isPiAuthStorageModule(authStorageModuleValue)) {
    throw new PiRuntimeConfigurationError("pi_config_unavailable");
  }
  // This internal module is intentionally pinned to the worker's verified Pi 0.87.1 runtime.
  const authStorageModule = authStorageModuleValue;
  const state: { failureCode?: PiRuntimeConfigurationFailureCode } = {};
  const assertHealthy = (): void => {
    if (state.failureCode !== undefined) {
      throw new PiRuntimeConfigurationError(state.failureCode);
    }
  };
  const inspectAuthContent = (content: string | undefined): void => {
    try {
      assertPiAuthStorageContentSafe(content);
    } catch (error) {
      throw piAuthStorageFailure(error, state);
    }
  };
  const inspectLockResult = <T>(value: PiAuthLockResult<T>): PiAuthLockResult<T> => {
    const result = recordFromUnknown(value);
    if (result === undefined || !("result" in result)) {
      throw piAuthStorageFailure(undefined, state);
    }
    if (result.next !== undefined) {
      if (typeof result.next !== "string") {
        throw piAuthStorageFailure(undefined, state);
      }
      inspectAuthContent(result.next);
    }
    return value;
  };

  let nativeBackend: PiAuthStorageBackend;
  try {
    nativeBackend = new authStorageModule.FileAuthStorageBackend(authPath);
  } catch (error) {
    throw piAuthStorageFailure(error, state);
  }
  const backend: PiAuthStorageBackend = {
    withLock<T>(callback: (current: string | undefined) => PiAuthLockResult<T>): T {
      try {
        return nativeBackend.withLock((current) => {
          inspectAuthContent(current);
          return inspectLockResult(callback(current));
        });
      } catch (error) {
        throw piAuthStorageFailure(error, state);
      }
    },
    async withLockAsync<T>(
      callback: (current: string | undefined) => Promise<PiAuthLockResult<T>>,
      options?: PiAuthOperationOptions,
    ): Promise<T> {
      try {
        return await nativeBackend.withLockAsync(async (current) => {
          inspectAuthContent(current);
          return inspectLockResult(await callback(current));
        }, options);
      } catch (error) {
        throw piAuthStorageFailure(error, state);
      }
    },
  };

  let nativeCredentials: unknown;
  try {
    nativeCredentials = authStorageModule.AuthStorage.fromStorage(backend);
  } catch (error) {
    throw piAuthStorageFailure(error, state);
  }
  if (!isPiCredentialStore(nativeCredentials)) {
    throw piAuthStorageFailure(undefined, state);
  }
  assertHealthy();

  const guardedOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertHealthy();
    try {
      const result = await operation();
      assertHealthy();
      return result;
    } catch (error) {
      if (state.failureCode !== undefined) {
        throw new PiRuntimeConfigurationError(state.failureCode);
      }
      throw error;
    }
  };
  const credentials: PiRuntimeCredentialStore = {
    read: async (providerId, options) =>
      guardedOperation(async () => nativeCredentials.read(providerId, options)),
    list: async (options) => guardedOperation(async () => nativeCredentials.list(options)),
    modify: async (providerId, callback, options) =>
      guardedOperation(async () => nativeCredentials.modify(providerId, callback, options)),
    delete: async (providerId, options) =>
      guardedOperation(async () => nativeCredentials.delete(providerId, options)),
  };
  return { credentials, assertHealthy };
}

function sessionPathWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function branchSession(
  pi: PiSdk,
  request: Extract<PiWorkerSessionRequest, { readonly mode: "branch" }>,
): Promise<PiSessionManager> {
  let directory: string;
  let sessionFile: string;
  let content: string;
  try {
    const [
      resolvedDirectory,
      resolvedDestination,
      resolvedFile,
      directoryInfo,
      fileInfo,
      fileContent,
    ] = await Promise.all([
      realpath(request.sourceDirectory),
      realpath(request.directory),
      realpath(request.sessionFile),
      lstat(request.directory),
      lstat(request.sessionFile),
      readFile(request.sessionFile, "utf8"),
    ]);
    directory = resolvedDirectory;
    sessionFile = resolvedFile;
    content = fileContent;
    if (
      resolvedDestination === directory ||
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !fileInfo.isFile() ||
      fileInfo.isSymbolicLink() ||
      !sessionPathWithin(directory, sessionFile)
    ) {
      throw new Error("invalid session file");
    }
  } catch {
    throw new PiSessionCheckpointError(
      "continuation_unavailable",
      "The retained Pi session file is missing or invalid.",
    );
  }

  let header: unknown;
  try {
    header = JSON.parse(content.split(/\r?\n/u, 1)[0] ?? "") as unknown;
  } catch {
    throw new PiSessionCheckpointError(
      "continuation_unavailable",
      "The retained Pi session file is missing or invalid.",
    );
  }
  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header) ||
    !("type" in header) ||
    header.type !== "session" ||
    !("id" in header) ||
    header.id !== request.expectedSessionId ||
    !("cwd" in header) ||
    header.cwd !== request.expectedCwd
  ) {
    throw new PiSessionCheckpointError(
      "continuation_route_changed",
      "The retained Pi session identity or working directory changed.",
    );
  }

  let manager: PiSessionManager;
  try {
    manager = pi.SessionManager.open(sessionFile, request.directory);
  } catch {
    throw new PiSessionCheckpointError(
      "continuation_unavailable",
      "The retained Pi session file could not be opened.",
    );
  }
  if (
    manager.getSessionId() !== request.expectedSessionId ||
    manager.getCwd() !== request.expectedCwd ||
    manager.getLeafId() !== request.terminalLeafId
  ) {
    throw new PiSessionCheckpointError(
      "continuation_route_changed",
      "The retained Pi session no longer matches its settled terminal checkpoint.",
    );
  }
  const previousFile = manager.getSessionFile();
  let branchedFile: string | undefined;
  try {
    branchedFile = manager.createBranchedSession(request.terminalLeafId);
  } catch {
    throw new PiSessionCheckpointError(
      "continuation_unavailable",
      "Pi could not create an independent branch of the retained session.",
    );
  }
  if (
    previousFile === undefined ||
    branchedFile === undefined ||
    branchedFile === previousFile ||
    manager.getSessionId() === request.expectedSessionId ||
    manager.getCwd() !== request.expectedCwd
  ) {
    throw new PiSessionCheckpointError(
      "continuation_unavailable",
      "Pi could not create an independent branch of the retained session.",
    );
  }
  return manager;
}

async function createSessionManager(pi: PiSdk, start: PiWorkerStart): Promise<PiSessionManager> {
  const request = start.session;
  if (request === undefined) {
    return pi.SessionManager.inMemory(start.workingDirectory);
  }
  if (request.mode === "create") {
    try {
      return pi.SessionManager.create(start.workingDirectory, request.directory);
    } catch {
      throw new PiSessionCheckpointError(
        "continuation_unavailable",
        "Pi could not create a persistent native session.",
      );
    }
  }
  return branchSession(pi, request);
}

function setExitCode(code: number): void {
  process.exitCode = code;
}

function observedIdentity(
  start: PiWorkerStart,
  sessionId?: string,
  sdkVerified = false,
): ObservedIdentity {
  return {
    provider: { value: start.model.provider, evidence: "inferred", source: "selected-pi-model" },
    model: { value: start.model.id, evidence: "inferred", source: "selected-pi-model" },
    harnessVersion: {
      ...(sdkVerified ? { value: PI_HARNESS_VERSION, source: "pi-sdk-version-export" } : {}),
      evidence: sdkVerified ? "verified" : "unverified",
    },
    nativeSessionId:
      sessionId === undefined
        ? { evidence: "unverified" }
        : {
            value: sessionId,
            evidence: "reported",
            source: start.session === undefined ? "pi-in-memory-session" : "pi-session-manager",
          },
  };
}

function identityFromMessage(identity: ObservedIdentity, message: unknown): ObservedIdentity {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return identity;
  }
  const source = message as Record<string, unknown>;
  return {
    ...identity,
    ...(typeof source.provider === "string"
      ? {
          provider: {
            value: source.provider,
            evidence: "reported",
            source: "pi-assistant-message",
          },
        }
      : {}),
    ...(typeof source.responseModel === "string"
      ? {
          model: {
            value: source.responseModel,
            evidence: "reported",
            source: "pi-assistant-message",
          },
        }
      : typeof source.model === "string"
        ? { model: { value: source.model, evidence: "reported", source: "pi-assistant-message" } }
        : {}),
  };
}

function outputText(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        return [];
      }
      const block = part as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("");
}

function usageFromMessages(messages: readonly unknown[]): undefined | Usage {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
  const present = new Set<keyof typeof totals>();
  for (const value of messages) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const message = value as Record<string, unknown>;
    if (
      message.role !== "assistant" ||
      typeof message.usage !== "object" ||
      message.usage === null
    ) {
      continue;
    }
    const usage = message.usage as Record<string, unknown>;
    for (const [sourceKey, targetKey] of [
      ["input", "inputTokens"],
      ["output", "outputTokens"],
      ["cacheRead", "cacheReadTokens"],
      ["cacheWrite", "cacheWriteTokens"],
    ] as const) {
      const amount = usage[sourceKey];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
        totals[targetKey] += amount;
        present.add(targetKey);
      }
    }
    if (typeof usage.cost === "object" && usage.cost !== null) {
      const cost = (usage.cost as Record<string, unknown>).total;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        totals.costUsd += cost;
        present.add("costUsd");
      }
    }
    totals.turns += 1;
  }
  if (totals.turns === 0) {
    return undefined;
  }
  present.add("turns");
  return {
    ...(present.has("inputTokens") ? { inputTokens: totals.inputTokens } : {}),
    ...(present.has("outputTokens") ? { outputTokens: totals.outputTokens } : {}),
    ...(present.has("cacheReadTokens") ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(present.has("cacheWriteTokens") ? { cacheWriteTokens: totals.cacheWriteTokens } : {}),
    ...(present.has("costUsd") ? { costUsd: totals.costUsd } : {}),
    turns: totals.turns,
    evidence: "reported",
    source: "pi-assistant-message-usage",
  };
}

function textEvent(text: string): AdapterEvent {
  return {
    category: "output",
    content: [{ type: "text", text }],
    data: { stream: "assistant" },
  };
}

function* textFrames(text: string): Generator<string> {
  let frame = "";
  let codePoints = 0;
  for (const character of text) {
    frame += character;
    codePoints += 1;
    // JSON escapes control characters up to six bytes each. This keeps the
    // serialized envelope below 48 KiB even for the worst valid string.
    if (codePoints === 7000) {
      yield frame;
      frame = "";
      codePoints = 0;
    }
  }
  if (frame !== "") {
    yield frame;
  }
}

function assertTextFrameSize(value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_PI_TEXT_FRAME_BYTES || bytes >= MAX_PI_WORKER_EVENT_BYTES) {
    throw new Error("Pi text frame exceeded its bounded transport limit.");
  }
}

function enqueueTextEvents(output: WorkerOutput, text: string): void {
  for (const frame of textFrames(text)) {
    const message: PiWorkerOutput = { type: "event", event: textEvent(frame) };
    assertTextFrameSize(message);
    void output.enqueue(message);
  }
}

function enqueueFinalContent(output: WorkerOutput, text: string): void {
  if (Buffer.byteLength(JSON.stringify(text), "utf8") - 2 > MAX_ASSISTANT_OUTPUT_BYTES) {
    throw new Error("Pi assistant output exceeded the 16 MiB result limit.");
  }
  const frames = textFrames(text)[Symbol.iterator]();
  let current = frames.next();
  let index = 0;
  while (!current.done) {
    const next = frames.next();
    const message: PiWorkerOutput = {
      type: "content",
      index,
      text: current.value,
      final: next.done === true,
    };
    assertTextFrameSize(message);
    void output.enqueue(message);
    index += 1;
    current = next;
  }
}

function toolEffect(toolName: string, args: unknown): undefined | WorkspaceEffect {
  if (toolName !== "write" && toolName !== "edit") {
    return undefined;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path.length > 0
    ? { path, kind: "modified", evidence: "harness-reported" }
    : undefined;
}

type WorkerOutputTransport = {
  readonly write: (line: string) => boolean;
  readonly waitForDrain: () => Promise<void>;
};

const PROCESS_OUTPUT_TRANSPORT: WorkerOutputTransport = {
  write: (line) => process.stdout.write(line),
  async waitForDrain() {
    await once(process.stdout, "drain");
  },
};

export class WorkerOutput {
  #queue: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  #failure: Error | undefined;
  #failureHandler: ((error: Error) => void) | undefined;
  readonly #transport: WorkerOutputTransport;

  constructor(transport: WorkerOutputTransport = PROCESS_OUTPUT_TRANSPORT) {
    this.#transport = transport;
  }

  setFailureHandler(handler: (error: Error) => void): void {
    this.#failureHandler = handler;
    if (this.#failure !== undefined) {
      handler(this.#failure);
    }
  }

  #fail(error: unknown): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error instanceof Error ? error : new Error(String(error));
    this.#failureHandler?.(this.#failure);
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Return the observed write promise itself so fire-and-forget callers inherit its rejection handler.
  enqueue(message: PiWorkerOutput): Promise<void> {
    if (this.#failure !== undefined) {
      const rejected = Promise.reject(this.#failure);
      void rejected.catch(() => {});
      return rejected;
    }
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_PI_WORKER_EVENT_BYTES || this.#pendingBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
      const error = new Error("Pi worker output exceeded its bounded transport limit.");
      this.#fail(error);
      const rejected = Promise.reject(error);
      void rejected.catch(() => {});
      return rejected;
    }
    this.#pendingBytes += bytes;
    const write = this.#queue
      .then(async () => {
        if (this.#failure !== undefined) {
          throw this.#failure;
        }
        if (!this.#transport.write(line)) {
          await this.#transport.waitForDrain();
        }
      })
      .finally(() => {
        this.#pendingBytes -= bytes;
      });
    this.#queue = write.catch((error: unknown) => {
      this.#fail(error);
    });
    void write.catch(() => {});
    return write;
  }

  async drain(): Promise<void> {
    await this.#queue;
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }
}

function runnerResult(value: unknown): RunnerResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pi tool runner emitted an invalid result.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.type !== "result" ||
    (record.exitCode !== null &&
      (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode))) ||
    (record.signal !== null && typeof record.signal !== "string") ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new Error("Pi tool runner emitted an invalid result.");
  }
  return {
    type: "result",
    exitCode: record.exitCode,
    signal: record.signal,
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

async function runnerResultLine(stream: NodeJS.ReadableStream): Promise<RunnerResult> {
  return (async () => {
    const lines = readBoundedLines(stream as AsyncIterable<Buffer>, 4096);
    const result = await lines.next();
    if (result.done) {
      throw new Error("Pi tool runner exited without a shell result.");
    }
    return runnerResult(JSON.parse(result.value) as unknown);
  })();
}

function ackKey(type: PendingAckType, requestId: string): string {
  return `${type}:${requestId}`;
}

type PendingAckType =
  | "tool_process_cleaned"
  | "tool_process_cleanup_done"
  | "tool_process_registered";

function registerAck(
  pending: Map<string, PendingAck>,
  type: PendingAckType,
  requestId: string,
  processGroupId: number,
): Deferred {
  const waiter = deferred();
  pending.set(ackKey(type, requestId), { processGroupId, deferred: waiter });
  return waiter;
}

async function runSupervisedBash(
  command: string,
  cwd: string,
  options: {
    readonly onData: (data: Buffer) => void;
    readonly signal?: AbortSignal;
    readonly timeout?: number;
    readonly env?: NodeJS.ProcessEnv;
  },
  output: WorkerOutput,
  pending: Map<string, PendingAck>,
): Promise<{ readonly exitCode: null | number }> {
  if (process.platform === "win32") {
    throw new Error("Pi supervised bash is unavailable on Windows in this release.");
  }
  const timeout = options.timeout;
  if (
    timeout !== undefined &&
    (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TOOL_TIMEOUT_MS)
  ) {
    throw new Error("Invalid timeout: Pi bash requires a finite timeout up to 2147483 seconds.");
  }
  if (options.signal?.aborted) {
    throw new Error("aborted");
  }

  const pi = await import("@earendil-works/pi-coding-agent");
  const shellConfig = pi.getShellConfig();
  const requestId = randomUUID();
  const runnerPath = join(import.meta.dirname, "pi-tool-runner.js");
  const runner = spawn(process.execPath, [runnerPath], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (
    runner.pid === undefined ||
    runner.stdin === null ||
    runner.stdout === null ||
    runner.stderr === null
  ) {
    throw new Error("Could not start Pi's supervised shell runner.");
  }
  const processGroupId = runner.pid;
  const resultStream = runner.stdio[3];
  if (resultStream === null || resultStream === undefined || !("read" in resultStream)) {
    terminateGroup(processGroupId);
    throw new Error("Pi shell runner result channel did not start.");
  }
  const start: PiToolRunnerStart = {
    type: "start",
    requestId,
    shell: shellConfig.shell,
    shellArgs: shellConfig.args,
    commandTransport: shellConfig.commandTransport ?? "argv",
    command,
    cwd,
    env: Object.fromEntries(
      Object.entries(options.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
  const startLine = `${JSON.stringify(start)}\n`;
  if (Buffer.byteLength(startLine, "utf8") > MAX_PI_WORKER_MESSAGE_BYTES) {
    terminateGroup(processGroupId);
    throw new Error("Pi bash execution configuration exceeded its limit.");
  }

  let capturedOutputBytes = 0;
  let outputLimitExceeded = false;
  const capture = (chunk: Buffer): void => {
    const remaining = MAX_TOOL_OUTPUT_BYTES - capturedOutputBytes;
    if (remaining > 0) {
      const accepted = chunk.subarray(0, remaining);
      options.onData(accepted);
      capturedOutputBytes += accepted.byteLength;
    }
    if (chunk.byteLength > remaining) {
      outputLimitExceeded = true;
    }
  };
  // Shell stdout and stderr inherit the helper's pipes, so the worker drains
  // both continuously and passes each bounded chunk to Pi's own accumulator.
  runner.stdout.on("data", capture);
  runner.stderr.on("data", capture);
  runner.stdout.on("error", () => {});
  runner.stderr.on("error", () => {});
  runner.stdin.on("error", () => {});
  let closeError: Error | undefined;
  runner.once("error", (error) => {
    closeError = error;
  });
  const closePromise = once(runner, "close").then(() => {});
  const resultPromise = runnerResultLine(resultStream as NodeJS.ReadableStream);
  void closePromise.catch(() => {});
  void resultPromise.catch(() => {});
  const registered = registerAck(pending, "tool_process_registered", requestId, processGroupId);
  runner.stdin.write(startLine);

  let cause: "cancelled" | "completed" | "timed_out" = "completed";
  let aborted = false;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    aborted = true;
    cause = "cancelled";
    terminateGroup(processGroupId);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
  }

  try {
    await output.enqueue({ type: "tool_process_started", requestId, processGroupId });
    await registered.promise;
    if (!aborted && !options.signal?.aborted) {
      runner.stdin.write('{"type":"registered"}\n');
      if (timeout !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          cause = "timed_out";
          terminateGroup(processGroupId);
        }, timeout * 1000);
      }
    }

    let result: RunnerResult;
    try {
      result = await resultPromise;
    } catch (error) {
      result = {
        type: "result",
        exitCode: null,
        signal: runner.signalCode,
        ...(closeError === undefined ? {} : { error: closeError.message }),
      };
      if (
        error instanceof Error &&
        error.message !== "Pi tool runner exited without a shell result."
      ) {
        result = { ...result, error: closeError?.message ?? error.message };
      }
    }
    const cleaned = registerAck(pending, "tool_process_cleaned", requestId, processGroupId);
    await output.enqueue({
      type: "tool_process_finished",
      requestId,
      processGroupId,
      exitCode: result.exitCode,
      signal: result.signal,
      cause,
    });
    await cleaned.promise;
    await closePromise;
    if (closeError !== undefined && result.error === undefined) {
      result = { ...result, exitCode: null, error: closeError.message };
    }
    const cleanupDone = registerAck(
      pending,
      "tool_process_cleanup_done",
      requestId,
      processGroupId,
    );
    await output.enqueue({ type: "tool_process_reaped", requestId, processGroupId });
    await cleanupDone.promise;

    if (outputLimitExceeded) {
      options.onData(
        Buffer.from("\n[Relay stopped collecting this command after 16 MiB of combined output.]"),
      );
      return { exitCode: 1 };
    }
    if (aborted || options.signal?.aborted) {
      throw new Error("aborted");
    }
    if (timedOut) {
      throw new Error(`timeout:${timeout}`);
    }
    if (result.error !== undefined && result.exitCode === null) {
      options.onData(Buffer.from(result.error));
    }
    return { exitCode: result.exitCode };
  } catch (error) {
    if (runner.exitCode === null && runner.signalCode === null) {
      terminateGroup(processGroupId);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    for (const type of [
      "tool_process_registered",
      "tool_process_cleaned",
      "tool_process_cleanup_done",
    ] as const) {
      pending.delete(ackKey(type, requestId));
    }
  }
}

function terminateGroup(processGroupId: number): void {
  if (
    process.platform === "win32" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1
  ) {
    return;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // The host also owns this recorded process group and repeats cleanup.
  }
}

async function writeTerminal(
  output: WorkerOutput,
  start: PiWorkerStart | undefined,
  status: "failed" | "succeeded",
  failure?: { readonly code: string; readonly message: string },
  details?: {
    readonly identity?: ObservedIdentity;
    readonly usage?: Usage;
    readonly stopReason?: string;
  },
): Promise<void> {
  const identity =
    details?.identity ??
    (start === undefined
      ? {
          provider: { evidence: "unverified" as const },
          model: { evidence: "unverified" as const },
          harnessVersion: {
            evidence: "unverified" as const,
          },
          nativeSessionId: { evidence: "unverified" as const },
        }
      : observedIdentity(start));
  return output.enqueue({
    type: "terminal",
    settled: true,
    status,
    ...(details?.stopReason === undefined ? {} : { stopReason: details.stopReason }),
    ...(failure === undefined ? {} : { failure }),
    observedIdentity: identity,
    ...(details?.usage === undefined ? {} : { usage: details.usage }),
  });
}

async function runPiWorker(): Promise<void> {
  const output = new WorkerOutput();
  const input = readBoundedLines(process.stdin, MAX_PI_WORKER_MESSAGE_BYTES);
  const pending = new Map<string, PendingAck>();
  let start: PiWorkerStart | undefined;
  let session: Pick<PiAgentSession, "abort" | "isStreaming" | "steer"> | undefined;
  let settled = false;
  let cancellationRequested = false;
  let controlClosed = false;
  let terminalWritten = false;
  let settlingSent = false;
  let eventFailure: Error | undefined;
  let sdkVerified = false;
  let assertAuthHealthy: (() => void) | undefined;
  let streamedAssistantBytes = 0;
  let identity: ObservedIdentity | undefined;
  let steeringPendingBytes = 0;
  let finishRequested = false;
  let controlTaskStarted = false;
  let steeringReady = false;
  let steeringChain = Promise.resolve();
  const steeringInputs = new Map<string, number>();
  const steeringReadyGate = deferred();
  const finishGate = deferred();
  void steeringReadyGate.promise.catch(() => {});
  void finishGate.promise.catch(() => {});
  let resolveSettled: (() => void) | undefined;
  const settledPromise = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  const acknowledgeSteering = async (
    inputId: string,
    accepted: boolean,
    message?: string,
  ): Promise<void> => {
    await output.enqueue({
      type: "steer_ack",
      inputId,
      accepted,
      ...(message === undefined ? {} : { message: message.slice(0, 256) }),
    });
  };
  const waitForHostFinish = async (): Promise<void> => {
    if (!settlingSent) {
      settlingSent = true;
      await output.enqueue({ type: "settling" });
    }
    if (controlTaskStarted && !controlClosed) {
      await finishGate.promise;
      await steeringChain;
    }
  };
  const assistantMessages: unknown[] = [];
  const toolArguments = new Map<string, { readonly name: string; readonly args: unknown }>();

  const rejectPending = (error: Error): void => {
    for (const ack of pending.values()) {
      ack.deferred.reject(error);
    }
    pending.clear();
  };
  const abortSession = (): void => {
    cancellationRequested = true;
    if (!steeringReady) {
      steeringReadyGate.reject(
        new Error("Pi stopped before its native steering boundary was ready."),
      );
    }
    void session?.abort().catch(() => {});
  };
  output.setFailureHandler((error) => {
    eventFailure = error;
    abortSession();
  });
  const enqueueEvent = (event: AdapterEvent): void => {
    void output.enqueue({ type: "event", event });
  };
  const enqueueAssistantText = (text: string): void => {
    const textBytes = Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
    if (streamedAssistantBytes + textBytes > MAX_ASSISTANT_OUTPUT_BYTES) {
      eventFailure = new Error("Pi assistant output exceeded the 16 MiB stream limit.");
      abortSession();
      return;
    }
    streamedAssistantBytes += textBytes;
    try {
      enqueueTextEvents(output, text);
    } catch (error) {
      eventFailure = error instanceof Error ? error : new Error(String(error));
      abortSession();
    }
  };
  const enqueueAssistantContent = (text: string): void => {
    try {
      enqueueFinalContent(output, text);
    } catch (error) {
      eventFailure = error instanceof Error ? error : new Error(String(error));
      abortSession();
    }
  };

  try {
    const first = await input.next();
    if (first.done) {
      throw new Error("Pi worker did not receive a start message.");
    }
    const workerStart = parsePiWorkerStart(JSON.parse(first.value) as unknown);
    start = workerStart;
    const controlTask = (async () => {
      for await (const line of input) {
        const control: PiWorkerControl = parsePiWorkerControl(JSON.parse(line) as unknown);
        if (control.type === "cancel") {
          abortSession();
          continue;
        }
        if (control.type === "finish") {
          if (finishRequested) {
            throw new Error("Pi worker received a duplicate finish control.");
          }
          finishRequested = true;
          void steeringChain.then(finishGate.resolve, finishGate.reject);
          continue;
        }
        if (control.type === "steer") {
          const bytes = Buffer.byteLength(control.text, "utf8");
          if (
            finishRequested ||
            steeringInputs.has(control.inputId) ||
            steeringInputs.size >= MAX_PI_PENDING_STEERING_INPUTS ||
            steeringPendingBytes + bytes > MAX_PI_PENDING_STEERING_BYTES ||
            bytes > MAX_PI_STEERING_INPUT_BYTES
          ) {
            throw new Error("Pi worker received an invalid or over-capacity steering control.");
          }
          const wasActive = !settled && !cancellationRequested && !controlClosed;
          steeringInputs.set(control.inputId, bytes);
          steeringPendingBytes += bytes;
          const next = steeringChain.then(async () => {
            let accepted = false;
            let message: string | undefined;
            try {
              await steeringReadyGate.promise;
              if (!wasActive || cancellationRequested || controlClosed) {
                throw new Error("Pi was no longer running when the input reached the SDK.");
              }
              if (!session?.isStreaming) {
                throw new Error("Pi had no active turn for native steering.");
              }
              await session.steer(control.text);
              accepted = true;
            } catch (error) {
              message = error instanceof Error ? error.message : String(error);
            } finally {
              steeringInputs.delete(control.inputId);
              steeringPendingBytes -= bytes;
            }
            await acknowledgeSteering(control.inputId, accepted, message);
          });
          steeringChain = next;
          continue;
        }
        if (control.type === "start") {
          throw new Error("Pi worker received a second start message.");
        }
        const key = ackKey(control.type, control.requestId);
        const ack = pending.get(key);
        if (ack?.processGroupId !== control.processGroupId) {
          throw new Error("Pi worker received an unexpected process lifecycle ACK.");
        }
        pending.delete(key);
        ack.deferred.resolve();
      }
      controlClosed = true;
      rejectPending(new Error("Pi worker control channel closed."));
      if (!finishRequested) {
        const failure = new Error("Pi worker control channel closed before the finish handshake.");
        eventFailure = failure;
        finishGate.reject(failure);
      }
      if (!settled) {
        abortSession();
      }
    })();
    controlTaskStarted = true;
    void controlTask.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      eventFailure = failure;
      controlClosed = true;
      rejectPending(failure);
      finishGate.reject(failure);
      abortSession();
    });

    await assertPiRuntimeConfigurationSafe(workerStart.modelFiles);
    if (process.platform === "win32") {
      throw new Error(
        "Pi worker is unavailable on Windows because supervised process groups are required.",
      );
    }
    if (!supportsPiNodeVersion(process.versions.node)) {
      throw new Error("Pi worker requires Node.js 22.19.0 or later.");
    }
    const pi = await import("@earendil-works/pi-coding-agent");
    if (pi.VERSION !== PI_HARNESS_VERSION) {
      throw new Error(
        `Pi SDK version ${pi.VERSION} does not match the pinned ${PI_HARNESS_VERSION} runtime.`,
      );
    }
    sdkVerified = true;
    const agentDir = dirname(workerStart.modelFiles.authPath);
    const settingsManager = pi.SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      defaultTools: [...workerStart.tools],
    });
    const guardedAuth = await createGuardedPiCredentials(workerStart.modelFiles.authPath);
    assertAuthHealthy = guardedAuth.assertHealthy;
    const modelRuntime = await pi.ModelRuntime.create({
      credentials: guardedAuth.credentials,
      modelsPath: workerStart.modelFiles.modelsPath,
      modelsStorePath: workerStart.modelFiles.modelsStorePath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    guardedAuth.assertHealthy();
    assertPiModelRuntimeConfigurationSafe(modelRuntime);
    const model = modelRuntime.getModel(workerStart.model.provider, workerStart.model.id);
    if (model === undefined) {
      throw new Error(
        `Pi has no configured model ${workerStart.model.provider}/${workerStart.model.id}.`,
      );
    }
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: workerStart.workingDirectory,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // Empty explicit inputs prevent Pi's default loader from discovering
      // project/global SYSTEM.md and APPEND_SYSTEM.md overrides. Pi still
      // contributes its normal built-in coding-agent system prompt.
      systemPrompt: "",
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    const shellOperations = {
      exec: async (
        command: string,
        cwd: string,
        options: {
          readonly onData: (data: Buffer) => void;
          readonly signal?: AbortSignal;
          readonly timeout?: number;
          readonly env?: NodeJS.ProcessEnv;
        },
      ) => runSupervisedBash(command, cwd, options, output, pending),
    };
    const customBash = pi.createBashToolDefinition(workerStart.workingDirectory, {
      operations: shellOperations,
      exposeSessionEnvironment: false,
    });
    const customTools = [customBash] as unknown as NonNullable<
      NonNullable<Parameters<typeof pi.createAgentSession>[0]>["customTools"]
    >;
    const created = await pi.createAgentSession({
      cwd: workerStart.workingDirectory,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: workerStart.model.thinkingLevel,
      resourceLoader,
      settingsManager,
      sessionManager: await createSessionManager(pi, workerStart),
      tools: [...workerStart.tools],
      customTools,
    });
    session = created.session;
    identity = observedIdentity(workerStart, created.session.sessionManager.getSessionId(), true);
    void output.enqueue({ type: "identity", identity });
    if (cancellationRequested || controlClosed) {
      await created.session.abort();
      throw new Error("aborted");
    }

    created.session.subscribe((event) => {
      if (event.type === "agent_start") {
        steeringReady = true;
        steeringReadyGate.resolve();
        return;
      }
      if (event.type === "agent_settled") {
        settled = true;
        if (!steeringReady) {
          steeringReadyGate.reject(
            new Error("Pi settled before its native steering boundary became ready."),
          );
        }
        resolveSettled?.();
        return;
      }
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          enqueueAssistantText(delta.delta);
        } else if (delta.type === "thinking_delta") {
          enqueueEvent({
            category: "activity",
            data: { phase: "thinking_delta", length: delta.delta.length },
          });
        } else if (delta.type === "error") {
          enqueueEvent({
            category: "diagnostic",
            failure: { code: delta.reason, message: delta.error.errorMessage ?? delta.reason },
            data: { phase: "provider_error" },
          });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        toolArguments.set(event.toolCallId, { name: event.toolName, args: event.args });
        enqueueEvent({
          category: "activity",
          data: { phase: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName },
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const previous = toolArguments.get(event.toolCallId);
        toolArguments.delete(event.toolCallId);
        const effect =
          previous === undefined ? undefined : toolEffect(previous.name, previous.args);
        enqueueEvent({
          category: event.isError ? "diagnostic" : "activity",
          ...(effect === undefined || event.isError ? {} : { effects: [effect] }),
          data: {
            phase: event.isError ? "tool_failed" : "tool_finished",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        });
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantMessages.push(event.message);
        identity = identityFromMessage(identity ?? observedIdentity(workerStart), event.message);
        void output.enqueue({ type: "identity", identity });
        const finalText = outputText(event.message);
        if (event.message.stopReason === "stop" && finalText !== "") {
          enqueueAssistantContent(finalText);
        }
        if (event.message.stopReason === "error") {
          enqueueEvent({
            category: "diagnostic",
            failure: {
              code: "provider_error",
              message: event.message.errorMessage ?? "Pi provider request failed.",
            },
            data: { phase: "provider_error" },
          });
        }
        return;
      }
      if (event.type === "agent_end" && event.willRetry) {
        eventFailure = new Error("Pi reported that the session planned an automatic retry.");
        abortSession();
        return;
      }
      if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
        eventFailure = new Error("Pi automatic retries are disabled for Relay workers.");
        abortSession();
      }
    });
    await output.enqueue({
      type: "event",
      event: {
        category: "activity",
        data: { phase: "session_started", protocolVersion: PI_WORKER_PROTOCOL_VERSION },
      },
    });
    const promptRun = created.session.prompt(workerStart.prompt, { expandPromptTemplates: false });
    await promptRun;
    await settledPromise;
    await steeringChain;
    await output.drain();
    guardedAuth.assertHealthy();
    if (eventFailure !== undefined) {
      throw eventFailure;
    }
    const lastAssistant = assistantMessages.at(-1) as
      | { readonly stopReason?: string; readonly errorMessage?: string }
      | undefined;
    if (!settled) {
      throw new Error("Pi prompt returned without an agent_settled event.");
    }
    if (lastAssistant?.stopReason !== "stop") {
      throw new Error(
        lastAssistant?.errorMessage ??
          `Pi session settled with ${lastAssistant?.stopReason ?? "no assistant completion"}.`,
      );
    }
    if (workerStart.session !== undefined) {
      const manager = created.session.sessionManager;
      const sessionFile = manager.getSessionFile();
      const terminalLeafId = manager.getLeafId();
      if (sessionFile === undefined || terminalLeafId === null) {
        throw new PiSessionCheckpointError(
          "continuation_unavailable",
          "Pi did not settle a persistent session checkpoint.",
        );
      }
      try {
        const fileInfo = await lstat(sessionFile);
        if (
          !fileInfo.isFile() ||
          fileInfo.isSymbolicLink() ||
          (await readFile(sessionFile)).length === 0
        ) {
          throw new Error("empty session checkpoint");
        }
      } catch {
        throw new PiSessionCheckpointError(
          "continuation_unavailable",
          "Pi did not settle a persistent session checkpoint.",
        );
      }
      const checkpoint: PiWorkerSessionSnapshot = {
        sessionFile,
        sessionId: manager.getSessionId(),
        cwd: manager.getCwd(),
        terminalLeafId,
      };
      await output.enqueue({ type: "session", session: checkpoint });
    }
    await waitForHostFinish();
    await output.drain();
    terminalWritten = true;
    const usage = usageFromMessages(assistantMessages);
    await writeTerminal(output, workerStart, "succeeded", undefined, {
      identity,
      ...(usage === undefined ? {} : { usage }),
      stopReason: lastAssistant.stopReason,
    });
  } catch (error) {
    if (!steeringReady) {
      steeringReadyGate.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (!terminalWritten) {
      let failure = error;
      try {
        assertAuthHealthy?.();
      } catch (error) {
        failure = error;
      }
      try {
        try {
          await waitForHostFinish();
        } catch (error) {
          failure = eventFailure ?? error;
        }
        try {
          await steeringChain;
        } catch (error) {
          failure = eventFailure ?? error;
        }
        await output.drain();
        const message = failure instanceof Error ? failure.message : String(failure);
        const lastMessage = assistantMessages.at(-1);
        const usage = usageFromMessages(assistantMessages);
        await writeTerminal(
          output,
          start,
          "failed",
          { code: failureCode(failure), message },
          {
            ...(identity !== undefined
              ? { identity }
              : sdkVerified && start !== undefined
                ? { identity: observedIdentity(start, undefined, true) }
                : {}),
            ...(usage === undefined ? {} : { usage }),
            ...(typeof lastMessage === "object" &&
            lastMessage !== null &&
            "stopReason" in lastMessage
              ? { stopReason: String(lastMessage.stopReason) }
              : {}),
          },
        );
      } catch {
        setExitCode(70);
      }
    }
    if (session !== undefined && !settled) {
      await session.abort().catch(() => {});
    }
  } finally {
    rejectPending(new Error("Pi worker finished."));
    process.stdin.destroy();
  }
}

if (process.argv[1] !== undefined && process.argv[1] === import.meta.filename) {
  await runPiWorker();
}
