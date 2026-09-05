import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  InputResponse,
  JsonValue,
  ObservedIdentity,
  ObservedValue,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";
import { BridgeError } from "../errors.js";
import type { Adapter, AdapterEvent, AdapterRunContext, AdapterRunResult } from "./types.js";

const MAX_NATIVE_EVENT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 2_000;

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly envDenyList?: readonly string[];
  readonly stdin?: string;
  readonly keepStdinOpen?: boolean;
}

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

export abstract class ProcessAdapter implements Adapter {
  abstract readonly id: string;

  abstract discover(): Promise<readonly import("../contract.js").RouteDescriptor[]>;

  protected abstract command(context: AdapterRunContext): CommandSpec;

  protected abstract normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined;

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const command = this.command(context);
    const deniedEnvironment = new Set(command.envDenyList ?? []);
    const environment = Object.fromEntries(
      Object.entries({ ...process.env, ...command.env }).filter(
        ([key]) => !key.startsWith("AGENT_BRIDGE_") && !deniedEnvironment.has(key),
      ),
    );
    const child = spawn(command.executable, [...command.args], {
      cwd: context.request.workingDirectory,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let childError: Error | undefined;
    const exitPromise = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", (error) => {
          childError = error;
          resolve({ code: null, signal: null });
        });
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
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
      usage: undefined as Usage | undefined,
      failure: undefined as AdapterEvent["failure"],
    };
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    const terminate = (): void => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      killProcessGroup(child, "SIGINT");
      terminationTimer = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        context.terminationGraceMs ?? TERMINATION_GRACE_MS,
      );
      terminationTimer.unref();
    };
    const onAbort = (): void => terminate();
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await context.emit({
        category: "activity",
        data: { phase: "process_started" },
        native: {
          command: { executable: command.executable, args: [...command.args] },
          deniedEnvironment: [...deniedEnvironment].sort(),
        },
      });
      const lines = child.stdout === null ? undefined : createInterface({ input: child.stdout });
      if (lines !== undefined) {
        void exitPromise.then(() => lines.close());
        for await (const line of lines) {
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
              await context.emit({
                ...event,
                category: "input_required",
                data: {
                  ...(event.data ?? {}),
                  requestId: event.inputRequest.requestId,
                  kind: event.inputRequest.kind,
                  prompt: event.inputRequest.prompt,
                  ...(event.inputRequest.toolName === undefined ? {} : { toolName: event.inputRequest.toolName }),
                },
              });
              if (context.awaitInput === undefined || child.stdin === null) {
                throw new BridgeError({
                  code: "unsupported_capability",
                  message: "The adapter reported an input request but no response channel is available.",
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
            if (event.data?.state === "native_result" && child.stdin !== null && command.keepStdinOpen === true) {
              child.stdin.end();
            }
          }
        }
      }
      const exit = await exitPromise;
      if (childError !== undefined) {
        throw childError;
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
      return {
        content: state.content.parts,
        artifacts: [],
        effects: state.effects,
        observedIdentity: state.identity,
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (terminationTimer !== undefined) {
        clearTimeout(terminationTimer);
      }
      if (!child.killed && context.signal.aborted) {
        terminate();
      }
    }
  }
}

export class ContentAccumulator {
  readonly #fallback: Array<{ readonly type: "text"; readonly text: string }> = [];
  #final: string | undefined;

  get parts(): readonly { readonly type: "text"; readonly text: string }[] {
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
