import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  InputResponse,
  JsonValue,
  ObservedIdentity,
  ObservedValue,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";
import type {
  Adapter,
  AdapterConnectionRunContext,
  AdapterEvent,
  AdapterRunContext,
  AdapterRunResult,
} from "./types.js";

import { BridgeError } from "../errors.js";
import {
  inspectNativeContextDirectory,
  redactNativeContextData,
  redactNativeContextText,
} from "./environment.js";

const MAX_NATIVE_EVENT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 2000;
const REDACTED_ARGUMENT_FLAGS = new Set(["--text", "--prompt", "--prompt-file"]);

// Bridge-internal variables never reach a harness process (ADR-0020). The
// second entry is the pre-rename prefix: a shell or CI job that has not
// finished the ADR-0021 migration may still export `AGENT_BRIDGE_*`, and a
// stale export must not leak into the child either. Drop it once the migration
// window closes.
const BRIDGE_INTERNAL_ENVIRONMENT_PREFIXES = ["HARNESS_RELAY_", "AGENT_BRIDGE_"] as const;

export type CommandSpec = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly envDenyList?: readonly string[];
  readonly stdin?: string;
  readonly keepStdinOpen?: boolean;
};

function textContent(request: StartInvocationRequest): string {
  return request.input
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "json") {
        return JSON.stringify(part.value);
      }
      if (part.type === "resource") {
        return `[resource ${part.uri}]`;
      }
      return `[${part.type} ${part.path}]`;
    })
    .join("\n\n");
}

function observed(value: string | undefined, source: string): ObservedValue {
  return value === undefined ? { evidence: "unverified" } : { value, evidence: "reported", source };
}

function identity(provider: string, harnessVersion: string): ObservedIdentity {
  return {
    provider: { value: provider, evidence: "inferred", source: "adapter" },
    model: { evidence: "unverified" },
    harnessVersion: observed(harnessVersion, "route-qualification"),
    nativeSessionId: { evidence: "unverified" },
  };
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function abortError(): Error {
  const error = new Error("The harness process was aborted.");
  error.name = "AbortError";
  return error;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the signal and the close event.
  }
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    return false;
  }
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function diagnosticArgs(args: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    result.push(argument ?? "");
    if (REDACTED_ARGUMENT_FLAGS.has(argument ?? "") && index + 1 < args.length) {
      result.push("<redacted>");
      index += 1;
    }
  }
  return result;
}

function redactError(error: unknown, references: readonly string[]): Error {
  if (error instanceof BridgeError) {
    const cause = error.cause;
    return new BridgeError(
      {
        code: error.code,
        message: redactNativeContextText(error.message, references),
        retryable: error.retryable,
        ...(error.details === undefined
          ? {}
          : { details: redactNativeContextData(error.details, references) }),
      },
      cause === undefined ? undefined : { cause: redactError(cause, references) },
    );
  }
  if (error instanceof Error) {
    const cause = error.cause;
    const redacted = new Error(
      redactNativeContextText(error.message, references),
      cause === undefined ? undefined : { cause: redactError(cause, references) },
    );
    redacted.name = error.name;
    return redacted;
  }
  return new Error(redactNativeContextText(String(error), references));
}

export abstract class ProcessAdapter implements Adapter {
  abstract readonly id: string;

  abstract discover(): Promise<readonly RouteDescriptor[]>;

  protected abstract command(context: AdapterRunContext): CommandSpec;

  protected abstract normalizeNative(
    value: Record<string, JsonValue>,
    state: {
      identity: ObservedIdentity;
      content: ContentAccumulator;
      pendingEffects?: Map<string, WorkspaceEffect>;
    },
  ): AdapterEvent | undefined;

  protected async validateConnectionInvocation(
    _context: AdapterConnectionRunContext,
  ): Promise<void> {
    // Named adapters override this hook when an invocation has context-specific configuration.
  }

  async runConnection(context: AdapterConnectionRunContext): Promise<AdapterRunResult> {
    const nativeContext = await inspectNativeContextDirectory(context.connection.nativeContextRef);
    if (nativeContext === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Named connection ${context.connection.id} no longer refers to a readable native context directory.`,
        retryable: false,
        details: { connectionId: context.connection.id },
      });
    }
    const references = [
      ...nativeContext.privatePaths,
      ...(context.connection.executable === undefined ? [] : [context.connection.executable]),
    ];
    const boundContext = {
      ...context,
      route: {
        ...context.route,
        ...(context.connection.executable === undefined
          ? {}
          : { executable: context.connection.executable }),
      },
      connection: {
        ...context.connection,
        nativeContextRef: nativeContext.path,
      },
      emit: async (event: AdapterEvent) => context.emit(redactNativeContextData(event, references)),
      ...(context.reportPartial === undefined
        ? {}
        : {
            reportPartial: (result: Partial<AdapterRunResult>) =>
              context.reportPartial?.(redactNativeContextData(result, references)),
          }),
    };
    try {
      await this.validateConnectionInvocation(boundContext);
      return redactNativeContextData(await this.run(boundContext), references);
    } catch (error) {
      throw redactError(error, references);
    }
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const command = this.command(context);
    const deniedEnvironment = new Set(command.envDenyList ?? []);
    const environment = Object.fromEntries(
      Object.entries({ ...process.env, ...command.env }).filter(
        ([key]) =>
          !BRIDGE_INTERNAL_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
          !deniedEnvironment.has(key),
      ),
    );
    const child = spawn(command.executable, [...command.args], {
      cwd: context.request.workingDirectory,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let streamError:
      | { readonly stream: "stderr" | "stdin" | "stdout"; readonly error: Error }
      | undefined;
    const streamDiagnostics: Array<Promise<void>> = [];
    const reportStreamError = (stream: "stderr" | "stdin" | "stdout", error: Error): void => {
      streamError ??= { stream, error };
      streamDiagnostics.push(
        context
          .emit({
            category: "diagnostic",
            data: {
              phase: "stream_error",
              stream,
              code: "code" in error && typeof error.code === "string" ? error.code : "unknown",
              message: error.message,
            },
          })
          .catch(() => {}),
      );
    };
    child.stdin?.on("error", (error) => {
      reportStreamError("stdin", error);
    });
    child.stdout?.on("error", (error) => {
      reportStreamError("stdout", error);
    });
    child.stderr?.on("error", (error) => {
      reportStreamError("stderr", error);
    });
    let childError: Error | undefined;
    const exitPromise = new Promise<{
      readonly code: null | number;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("error", (error) => {
        childError = error;
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });
    if (command.keepStdinOpen === true) {
      if (command.stdin !== undefined) {
        child.stdin?.write(command.stdin);
      }
    } else {
      child.stdin?.end(command.stdin ?? "");
    }
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.join("").length < MAX_NATIVE_EVENT_BYTES) {
        stderr.push(chunk.slice(0, MAX_NATIVE_EVENT_BYTES));
      }
    });

    const state = {
      identity: identity(context.route.provider, context.route.harnessVersion),
      content: new ContentAccumulator(),
      effects: [] as WorkspaceEffect[],
      pendingEffects: new Map<string, WorkspaceEffect>(),
      usage: undefined as undefined | Usage,
      failure: undefined as AdapterEvent["failure"],
    };
    let nativeResultSeen = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    let terminationPromise: Promise<void> | undefined;
    const terminate = async (): Promise<void> => {
      if (terminationPromise !== undefined) {
        return terminationPromise;
      }
      terminationStarted = true;
      killProcessGroup(child, "SIGINT");
      terminationPromise = new Promise<void>((resolve) => {
        let forceKilled = false;
        const forceTerminate = (): void => {
          forceKilled = true;
          killProcessGroup(child, "SIGKILL");
          // SIGKILL is synchronous with respect to signal delivery. The
          // leader's close event is still awaited below so its stdio and PID
          // are reaped before the adapter rejects.
          void exitPromise.then(() => {
            setImmediate(resolve);
          });
        };
        terminationTimer = setTimeout(
          forceTerminate,
          context.terminationGraceMs ?? TERMINATION_GRACE_MS,
        );
        void exitPromise.then(() => {
          // A leader can exit while a descendant keeps the process group alive.
          // Keep the grace timer in that case so the group is still force-killed.
          if (!forceKilled && !processGroupExists(child)) {
            clearTimeout(terminationTimer);
            resolve();
          }
        });
      });
      return terminationPromise;
    };
    const onAbort = (): void => {
      void terminate();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) {
      void terminate();
    }

    // Attach the stdout consumer before the first await. When the child exits,
    // Node flushes and discards every stdio stream nobody is reading yet, so a
    // harness that finishes while the process_started event is still being
    // persisted would otherwise lose its whole output and be reported as
    // succeeded with empty content.
    const lines = child.stdout === null ? undefined : createInterface({ input: child.stdout });
    const lineStream = lines?.[Symbol.asyncIterator]();

    try {
      await context.emit({
        category: "activity",
        data: {
          phase: "process_started",
          command: { executable: command.executable, args: [...diagnosticArgs(command.args)] },
          deniedEnvironment: [...deniedEnvironment].sort(),
        },
      });
      if (lines !== undefined && lineStream !== undefined) {
        void exitPromise.then(() => {
          lines.close();
        });
        for await (const line of lineStream) {
          if (typeof line !== "string" || line.trim() === "") {
            continue;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(line) as unknown;
          } catch (error) {
            throw new BridgeError(
              {
                code: "output_unparseable",
                message: `The ${this.id} harness emitted malformed JSONL output.`,
                retryable: false,
                details: { line: line.slice(0, MAX_NATIVE_EVENT_BYTES) },
              },
              { cause: error },
            );
          }
          const native = jsonRecord(decoded);
          if (native === undefined) {
            throw new BridgeError({
              code: "output_unparseable",
              message: `The ${this.id} harness emitted a non-object JSON event.`,
              retryable: false,
            });
          }
          const event = this.normalizeNative(native, state);
          if (event !== undefined) {
            if (event.data?.state === "native_result") {
              nativeResultSeen = true;
            }
            if (event.effects !== undefined) {
              state.effects.push(...event.effects);
            }
            if (event.usage !== undefined) {
              state.usage = event.usage;
            }
            if (event.failure !== undefined) {
              state.failure = event.failure;
            }
            context.reportPartial?.({
              content: state.content.parts,
              artifacts: [],
              effects: state.effects,
              observedIdentity: state.identity,
              ...(state.usage === undefined ? {} : { usage: state.usage }),
            });
            if (event.inputRequest !== undefined) {
              if (event.inputRequest.kind !== "permission") {
                throw new BridgeError({
                  code: "unsupported_capability",
                  message: "This process adapter does not implement general caller questions.",
                  retryable: false,
                });
              }
              await context.emit({
                ...event,
                category: "input_required",
                data: {
                  ...event.data,
                  requestId: event.inputRequest.requestId,
                  kind: event.inputRequest.kind,
                  prompt: event.inputRequest.prompt,
                  ...(event.inputRequest.toolName === undefined
                    ? {}
                    : { toolName: event.inputRequest.toolName }),
                  ...(event.inputRequest.input === undefined
                    ? {}
                    : { input: event.inputRequest.input }),
                },
              });
              if (context.awaitInput === undefined || child.stdin === null) {
                throw new BridgeError({
                  code: "unsupported_capability",
                  message:
                    "The adapter reported an input request but no response channel is available.",
                  retryable: false,
                });
              }
              const response: Pick<InputResponse, "decision"> = await context.awaitInput(
                event.inputRequest.requestId,
                context.signal,
              );
              if (context.signal.aborted) {
                throw abortError();
              }
              const nativeResponse = {
                behavior: response.decision,
                ...(response.decision === "allow"
                  ? { updatedInput: event.inputRequest.input ?? {} }
                  : { message: "The caller denied this permission request." }),
              };
              child.stdin.write(
                `${JSON.stringify({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: event.inputRequest.requestId,
                    response: nativeResponse,
                  },
                })}\n`,
              );
            } else {
              await context.emit(event);
            }
            const nativeState = event.data?.state;
            if (
              typeof nativeState === "string" &&
              nativeState.startsWith("native_") &&
              child.stdin !== null &&
              command.keepStdinOpen === true
            ) {
              child.stdin.end();
            }
          }
        }
      }
      const exit = await exitPromise;
      await Promise.all(streamDiagnostics);
      if (childError !== undefined) {
        throw childError;
      }
      if (streamError !== undefined) {
        throw new BridgeError({
          code: "harness_failed",
          message: `${this.id} ${streamError.stream} stream failed: ${streamError.error.message}`,
          retryable: false,
          details: {
            stream: streamError.stream,
            code:
              "code" in streamError.error && typeof streamError.error.code === "string"
                ? streamError.error.code
                : "unknown",
          },
        });
      }
      if (context.signal.aborted) {
        throw abortError();
      }
      if (state.failure !== undefined) {
        throw new BridgeError({
          code: "harness_failed",
          message: state.failure.message,
          retryable: false,
          details: { nativeCode: state.failure.code },
        });
      }
      if (exit.code !== 0) {
        const diagnostic = stderr.join("").trim();
        throw new BridgeError({
          code: "harness_failed",
          message:
            diagnostic === ""
              ? `${this.id} exited with ${exit.signal === null ? `code ${String(exit.code)}` : `signal ${exit.signal}`}.`
              : diagnostic.slice(0, MAX_NATIVE_EVENT_BYTES),
          retryable: false,
          details: { exitCode: exit.code, signal: exit.signal },
        });
      }
      if (!nativeResultSeen) {
        throw new BridgeError({
          code: "harness_failed",
          message: `${this.id} exited without a native completion result.`,
          retryable: false,
          details: { reason: "missing_native_result" },
        });
      }
      return {
        content: state.content.parts,
        artifacts: [],
        effects: state.effects,
        observedIdentity: state.identity,
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      };
    } catch (error) {
      // Every rejected run owns teardown, including malformed output, stream
      // failures, and errors from event persistence or normalization.
      await terminate();
      throw error;
    } finally {
      lines?.close();
      context.signal.removeEventListener("abort", onAbort);
      if (terminationTimer !== undefined) {
        clearTimeout(terminationTimer);
      }
      if (terminationStarted) {
        await terminationPromise;
      }
    }
  }
}

export class ContentAccumulator {
  readonly #fallback: Array<{ readonly type: "text"; readonly text: string }> = [];
  #final: string | undefined;

  get parts(): ReadonlyArray<{ readonly type: "text"; readonly text: string }> {
    return this.#final === undefined ? this.#fallback : [{ type: "text", text: this.#final }];
  }

  add(text: string): void {
    if (text !== "") {
      this.#fallback.push({ type: "text", text });
    }
  }

  setFinal(text: string): void {
    if (text !== "") {
      this.#final = text;
    }
  }
}

export function promptFor(context: AdapterRunContext): string {
  return textContent(context.request);
}
