import { type ChildProcess, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

import type { AdapterConnectionContext } from "../connections.js";
import type {
  ObservedIdentity,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
} from "../contract.js";
import type { DiscoveryProbe } from "./discovery.js";
import type {
  Adapter,
  AdapterConnectionRunContext,
  AdapterEvent,
  AdapterRunContext,
  AdapterRunResult,
  PolicyResolution,
} from "./types.js";

import { BridgeError, type BridgeErrorCode } from "../errors.js";
import {
  childEnvironment,
  inspectNativeContextDirectory,
  redactNativeContextData,
  redactNativeContextText,
} from "./environment.js";
import { readBoundedLines } from "./pi-protocol.js";
import { promptFor } from "./process.js";

const execFileAsync = promisify(execFile);
const QUALIFIED_VERSION = "1.0.44";
const QUALIFIED_VERSION_RANGE = "=1.0.44";
const ACP_PROTOCOL_VERSION = 1;
const MAX_ACP_LINE_BYTES = 1024 * 1024;
const MAX_ACP_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ACP_QUEUED_NOTIFICATION_BYTES = 2 * 1024 * 1024;
const MAX_ACP_QUEUED_NOTIFICATIONS = 128;
const TERMINATION_GRACE_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const GROK_MODELS = [
  { model: "grok-4.7", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "grok-4.7-build-fast", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "grok-4.5", efforts: ["low", "medium", "high"] },
].map((model) => ({
  ...model,
  canonicalModel: model.model,
  capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
  interactionStrategies: ["deny", "unattended"] as const,
}));

const MANIFEST = {
  id: "grok",
  provider: "xai",
  via: "grok-build",
  command: "grok",
  versionArgs: ["--no-auto-update", "--version"],
  authArgs: [],
  qualifiedVersionRange: QUALIFIED_VERSION_RANGE,
  authenticationMode: "grok-native-acp",
  models: GROK_MODELS,
} as const;

type RecordValue = Record<string, unknown>;
type RpcId = number | string;
type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForWritableDrain(
  child: ChildProcess,
  stream: { readonly destroyed: boolean; readonly writableEnded: boolean } & NodeJS.WritableStream,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly hasExited?: () => boolean;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      child.removeListener("close", onProcessClose);
      options.signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onDrain = (): void => {
      settle();
    };
    const onClose = (): void => {
      settle(nativeFailure("Grok ACP closed stdin while a request was backpressured."));
    };
    const onProcessClose = (): void => {
      settle(nativeFailure("Grok ACP process exited while a request was backpressured."));
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const onAbort = (): void => {
      settle(abortError());
    };

    if (stream.destroyed || stream.writableEnded) {
      settle(nativeFailure("Grok ACP stdin closed while a request was backpressured."));
      return;
    }
    if (options.hasExited?.() || child.exitCode !== null || child.signalCode !== null) {
      settle(nativeFailure("Grok ACP process exited while a request was backpressured."));
      return;
    }
    if (options.signal?.aborted) {
      settle(abortError());
      return;
    }
    stream.once("drain", onDrain);
    stream.once("close", onClose);
    stream.once("error", onError);
    child.once("close", onProcessClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(nativeFailure("Grok ACP stdin remained backpressured until the request timeout."));
      }, options.timeoutMs);
    }
  });
}

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function nativeFailure(message: string, code: BridgeErrorCode = "harness_failed"): BridgeError {
  return new BridgeError({ code, message, retryable: false });
}

function abortError(): Error {
  const error = new Error("The Grok ACP invocation was aborted.");
  error.name = "AbortError";
  return error;
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    // The group may exit between the liveness check and signal delivery.
  }
}

async function waitForProcessGroupExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) {
    await delay(25);
  }
  return !processGroupExists(child);
}

async function terminateProcessGroup(
  child: ChildProcess,
  exitPromise: Promise<void>,
  graceMs: number,
): Promise<void> {
  if (child.pid === undefined) {
    await exitPromise;
    return;
  }
  signalProcessGroup(child, "SIGINT");
  if (!(await waitForProcessGroupExit(child, graceMs))) {
    signalProcessGroup(child, "SIGKILL");
  }
  await Promise.race([exitPromise, delay(graceMs)]);
  if (!(await waitForProcessGroupExit(child, graceMs))) {
    throw nativeFailure("Grok ACP process group did not exit after forced termination.");
  }
}

async function findExecutable(command: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("which", [command], { timeout: 2500 });
    const first = result.stdout.trim().split("\n").at(0);
    return first === undefined || first === "" ? undefined : first;
  } catch {
    return undefined;
  }
}

async function readVersion(
  executable: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: 2500,
      ...(environment === undefined ? {} : { env: environment }),
    });
    return `${result.stdout}\n${result.stderr}`.trim() || undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      return typeof stdout === "string" ? stdout.trim() || undefined : undefined;
    }
    return undefined;
  }
}

function versionFrom(output: string | undefined): string | undefined {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output ?? "");
  return match?.[1];
}

function routeDescriptors(
  readiness: RouteDescriptor["readiness"],
  executable: string | undefined,
  version: string,
  diagnostics: readonly string[],
): readonly RouteDescriptor[] {
  return GROK_MODELS.map((model) => ({
    routeId: `${MANIFEST.id}:${model.model}`,
    ...(executable === undefined ? {} : { executable }),
    provider: MANIFEST.provider,
    model: model.model,
    canonicalModel: model.canonicalModel,
    efforts: model.efforts,
    via: MANIFEST.via,
    adapter: MANIFEST.id,
    harnessVersion: version,
    authenticationMode: MANIFEST.authenticationMode,
    capabilities: model.capabilities,
    interactionStrategies: model.interactionStrategies,
    assurance: "none",
    runtimeIdentityEvidence: "unverified",
    readiness,
    qualification: [],
    diagnostics: [...diagnostics],
  }));
}

async function namedConfigProblem(nativeHome: string): Promise<string | undefined> {
  let source: string;
  try {
    source = await readFile(join(nativeHome, "config.toml"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    return "The selected Grok config.toml cannot be inspected safely. Check its permissions and retry.";
  }

  let config: RecordValue;
  try {
    config = parseToml(source);
  } catch {
    return "The selected Grok config.toml is not valid TOML. Fix the file or use a native context without it.";
  }

  const auth = record(config.auth);
  if (auth !== undefined && Object.hasOwn(auth, "auth_provider_command")) {
    return "Named Grok connections do not support external auth_provider_command configuration. Use Grok's native account login in the selected context.";
  }
  const modelTables = record(config.model);
  if (modelTables !== undefined) {
    for (const modelConfig of Object.values(modelTables)) {
      const model = record(modelConfig);
      if (
        model !== undefined &&
        ["api_key", "extra_headers"].some((key) => Object.hasOwn(model, key))
      ) {
        return "Named Grok connections do not support per-model API credentials or custom headers. Use Grok's native account login in the selected context.";
      }
      if (
        typeof model?.base_url === "string" &&
        !/^https:\/\/(?:api\.)?x\.ai(?:\/|$)/i.test(model.base_url)
      ) {
        return "Named Grok connections do not support custom model endpoints. Remove the endpoint override and use a native xAI model.";
      }
    }
  }
  return undefined;
}

const NAMED_AUTH_ENVIRONMENT_NAMES = new Set([
  "GROK_HOME",
  "XAI_API_KEY",
  "GROK_AUTH_EXPIRED",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
]);

function sensitiveEnvironmentName(name: string): boolean {
  return (
    name.startsWith("GROK_") ||
    NAMED_AUTH_ENVIRONMENT_NAMES.has(name) ||
    /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|TOKEN)$/i.test(name)
  );
}

function environmentForNamedContext(nativeHome: string): {
  readonly environment: NodeJS.ProcessEnv;
  readonly denied: readonly string[];
} {
  const environment = childEnvironment({ GROK_HOME: nativeHome });
  const denied = Object.keys(environment).filter(
    (name) => name !== "GROK_HOME" && sensitiveEnvironmentName(name),
  );
  const filteredEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !denied.includes(name)),
  );
  return {
    environment: { ...filteredEnvironment, GROK_HOME: nativeHome },
    denied: denied.toSorted(),
  };
}

function policyFor(request: StartInvocationRequest): PolicyResolution {
  const unsupported: string[] = [];
  if (request.interactionStrategy === "orchestrator") {
    unsupported.push("interactionStrategy=orchestrator");
  }
  if (
    request.requestedPolicy.filesystem !== undefined &&
    request.requestedPolicy.filesystem !== "inherit"
  ) {
    unsupported.push("requestedPolicy.filesystem");
  }
  if (request.requestedPolicy.commands === "deny") {
    unsupported.push("requestedPolicy.commands=deny");
  }
  if (
    request.requestedPolicy.network !== undefined &&
    request.requestedPolicy.network !== "inherit"
  ) {
    unsupported.push("requestedPolicy.network");
  }
  if ((request.requestedPolicy.additionalDirectories?.length ?? 0) > 0) {
    unsupported.push("requestedPolicy.additionalDirectories");
  }
  if (request.requestedPolicy.minimumAssurance !== "none") {
    unsupported.push("requestedPolicy.minimumAssurance");
  }
  return {
    supported: unsupported.length === 0,
    unsupported,
    effectiveNativePolicy: {
      adapter: "grok",
      controls: [
        ...(request.interactionStrategy === "deny"
          ? [{ flag: "--permission-mode", value: "dontAsk" }]
          : []),
        ...(request.interactionStrategy === "unattended" ? [{ flag: "--always-approve" }] : []),
      ],
    },
  };
}

function commandArgs(context: AdapterRunContext): readonly string[] {
  const args = ["--no-auto-update", "--model", context.route.nativeModel ?? context.route.model];
  if (context.route.effort !== undefined) {
    args.push("--effort", context.route.effort);
  }
  if (context.request.interactionStrategy === "deny") {
    args.push("--permission-mode", "dontAsk");
  } else if (context.request.interactionStrategy === "unattended") {
    args.push("--always-approve");
  }
  args.push("--no-subagents", "agent", "--no-leader", "stdio");
  return args;
}

function textPrompt(context: AdapterRunContext): string {
  for (const part of context.request.input) {
    if (part.type !== "text" && part.type !== "json") {
      throw new BridgeError({
        code: "unsupported_capability",
        message: `Grok ACP does not accept ${part.type} prompt content in this adapter qualification.`,
        retryable: false,
      });
    }
  }
  return promptFor(context);
}

function observedIdentity(harnessVersion: string): ObservedIdentity {
  return {
    provider: { value: "xai", evidence: "inferred", source: "adapter" },
    model: { evidence: "unverified" },
    harnessVersion: { value: harnessVersion, evidence: "reported", source: "version-probe" },
    nativeSessionId: { evidence: "unverified" },
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function authFailure(error: RecordValue): boolean {
  const message = typeof error.message === "string" ? error.message : "";
  return /auth_required|unauthori[sz]ed|sign.?in|log.?in/i.test(message);
}

export class GrokAdapter implements Adapter {
  readonly id = "grok";
  readonly #executable: string | undefined;
  readonly #probe: DiscoveryProbe | undefined;

  constructor(options?: { readonly executable?: string; readonly probe?: DiscoveryProbe }) {
    this.#executable = options?.executable ?? process.env.HARNESS_RELAY_GROK_PATH;
    this.#probe = options?.probe;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return this.#discover();
  }

  async discoverConnection(
    connection: AdapterConnectionContext,
  ): Promise<readonly RouteDescriptor[]> {
    if (connection.harness !== this.id) {
      return routeDescriptors("unavailable", undefined, "unknown", [
        "This named context is not registered for the Grok adapter.",
      ]);
    }
    const native = await inspectNativeContextDirectory(connection.nativeContextRef);
    if (native === undefined) {
      return routeDescriptors("unavailable", undefined, "unknown", [
        "Named Grok connections require an existing readable GROK_HOME directory.",
      ]);
    }
    const configProblem = await namedConfigProblem(native.path);
    if (configProblem !== undefined) {
      return routeDescriptors("unavailable", undefined, "unknown", [configProblem]);
    }
    return this.#discover(native.path, QUALIFIED_VERSION);
  }

  async runConnection(context: AdapterConnectionRunContext): Promise<AdapterRunResult> {
    if (context.connection.harness !== this.id) {
      throw new BridgeError({
        code: "route_unavailable",
        message: "The selected named connection is not a Grok context.",
        retryable: false,
      });
    }
    const native = await inspectNativeContextDirectory(context.connection.nativeContextRef);
    if (native === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: "The selected Grok connection no longer refers to a readable GROK_HOME directory.",
        retryable: false,
        details: { connectionId: context.connection.id },
      });
    }
    const configProblem = await namedConfigProblem(native.path);
    if (configProblem !== undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: configProblem,
        retryable: false,
        details: { connectionId: context.connection.id },
      });
    }
    const references = [
      ...native.privatePaths,
      ...(context.connection.executable === undefined ? [] : [context.connection.executable]),
    ];
    const boundContext: AdapterRunContext = {
      ...context,
      connection: { ...context.connection, nativeContextRef: native.path },
      route: {
        ...context.route,
        ...(context.connection.executable === undefined
          ? {}
          : { executable: context.connection.executable }),
      },
      emit: async (event) => context.emit(redactNativeContextData(event, references)),
      ...(context.reportPartial === undefined
        ? {}
        : {
            reportPartial: (partial) =>
              context.reportPartial?.(redactNativeContextData(partial, references)),
          }),
    };
    try {
      return redactNativeContextData(await this.run(boundContext), references);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw new BridgeError({
          code: error.code,
          message: redactNativeContextText(error.message, references),
          retryable: error.retryable,
          ...(error.details === undefined
            ? {}
            : { details: redactNativeContextData(error.details, references) }),
        });
      }
      throw new Error(
        redactNativeContextText(error instanceof Error ? error.message : String(error), references),
        { cause: error },
      );
    }
  }

  resolvePolicy(request: StartInvocationRequest, _route: RouteDescriptor): PolicyResolution {
    return policyFor(request);
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    if (process.platform === "win32") {
      throw new BridgeError({
        code: "route_unavailable",
        message: "Grok ACP process-tree supervision is not qualified on Windows.",
        retryable: false,
      });
    }
    const policy = policyFor(context.request);
    if (!policy.supported) {
      throw new BridgeError({
        code: "unsupported_capability",
        message: "Grok ACP cannot enforce every requested policy control.",
        retryable: false,
        details: { unsupported: policy.unsupported },
      });
    }
    const prompt = textPrompt(context);
    const executable = context.route.executable;
    if (executable === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: "Grok executable resolution was not retained for this route.",
        retryable: false,
      });
    }

    const nativeHome = context.connection?.nativeContextRef;
    const environment =
      nativeHome === undefined
        ? { environment: childEnvironment(), denied: [] as readonly string[] }
        : environmentForNamedContext(nativeHome);
    const child = spawn(executable, [...commandArgs(context)], {
      cwd: context.request.workingDirectory,
      env: environment.environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const processStarted = Date.now();
    const processExit = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
      child.once("error", () => {
        resolve();
      });
    });
    let childError: Error | undefined;
    child.stderr?.on("data", () => {
      // Drain native diagnostics without forwarding raw text that could contain credentials.
    });
    const pending = new Map<string, PendingRequest>();
    const state = {
      identity: observedIdentity(context.route.harnessVersion),
      content: "",
      contentBytes: 0,
      usage: undefined as undefined | Usage,
      sessionId: undefined as string | undefined,
      closeSupported: false,
      terminalReason: undefined as string | undefined,
      notificationChain: Promise.resolve(),
      queuedNotifications: 0,
      queuedNotificationBytes: 0,
      fatal: undefined as Error | undefined,
    };
    let nextId = 1;
    let termination: Promise<void> | undefined;
    let writeChain: Promise<void> = Promise.resolve();
    let processClosed = false;
    let stdoutEnded = false;

    const rejectPending = (error: Error): void => {
      for (const request of pending.values()) {
        if (request.timer !== undefined) {
          clearTimeout(request.timer);
        }
        request.reject(error);
      }
      pending.clear();
    };

    const failTransport = (error: Error): void => {
      state.fatal ??= error;
      rejectPending(state.fatal);
    };

    const writeMessage = async (
      message: Readonly<Record<string, unknown>>,
      options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
    ): Promise<void> => {
      const operation = writeChain.then(async () => {
        if (
          child.stdin === null ||
          child.stdin.destroyed ||
          child.stdin.writableEnded ||
          processClosed
        ) {
          throw nativeFailure("Grok ACP stdin closed before the response could be sent.");
        }
        const accepted = child.stdin.write(`${JSON.stringify(message)}\n`);
        if (!accepted) {
          await waitForWritableDrain(child, child.stdin, {
            ...options,
            hasExited: () => processClosed,
          });
        }
      });
      writeChain = operation.catch((error: unknown) => {
        failTransport(asError(error));
      });
      return operation;
    };

    const request = async (
      method: string,
      params: Readonly<Record<string, unknown>>,
      timeoutMs?: number,
    ): Promise<unknown> => {
      if (state.fatal !== undefined) {
        throw state.fatal;
      }
      if (processClosed) {
        throw nativeFailure("Grok ACP process exited before the request could be sent.");
      }
      if (stdoutEnded) {
        throw nativeFailure("Grok ACP stdout closed before the request could be sent.");
      }
      if (context.signal.aborted) {
        throw abortError();
      }
      const id = nextId++;
      const key = String(id);
      const response = deferred<unknown>();
      void response.promise.catch(() => {});
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              pending.delete(key);
              response.reject(
                nativeFailure(`Grok ACP ${method} did not respond before the request timeout.`),
              );
            }, timeoutMs);
      pending.set(key, {
        resolve: response.resolve,
        reject: response.reject,
        ...(timer === undefined ? {} : { timer }),
      });
      const requestStartedAt = Date.now();
      try {
        await writeMessage(
          { jsonrpc: "2.0", id, method, params },
          {
            ...(timeoutMs === undefined
              ? {}
              : { timeoutMs: Math.max(0, timeoutMs - (Date.now() - requestStartedAt)) }),
            signal: context.signal,
          },
        );
      } catch (error) {
        pending.delete(key);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        throw asError(error);
      }
      return response.promise;
    };

    const emit = async (event: AdapterEvent): Promise<void> => {
      await context.emit(event);
      context.reportPartial?.({
        content: state.content === "" ? [] : [{ type: "text", text: state.content }],
        artifacts: [],
        effects: [],
        observedIdentity: state.identity,
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      });
    };

    const updateIdentity = (sessionId: string): void => {
      state.identity = {
        ...state.identity,
        nativeSessionId: { value: sessionId, evidence: "reported", source: "grok-acp" },
      };
    };

    const handleUpdate = async (paramsValue: unknown): Promise<void> => {
      const params = record(paramsValue);
      const update = record(params?.update);
      if (
        params?.sessionId !== state.sessionId ||
        state.sessionId === undefined ||
        update === undefined ||
        typeof update.sessionUpdate !== "string"
      ) {
        throw nativeFailure(
          "Grok ACP sent a malformed session/update notification.",
          "output_unparseable",
        );
      }
      const updateType = update.sessionUpdate;
      if (updateType === "agent_message_chunk") {
        const content = record(update.content);
        if (content?.type === "text" && typeof content.text === "string") {
          const chunkBytes = Buffer.byteLength(content.text, "utf8");
          if (state.contentBytes + chunkBytes > MAX_ACP_TEXT_BYTES) {
            throw nativeFailure(
              "Grok ACP output exceeded the adapter text limit.",
              "output_unparseable",
            );
          }
          state.content += content.text;
          state.contentBytes += chunkBytes;
          await emit({ category: "output", content: [{ type: "text", text: content.text }] });
        }
        return;
      }
      if (updateType === "usage_update") {
        const cost = record(update.cost);
        const costUsd = cost?.currency === "USD" ? numberValue(cost.amount) : undefined;
        if (costUsd !== undefined) {
          state.usage = { costUsd, evidence: "reported", source: "grok-acp" };
          await emit({ category: "usage", usage: state.usage });
        } else {
          await emit({
            category: "activity",
            data: { phase: "usage_update", contextUsed: numberValue(update.used) ?? 0 },
          });
        }
        return;
      }
      if (updateType === "tool_call" || updateType === "tool_call_update") {
        await emit({
          category: "activity",
          data: {
            phase: updateType,
            ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
            ...(typeof update.title === "string" ? { title: update.title.slice(0, 240) } : {}),
            ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
            ...(typeof update.status === "string" ? { status: update.status } : {}),
          },
        });
        return;
      }
      if (updateType === "agent_thought_chunk") {
        await emit({ category: "activity", data: { phase: "agent_thought_chunk" } });
        return;
      }
      if (updateType === "state_update") {
        const stateValue = typeof update.state === "string" ? update.state : undefined;
        if (stateValue === "idle") {
          const stopReason = typeof update.stopReason === "string" ? update.stopReason : undefined;
          state.terminalReason ??= stopReason;
        }
        await emit({
          category: "activity",
          data: {
            phase: "state_update",
            ...(stateValue === undefined ? {} : { state: stateValue }),
          },
        });
        return;
      }
      await emit({ category: "activity", data: { phase: "session_update", updateType } });
    };

    const handleLine = (line: string): void => {
      if (state.fatal !== undefined) {
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_ACP_LINE_BYTES) {
        failTransport(
          nativeFailure(
            "Grok ACP emitted a message larger than the protocol limit.",
            "output_unparseable",
          ),
        );
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        failTransport(
          nativeFailure("Grok ACP emitted malformed JSON-RPC output.", "output_unparseable"),
        );
        return;
      }
      const message = record(decoded);
      if (message?.jsonrpc !== "2.0") {
        failTransport(
          nativeFailure("Grok ACP emitted a non-JSON-RPC message.", "output_unparseable"),
        );
        return;
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          const id = message.id;
          const method = message.method;
          void writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code: -32_601, message: `Unsupported Grok ACP client method: ${method}.` },
          }).catch((error: unknown) => {
            failTransport(asError(error));
          });
          failTransport(
            nativeFailure(
              `Grok ACP requested unsupported client method ${method}; the adapter does not execute native tools.`,
              "unsupported_capability",
            ),
          );
          return;
        }
        if (message.method === "session/update") {
          const params = message.params;
          let notificationBytes: number;
          try {
            notificationBytes = Buffer.byteLength(JSON.stringify(params ?? null), "utf8");
          } catch {
            failTransport(
              nativeFailure("Grok ACP sent an unserializable notification.", "output_unparseable"),
            );
            return;
          }
          if (
            state.queuedNotifications >= MAX_ACP_QUEUED_NOTIFICATIONS ||
            state.queuedNotificationBytes + notificationBytes > MAX_ACP_QUEUED_NOTIFICATION_BYTES
          ) {
            failTransport(
              nativeFailure(
                "Grok ACP notification backlog exceeded the adapter limit.",
                "output_unparseable",
              ),
            );
            return;
          }
          state.queuedNotifications += 1;
          state.queuedNotificationBytes += notificationBytes;
          state.notificationChain = state.notificationChain
            .then(async () => {
              try {
                await handleUpdate(params);
              } finally {
                state.queuedNotifications -= 1;
                state.queuedNotificationBytes -= notificationBytes;
              }
            })
            .catch((error: unknown) => {
              failTransport(asError(error));
            });
        }
        return;
      }
      if (!isRpcId(message.id)) {
        failTransport(
          nativeFailure(
            "Grok ACP emitted a response without a valid JSON-RPC ID.",
            "output_unparseable",
          ),
        );
        return;
      }
      const key = String(message.id);
      const pendingRequest = pending.get(key);
      if (pendingRequest === undefined) {
        failTransport(
          nativeFailure("Grok ACP emitted an unexpected JSON-RPC response.", "output_unparseable"),
        );
        return;
      }
      pending.delete(key);
      if (pendingRequest.timer !== undefined) {
        clearTimeout(pendingRequest.timer);
      }
      const rpcError = record(message.error);
      if (rpcError !== undefined) {
        if (authFailure(rpcError)) {
          pendingRequest.reject(
            new BridgeError({
              code: "route_unavailable",
              message:
                "Grok requested native authentication. Run `grok login` with the selected GROK_HOME, then retry.",
              retryable: false,
            }),
          );
        } else {
          pendingRequest.reject(
            nativeFailure(
              "Grok ACP rejected the request; native error text is omitted to avoid exposing private configuration.",
              "harness_failed",
            ),
          );
        }
      } else {
        pendingRequest.resolve(message.result);
      }
    };

    const outputReader = (async (): Promise<void> => {
      if (child.stdout === null) {
        failTransport(nativeFailure("Grok ACP stdout was unavailable.", "output_unparseable"));
        return;
      }
      try {
        for await (const line of readBoundedLines(child.stdout, MAX_ACP_LINE_BYTES)) {
          handleLine(line);
          if (state.fatal !== undefined) {
            break;
          }
        }
        stdoutEnded = true;
        if (pending.size > 0) {
          failTransport(
            nativeFailure(
              "Grok ACP stdout closed before a response arrived.",
              "output_unparseable",
            ),
          );
        }
      } catch {
        failTransport(
          nativeFailure(
            "Grok ACP output framing failed or exceeded the protocol limit.",
            "output_unparseable",
          ),
        );
      }
    })();
    child.stdin?.on("error", (error) => {
      failTransport(error);
    });
    child.once("error", (error) => {
      childError = error;
      failTransport(nativeFailure("The Grok ACP process could not be started."));
    });
    child.once("close", (code, signal) => {
      processClosed = true;
      if (pending.size > 0) {
        const message =
          state.fatal ??
          nativeFailure(
            `Grok ACP exited before replying (code ${String(code)}, signal ${String(signal)}).`,
          );
        failTransport(message);
      }
    });

    const terminate = async (): Promise<void> => {
      termination ??= terminateProcessGroup(
        child,
        processExit,
        context.terminationGraceMs ?? TERMINATION_GRACE_MS,
      );
      await termination;
    };
    const onAbort = (): void => {
      if (state.sessionId !== undefined) {
        void writeMessage({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: state.sessionId },
        }).catch(() => {
          // Process-group termination remains the authoritative cancellation path.
        });
      }
      rejectPending(abortError());
      void terminate().catch((error: unknown) => {
        failTransport(asError(error));
      });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    const resultSnapshot = (): Partial<AdapterRunResult> => ({
      content: state.content === "" ? [] : [{ type: "text", text: state.content }],
      artifacts: [],
      effects: [],
      observedIdentity: state.identity,
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    });

    let result: AdapterRunResult | undefined;
    let runError: unknown;
    let runFailed = false;
    try {
      await emit({
        category: "activity",
        data: {
          phase: "process_started",
          transport: "acp-v1",
          command: { executable, args: [...commandArgs(context)] },
          deniedEnvironment: [...environment.denied],
          clientCapabilities: { filesystemRead: false, filesystemWrite: false, terminal: false },
        },
      });
      if (context.signal.aborted) {
        throw abortError();
      }
      const initialize = record(
        await request(
          "initialize",
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      );
      if (initialize?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw nativeFailure(
          "Grok ACP negotiated an unsupported protocol version.",
          "route_unavailable",
        );
      }
      const agentCapabilities = record(initialize.agentCapabilities);
      const sessionCapabilities = record(agentCapabilities?.sessionCapabilities);
      state.closeSupported =
        sessionCapabilities !== undefined && Object.hasOwn(sessionCapabilities, "close");
      const session = record(
        await request(
          "session/new",
          { cwd: context.request.workingDirectory, mcpServers: [] },
          DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      );
      if (typeof session?.sessionId !== "string" || session.sessionId === "") {
        throw nativeFailure("Grok ACP did not return a session ID.", "output_unparseable");
      }
      state.sessionId = session.sessionId;
      updateIdentity(session.sessionId);
      context.reportPartial?.(resultSnapshot());
      const promptResult = record(
        await request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
      );
      await state.notificationChain;
      if (state.fatal !== undefined) {
        throw state.fatal;
      }
      const stopReason =
        typeof promptResult?.stopReason === "string"
          ? promptResult.stopReason
          : state.terminalReason;
      if (stopReason === "cancelled" || context.signal.aborted) {
        throw abortError();
      }
      if (stopReason !== "end_turn" && stopReason !== "refusal") {
        throw nativeFailure(
          stopReason === undefined
            ? "Grok ACP completed without a terminal stop reason."
            : `Grok ACP stopped incompletely (${stopReason}).`,
          "harness_failed",
        );
      }
      if (state.content === "") {
        throw nativeFailure("Grok ACP reported a completed turn without assistant text.");
      }
      result = {
        content: [{ type: "text", text: state.content }],
        artifacts: [],
        effects: [],
        observedIdentity: state.identity,
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      };
    } catch (error) {
      runFailed = true;
      runError = error;
      await emit({
        category: "diagnostic",
        data: {
          phase: "grok_acp_failure",
          elapsedMs: Math.max(0, Date.now() - processStarted),
          code: error instanceof BridgeError ? error.code : "adapter_failed",
        },
      }).catch(() => {});
    }
    if (state.sessionId !== undefined && state.closeSupported && !context.signal.aborted) {
      await request("session/close", { sessionId: state.sessionId }, 1500).catch(() => {});
    }
    if (child.stdin !== null && !child.stdin.writableEnded) {
      child.stdin.end();
    }
    context.signal.removeEventListener("abort", onAbort);
    let cleanupError: Error | undefined;
    try {
      await Promise.race([processExit, delay(300)]);
      await terminate();
      await outputReader;
      await state.notificationChain;
    } catch (error) {
      cleanupError = asError(error);
    }
    if (cleanupError !== undefined) {
      throw new BridgeError(
        {
          code: "harness_failed",
          message:
            "Grok ACP process cleanup failed; the invocation cannot be reported as successful.",
          retryable: false,
        },
        {
          cause: runFailed
            ? new AggregateError(
                [asError(runError), cleanupError],
                "The Grok invocation failed and its process cleanup also failed.",
              )
            : cleanupError,
        },
      );
    }
    if (childError !== undefined && !context.signal.aborted) {
      throw new BridgeError(
        {
          code: "harness_failed",
          message: "The Grok ACP process could not be started.",
          retryable: false,
        },
        { cause: childError },
      );
    }
    if (runFailed) {
      throw runError;
    }
    if (result === undefined) {
      throw nativeFailure("Grok ACP settled without a result or an adapter error.");
    }
    return result;
  }

  async #discover(
    nativeHome?: string,
    requiredVersion?: string,
  ): Promise<readonly RouteDescriptor[]> {
    let executable = this.#executable;
    executable ??= await (this.#probe?.findExecutable ?? findExecutable)(MANIFEST.command);
    if (executable === undefined) {
      return routeDescriptors("unavailable", undefined, "unknown", [
        "Grok Build executable was not found.",
      ]);
    }
    try {
      await access(executable, constants.X_OK);
    } catch {
      return routeDescriptors("unavailable", executable, "unknown", [
        "Grok Build executable is not accessible or executable.",
      ]);
    }
    const environment =
      nativeHome === undefined
        ? childEnvironment()
        : environmentForNamedContext(nativeHome).environment;
    const versionOutput = await (this.#probe?.readVersion ?? readVersion)(
      executable,
      MANIFEST.versionArgs,
      environment,
    );
    const version = versionFrom(versionOutput) ?? "unknown";
    if (
      version !== QUALIFIED_VERSION ||
      (requiredVersion !== undefined && version !== requiredVersion)
    ) {
      return routeDescriptors("unqualified", executable, version, [
        `Grok Build ${version} is not the qualified ${QUALIFIED_VERSION} release.`,
      ]);
    }
    if (process.platform === "win32") {
      return routeDescriptors("unavailable", executable, version, [
        "Grok ACP process-tree supervision is not qualified on Windows.",
      ]);
    }
    return routeDescriptors("unavailable", executable, version, [
      "Grok 1.0.44 ACP v1 is fixture-qualified, but native authentication status and account-specific model availability have no qualified read-only probe. Discovery does not run `grok models` or authenticate. Complete the native login yourself; route readiness remains unavailable until auth/model discovery is qualified.",
      "ACP filesystem and terminal client capabilities are disabled. This adapter currently supports text-only prompt/output; native tool execution, effects, permission prompts, and continuation are not qualified.",
    ]);
  }
}
