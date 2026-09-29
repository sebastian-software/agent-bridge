import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ContentPart, ObservedIdentity, Usage, WorkspaceEffect } from "../contract.js";
import type { AdapterRunContext, AdapterRunResult } from "./types.js";

import { BridgeError } from "../errors.js";
import {
  MAX_PI_WORKER_EVENT_BYTES,
  MAX_PI_WORKER_MESSAGE_BYTES,
  parsePiWorkerLine,
  PI_WORKER_PROTOCOL_VERSION,
  type PiToolName,
  type PiWorkerControl,
  type PiWorkerOutput,
  type PiWorkerSessionRequest,
  type PiWorkerSessionSnapshot,
  type PiWorkerStart,
  readBoundedLines,
} from "./pi-protocol.js";
import { promptFor } from "./process.js";

const GROUP_CLEANUP_LIMIT_MS = 3000;
const MAX_WORKER_DIAGNOSTIC_BYTES = 16 * 1024;

export type PiRuntimeConfiguration = {
  readonly model: PiWorkerStart["model"];
  readonly modelFiles: PiWorkerStart["modelFiles"];
  readonly tools: readonly PiToolName[];
};

export type PiWorkerSessionRun = {
  readonly result: AdapterRunResult;
  readonly session: PiWorkerSessionSnapshot;
};

type PiWorkerInternalRun = {
  readonly result: AdapterRunResult;
  readonly session?: PiWorkerSessionSnapshot;
};

type RegisteredGroup = {
  readonly processGroupId: number;
  cleaned: boolean;
};

function initialIdentity(configuration: PiRuntimeConfiguration): ObservedIdentity {
  return {
    provider: {
      value: configuration.model.provider,
      evidence: "inferred",
      source: "selected-pi-model",
    },
    model: { value: configuration.model.id, evidence: "inferred", source: "selected-pi-model" },
    harnessVersion: {
      evidence: "unverified",
    },
    nativeSessionId: { evidence: "unverified" },
  };
}

function groupExists(processGroupId: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return true;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM and unknown failures do not prove that the process group is gone.
    return error instanceof Error && "code" in error ? error.code !== "ESRCH" : true;
  }
}

function killGroup(processGroupId: number): void {
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
    // The group can exit between the liveness check and signal delivery.
  }
}

async function terminateGroup(processGroupId: number): Promise<boolean> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  killGroup(processGroupId);
  const deadline = Date.now() + GROUP_CLEANUP_LIMIT_MS;
  while (groupExists(processGroupId) && Date.now() < deadline) {
    await delay(20);
  }
  if (groupExists(processGroupId)) {
    killGroup(processGroupId);
    return false;
  }
  return true;
}

function workerEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
}

function controlLine(control: PiWorkerControl): string {
  const line = `${JSON.stringify(control)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_PI_WORKER_MESSAGE_BYTES) {
    throw new Error("Pi worker control message exceeded its configured limit.");
  }
  return line;
}

async function sendControl(child: ChildProcess, control: PiWorkerControl): Promise<void> {
  if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) {
    throw new Error("Pi worker control channel is closed.");
  }
  const line = controlLine(control);
  if (!child.stdin.write(line)) {
    await new Promise<void>((resolve, reject) => {
      child.stdin?.once("drain", resolve);
      child.stdin?.once("error", reject);
      child.stdin?.once("close", () => {
        reject(new Error("Pi worker control channel closed."));
      });
    });
  }
}

function textParts(text: string): ContentPart[] {
  return text === "" ? [] : [{ type: "text", text }];
}

function eventText(output: PiWorkerOutput): string {
  if (output.type !== "event" || output.event.category !== "output") {
    return "";
  }
  return (output.event.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function stderrDetail(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").trim().slice(0, MAX_WORKER_DIAGNOSTIC_BYTES);
}

function abortError(): Error {
  const error = new Error("The Pi worker was aborted.");
  error.name = "AbortError";
  return error;
}

function killWorker(child: ChildProcess): void {
  if (
    child.pid === undefined ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to killing the worker leader.
    }
  }
  child.kill("SIGKILL");
}

export async function runPiWorker(
  context: AdapterRunContext,
  configuration: PiRuntimeConfiguration,
): Promise<AdapterRunResult> {
  return supervisePiWorker(
    context,
    configuration,
    fileURLToPath(new URL("pi-worker.js", import.meta.url)),
  );
}

export async function runPiWorkerSession(
  context: AdapterRunContext,
  configuration: PiRuntimeConfiguration,
  session: PiWorkerSessionRequest,
): Promise<PiWorkerSessionRun> {
  const run = await supervisePiWorkerInternal(
    context,
    configuration,
    fileURLToPath(new URL("pi-worker.js", import.meta.url)),
    session,
  );
  if (run.session === undefined) {
    throw new BridgeError({
      code: "continuation_unavailable",
      message: "The Pi worker did not return a settled persistent session checkpoint.",
      retryable: false,
    });
  }
  return { result: run.result, session: run.session };
}

/** Internal process seam used by deterministic supervisor failure tests. */
export async function supervisePiWorker(
  context: AdapterRunContext,
  configuration: PiRuntimeConfiguration,
  workerPath: string,
): Promise<AdapterRunResult> {
  const run = await supervisePiWorkerInternal(context, configuration, workerPath);
  return run.result;
}

async function supervisePiWorkerInternal(
  context: AdapterRunContext,
  configuration: PiRuntimeConfiguration,
  workerPath: string,
  sessionRequest?: PiWorkerSessionRequest,
): Promise<PiWorkerInternalRun> {
  if (process.platform === "win32") {
    throw new BridgeError({
      code: "unsupported_capability",
      message: "The private Pi worker requires POSIX process-group supervision.",
      retryable: false,
    });
  }
  if (context.signal.aborted) {
    throw abortError();
  }

  const start: PiWorkerStart = {
    type: "start",
    protocolVersion: PI_WORKER_PROTOCOL_VERSION,
    workingDirectory: context.request.workingDirectory,
    model: configuration.model,
    modelFiles: configuration.modelFiles,
    prompt: promptFor(context),
    tools: [...configuration.tools],
    ...(sessionRequest === undefined ? {} : { session: sessionRequest }),
  };
  const encodedStart = `${JSON.stringify(start)}\n`;
  if (Buffer.byteLength(encodedStart, "utf8") > MAX_PI_WORKER_MESSAGE_BYTES) {
    throw new BridgeError({
      code: "invalid_request",
      message: "The Pi worker request exceeded its configured transport limit.",
      retryable: false,
    });
  }

  const isolationRoot = await mkdtemp(join(tmpdir(), "harness-relay-pi-"));
  const child = spawn(process.execPath, [workerPath], {
    cwd: context.request.workingDirectory,
    env: workerEnvironment(isolationRoot),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  if (
    child.pid === undefined ||
    child.pid <= 1 ||
    child.stdin === null ||
    child.stdout === null ||
    child.stderr === null
  ) {
    killWorker(child);
    await closePromise;
    await rm(isolationRoot, { recursive: true, force: true });
    throw new BridgeError(
      {
        code: "harness_failed",
        message:
          spawnError === undefined
            ? "Could not start the supervised Pi worker process."
            : `Could not start the supervised Pi worker process: ${spawnError.message}`,
        retryable: false,
      },
      spawnError === undefined ? undefined : { cause: spawnError },
    );
  }
  const workerGroupId = child.pid;
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (value: Buffer) => {
    const buffer = Buffer.from(value);
    const remaining = MAX_WORKER_DIAGNOSTIC_BYTES - stderrBytes;
    if (remaining > 0) {
      stderr.push(buffer.subarray(0, remaining));
      stderrBytes += Math.min(buffer.byteLength, remaining);
    }
  });
  child.stderr.on("error", () => {});
  child.stdin.on("error", () => {});

  const groups = new Map<string, RegisteredGroup>();
  const streamedText: string[] = [];
  const finalTextFrames: string[] = [];
  let finalContentComplete = false;
  const effects: WorkspaceEffect[] = [];
  let observed = initialIdentity(configuration);
  let nextContentIndex = 0;
  let terminal: Extract<PiWorkerOutput, { type: "terminal" }> | undefined;
  let sessionCheckpoint: PiWorkerSessionSnapshot | undefined;
  let protocolError: Error | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let cancellationWrite: Promise<void> | undefined;
  const terminationGraceMs = Math.max(0, context.terminationGraceMs ?? 2000);
  const onAbort = (): void => {
    cancellationWrite ??= sendControl(child, { type: "cancel" }).catch(() => {});
    cancelTimer ??= setTimeout(() => {
      for (const group of groups.values()) {
        killGroup(group.processGroupId);
      }
      killWorker(child);
    }, terminationGraceMs);
  };

  const partialText = (): string => {
    if (finalContentComplete) {
      return finalTextFrames.join("");
    }
    const streamed = streamedText.join("");
    const finalPrefix = finalTextFrames.join("");
    return Buffer.byteLength(finalPrefix, "utf8") > Buffer.byteLength(streamed, "utf8")
      ? finalPrefix
      : streamed;
  };
  const reportPartial = (identity = observed, usage?: Usage): void => {
    const text = partialText();
    context.reportPartial?.({
      content: textParts(text),
      artifacts: [],
      effects: [...effects],
      observedIdentity: identity,
      ...(usage === undefined ? {} : { usage }),
    });
  };

  const cleanupGroups = async (): Promise<boolean> => {
    const results = await Promise.all(
      [...groups.values()].map(async (group) => terminateGroup(group.processGroupId)),
    );
    return results.every(Boolean);
  };
  const outputLines = readBoundedLines(child.stdout, MAX_PI_WORKER_EVENT_BYTES)[
    Symbol.asyncIterator
  ]();
  let nextOutputLine = outputLines.next();

  try {
    await sendControl(child, start);
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) {
      onAbort();
    }
    while (true) {
      const next = await nextOutputLine;
      if (next.done) {
        break;
      }
      const line = next.value;
      nextOutputLine = outputLines.next();
      if (line === "") {
        throw new Error("Pi worker emitted an empty protocol line.");
      }
      if (Buffer.byteLength(line, "utf8") > MAX_PI_WORKER_EVENT_BYTES) {
        throw new Error("Pi worker event exceeded its configured transport limit.");
      }
      const output = parsePiWorkerLine(line);
      if (terminal !== undefined) {
        throw new Error("Pi worker emitted a message after its terminal result.");
      }
      if (output.type === "session") {
        if (sessionRequest === undefined || sessionCheckpoint !== undefined) {
          throw new Error("Pi worker emitted an unexpected or duplicate session checkpoint.");
        }
        sessionCheckpoint = output.session;
        continue;
      }
      if (output.type === "tool_process_started") {
        if (groups.has(output.requestId) || output.processGroupId === workerGroupId) {
          throw new Error("Pi worker registered a duplicate or invalid process group.");
        }
        groups.set(output.requestId, {
          processGroupId: output.processGroupId,
          cleaned: false,
        });
        // Record ownership before granting the gated helper permission to exec.
        await sendControl(child, {
          type: "tool_process_registered",
          requestId: output.requestId,
          processGroupId: output.processGroupId,
        });
        continue;
      }
      if (output.type === "tool_process_finished") {
        const group = groups.get(output.requestId);
        if (group?.processGroupId !== output.processGroupId || group.cleaned) {
          throw new Error("Pi worker finished an unregistered shell process group.");
        }
        if (!(await terminateGroup(group.processGroupId))) {
          throw new Error("Relay could not confirm cleanup of a Pi shell process group.");
        }
        group.cleaned = true;
        await sendControl(child, {
          type: "tool_process_cleaned",
          requestId: output.requestId,
          processGroupId: output.processGroupId,
        });
        continue;
      }
      if (output.type === "tool_process_reaped") {
        const group = groups.get(output.requestId);
        if (
          group?.processGroupId !== output.processGroupId ||
          !group.cleaned ||
          groupExists(group.processGroupId)
        ) {
          throw new Error("Pi worker reaped an uncleaned shell process group.");
        }
        await sendControl(child, {
          type: "tool_process_cleanup_done",
          requestId: output.requestId,
          processGroupId: output.processGroupId,
        });
        groups.delete(output.requestId);
        continue;
      }
      if (output.type === "content") {
        if (finalContentComplete) {
          throw new Error("Pi worker emitted final content after completing its result frames.");
        }
        if (output.index !== nextContentIndex) {
          throw new Error("Pi worker emitted out-of-order result content frames.");
        }
        finalTextFrames.push(output.text);
        nextContentIndex += 1;
        finalContentComplete = output.final;
        reportPartial();
        continue;
      }
      if (output.type === "identity") {
        observed = output.identity;
        reportPartial();
        continue;
      }
      if (output.type === "event") {
        const text = eventText(output);
        if (text !== "") {
          streamedText.push(text);
        }
        if (output.event.effects !== undefined) {
          effects.push(...output.event.effects);
        }
        reportPartial(observed, output.event.usage);
        await context.emit(output.event);
        continue;
      }
      if (output.type === "terminal") {
        if (groups.size > 0) {
          throw new Error("Pi worker settled while supervised shell groups were still active.");
        }
        if (output.status === "succeeded" && finalTextFrames.length > 0 && !finalContentComplete) {
          throw new Error("Pi worker succeeded before completing its final content frames.");
        }
        terminal = output;
        observed = terminal.observedIdentity;
        reportPartial(observed, terminal.usage);
      }
    }

    await closePromise;
    if (context.signal.aborted) {
      throw abortError();
    }
    if (terminal === undefined) {
      const diagnostic = stderrDetail(stderr);
      throw new Error(
        diagnostic === ""
          ? `Pi worker exited without a terminal result (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`
          : diagnostic,
      );
    }
    if (spawnError !== undefined) {
      throw spawnError;
    }
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error(
        `Pi worker exited unexpectedly (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
      );
    }
    if (groups.size !== 0) {
      throw new Error("Pi worker exited with supervised shell processes still registered.");
    }
    if (terminal.status === "failed") {
      if (
        sessionRequest !== undefined &&
        (terminal.failure?.code === "continuation_unavailable" ||
          terminal.failure?.code === "continuation_route_changed")
      ) {
        throw new BridgeError({
          code: terminal.failure.code,
          message: terminal.failure.message,
          retryable: false,
        });
      }
      throw new BridgeError({
        code: "harness_failed",
        message: terminal.failure?.message ?? "Pi reported an unsuccessful run.",
        retryable: false,
        details: { nativeCode: terminal.failure?.code ?? "pi_worker_failed" },
      });
    }
    const content = partialText();
    const result: AdapterRunResult = {
      content: textParts(content),
      artifacts: [],
      effects,
      observedIdentity: terminal.observedIdentity,
      ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
    };
    context.reportPartial?.(result);
    if (sessionRequest !== undefined) {
      if (sessionCheckpoint === undefined) {
        throw new BridgeError({
          code: "continuation_unavailable",
          message: "The Pi worker did not return a settled persistent session checkpoint.",
          retryable: false,
        });
      }
      if (sessionRequest.mode === "branch") {
        if (sessionCheckpoint.cwd !== sessionRequest.expectedCwd) {
          throw new BridgeError({
            code: "continuation_route_changed",
            message: "Pi returned a session checkpoint for a different working directory.",
            retryable: false,
          });
        }
        if (
          sessionCheckpoint.sessionId === sessionRequest.expectedSessionId ||
          sessionCheckpoint.sessionFile === sessionRequest.sessionFile ||
          sessionCheckpoint.terminalLeafId === sessionRequest.terminalLeafId
        ) {
          throw new BridgeError({
            code: "continuation_unavailable",
            message: "Pi did not create an independent settled branch of the prior session.",
            retryable: false,
          });
        }
      }
      return { result, session: sessionCheckpoint };
    }
    return { result };
  } catch (error) {
    protocolError = error instanceof Error ? error : new Error(String(error));
    if (child.stdin !== null && !child.stdin.destroyed) {
      child.stdin.end();
    }
    const groupsClean = await cleanupGroups();
    killWorker(child);
    await closePromise;
    if (cancelTimer !== undefined) {
      clearTimeout(cancelTimer);
    }
    if (!groupsClean) {
      const cleanupFailure = new Error(
        "Relay could not confirm cleanup of every Pi shell process group.",
      );
      context.reportPartial?.({
        content: textParts(partialText()),
        artifacts: [],
        effects: [...effects],
        observedIdentity: terminal?.observedIdentity ?? observed,
        ...(terminal?.usage === undefined ? {} : { usage: terminal.usage }),
      });
      throw new BridgeError(
        {
          code: "harness_failed",
          message: cleanupFailure.message,
          retryable: false,
          details: { cause: protocolError.message },
        },
        { cause: error },
      );
    }
    if (context.signal.aborted) {
      throw abortError();
    }
    context.reportPartial?.({
      content: textParts(partialText()),
      artifacts: [],
      effects: [...effects],
      observedIdentity: terminal?.observedIdentity ?? observed,
      ...(terminal?.usage === undefined ? {} : { usage: terminal.usage }),
    });
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(
      {
        code: "harness_failed",
        message: protocolError.message,
        retryable: false,
        ...(stderrDetail(stderr) === "" ? {} : { details: { workerStderr: stderrDetail(stderr) } }),
      },
      { cause: error },
    );
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    if (cancelTimer !== undefined) {
      clearTimeout(cancelTimer);
    }
    if (child.stdin !== null && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
    await rm(isolationRoot, { recursive: true, force: true });
  }
}
