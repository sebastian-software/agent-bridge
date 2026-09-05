import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AdapterRegistry } from "./adapters/registry.js";
import type { AdapterEvent, AdapterRunResult } from "./adapters/types.js";
import {
  SCHEMA_VERSION,
  TERMINAL_STATES,
  parseEventsParams,
  parseInvocationIdParams,
  parseRespondParams,
  parseWaitParams,
  parseStartInvocationRequest,
  type EventsResult,
  type EffectObservation,
  type InvocationEvent,
  type InvocationOutcome,
  type InvocationRecord,
  type InputResponse,
  type InvocationState,
  type InvocationTombstone,
  type JsonValue,
  type ObservedIdentity,
  type PolicyEvidence,
  type StartInvocationRequest,
  type StartInvocationResult,
  type TerminalStatus,
} from "./contract.js";
import { BridgeError } from "./errors.js";
import { describeContract } from "./operations.js";
import type { BrokerPaths } from "./paths.js";
import { InvocationStore } from "./store.js";
import { captureWorkspaceSnapshot, observeWorkspaceEffects, type WorkspaceSnapshot } from "./effects.js";
import { canonicalJson, messageFrom, sha256 } from "./util.js";

interface MutableResult<T> {
  readonly value: T;
  readonly changed: boolean;
}

function unverifiedIdentity(): ObservedIdentity {
  return {
    provider: { evidence: "unverified" },
    model: { evidence: "unverified" },
    harnessVersion: { evidence: "unverified" },
    nativeSessionId: { evidence: "unverified" },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"));
}

function eventCursor(sequence: number): string {
  return `v1:${sequence}`;
}

function eventAfterCursor(events: readonly InvocationEvent[], cursor: string | undefined): readonly InvocationEvent[] {
  if (cursor === undefined) {
    return events;
  }
  const match = /^v1:(0|[1-9][0-9]*)$/.exec(cursor);
  if (match === null) {
    throw new BridgeError({
      code: "invalid_request",
      message: "The event cursor is invalid for operations contract v1.",
      retryable: false,
    });
  }
  const sequenceText = match[1];
  if (sequenceText === undefined) {
    throw new BridgeError({
      code: "invalid_request",
      message: "The event cursor is missing its sequence.",
      retryable: false,
    });
  }
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence > events.length) {
    throw new BridgeError({
      code: "invalid_request",
      message: "The event cursor is beyond the retained event stream.",
      retryable: false,
      details: { cursor, retainedEventCount: events.length },
    });
  }
  return events.slice(sequence);
}

const MAX_PERSISTED_NATIVE_BYTES = 16 * 1024;

function persistedNative(
  native: Readonly<Record<string, JsonValue>>,
  diagnosticMode: boolean,
): Readonly<Record<string, JsonValue>> {
  const serialized = JSON.stringify(native);
  const byteSize = Buffer.byteLength(serialized, "utf8");
  if (diagnosticMode && byteSize <= MAX_PERSISTED_NATIVE_BYTES) {
    return native;
  }
  const summary: Record<string, JsonValue> = {
    type: typeof native.type === "string" ? native.type : "unknown",
    byteSize,
  };
  for (const key of ["session_id", "model", "subtype", "request_id"] as const) {
    const value = native[key];
    if (typeof value === "string") {
      summary[key] = value;
    }
  }
  if (byteSize > MAX_PERSISTED_NATIVE_BYTES) {
    summary.truncated = true;
  }
  return summary;
}

export class Broker {
  readonly #paths: BrokerPaths;
  readonly #store: InvocationStore;
  readonly #registry: AdapterRegistry;
  readonly #records = new Map<string, InvocationRecord>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #workspaceLocks = new Map<string, string>();
  readonly #beforeSnapshots = new Map<string, WorkspaceSnapshot>();
  readonly #inputWaiters = new Map<string, Map<string, (response: Pick<InputResponse, "decision">) => void>>();
  readonly #inputResponses = new Map<string, Pick<InputResponse, "decision">>();
  readonly #tombstones = new Map<string, InvocationTombstone>();
  readonly #diagnosticMode: boolean;
  readonly #retention: {
    readonly completedMs: number;
    readonly maxBytes: number;
  };
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(paths: BrokerPaths, options?: {
    readonly registry?: AdapterRegistry;
    readonly retention?: {
      readonly completedMs?: number;
      readonly maxBytes?: number;
    };
    readonly diagnosticMode?: boolean;
  }) {
    this.#paths = paths;
    this.#store = new InvocationStore(paths.stateFile);
    this.#registry = options?.registry ?? new AdapterRegistry();
    this.#retention = {
      completedMs: options?.retention?.completedMs ?? 7 * 24 * 60 * 60 * 1000,
      maxBytes: options?.retention?.maxBytes ?? 1_073_741_824,
    };
    this.#diagnosticMode = options?.diagnosticMode ?? false;
  }

  async initialize(): Promise<void> {
    const persisted = await this.#store.load();
    for (const record of persisted.invocations) {
      this.#records.set(record.invocationId, record);
    }
    for (const tombstone of persisted.tombstones) {
      this.#tombstones.set(tombstone.invocationId, tombstone);
    }
    const activeIds = persisted.invocations
      .filter((record) => !TERMINAL_STATES.has(record.state))
      .map((record) => record.invocationId);
    if (activeIds.length === 0) {
      return;
    }
    await this.#mutate(() => {
      const completedAt = new Date().toISOString();
      for (const invocationId of activeIds) {
        const current = this.#requireRecord(invocationId);
        const withEvent = this.#appendBridgeEvent(current, "lifecycle", {
          state: "interrupted",
          reason: "broker_restart",
        }, completedAt);
        const outcome = this.#outcome(withEvent, "interrupted", completedAt, {
          observedIdentity: unverifiedIdentity(),
          effectObservation: { complete: false, diagnostics: ["Broker restart ended the active invocation before its after-snapshot."] },
          error: {
            code: "broker_restarted",
            message: "The broker restarted while this invocation was active.",
          },
        });
        this.#records.set(invocationId, {
          ...withEvent,
          state: "interrupted",
          updatedAt: completedAt,
          outcome,
        });
      }
      return { value: undefined, changed: true };
    });
  }

  async close(): Promise<void> {
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled(this.#runs.values());
    await this.#mutationTail;
    this.#inputWaiters.clear();
    this.#inputResponses.clear();
  }

  async execute(operation: string, params: unknown): Promise<unknown> {
    switch (operation) {
      case "system.describe":
        return this.describe();
      case "system.shutdown":
        return { accepted: true };
      case "system.status":
        return this.status();
      case "route.discover":
        return { routes: await this.#registry.discover() };
      case "invocation.start":
        return this.start(parseStartInvocationRequest(params));
      case "invocation.inspect":
        return this.inspect(parseInvocationIdParams(params).invocationId);
      case "invocation.get":
        return this.inspect(parseInvocationIdParams(params).invocationId);
      case "invocation.result":
        return this.result(parseInvocationIdParams(params).invocationId);
      case "invocation.wait": {
        const wait = parseWaitParams(params);
        return this.wait(wait.invocationId, wait.timeoutMs);
      }
      case "invocation.events":
        return this.events(parseEventsParams(params));
      case "invocation.cancel":
        return this.cancel(parseInvocationIdParams(params).invocationId);
      case "invocation.respond":
        return this.respond(parseRespondParams(params));
      case "invocation.send":
      case "invocation.continue":
      case "invocation.delete":
        throw new BridgeError({
          code: "unsupported_operation",
          message: `${operation} is part of operations contract v1 but is not implemented in this slice.`,
          retryable: false,
        });
      default:
        throw new BridgeError({
          code: "unsupported_operation",
          message: `Unknown operation: ${operation}`,
          retryable: false,
        });
    }
  }

  describe(): Readonly<Record<string, unknown>> {
    return {
      ...describeContract(),
      broker: {
        platform: process.platform,
        pid: process.pid,
        socketPath: this.#paths.socketPath,
        stateFile: this.#store.path,
      },
      retention: {
        completedDays: this.#retention.completedMs / (24 * 60 * 60 * 1000),
        completedBytes: this.#retention.maxBytes,
        evictionGranularity: "invocation",
        implemented: true,
        tombstones: true,
        workspaceConcurrency: "reject",
      },
      diagnostics: {
        diagnosticMode: this.#diagnosticMode,
        nativePayloadMaxBytes: MAX_PERSISTED_NATIVE_BYTES,
      },
    };
  }

  status(): Readonly<Record<string, unknown>> {
    const records = [...this.#records.values()];
    return {
      ready: true,
      pid: process.pid,
      platform: process.platform,
      socketPath: this.#paths.socketPath,
      stateFile: this.#store.path,
      activeInvocations: records.filter((record) => !TERMINAL_STATES.has(record.state)).length,
      retainedInvocations: records.length,
      tombstones: this.#tombstones.size,
      diagnosticMode: this.#diagnosticMode,
    };
  }

  async start(request: StartInvocationRequest): Promise<StartInvocationResult> {
    if (!isAbsolute(request.workingDirectory)) {
      throw new BridgeError({
        code: "invalid_request",
        message: "workingDirectory must be an absolute path.",
        retryable: false,
      });
    }
    let workspaceStat;
    try {
      workspaceStat = await stat(request.workingDirectory);
    } catch (error) {
      throw new BridgeError({
        code: "invalid_request",
        message: "workingDirectory does not exist or cannot be inspected.",
        retryable: false,
        details: { workingDirectory: request.workingDirectory },
      }, { cause: error });
    }
    if (!workspaceStat.isDirectory()) {
      throw new BridgeError({
        code: "invalid_request",
        message: "workingDirectory must refer to a directory.",
        retryable: false,
      });
    }

    const requestDigest = sha256(canonicalJson(request));
    const existing = await this.#existingIdempotent(request.idempotencyKey, requestDigest);
    if (existing !== undefined) {
      return this.#startResult(existing, true);
    }

    const { route, descriptor, effectiveNativePolicy } = await this.#registry.resolve(request);
    const invocationId = `inv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    let workspaceKey: string;
    try {
      workspaceKey = await realpath(request.workingDirectory);
    } catch {
      workspaceKey = resolve(request.workingDirectory);
    }
    const policy: PolicyEvidence = {
      requestedPolicy: request.requestedPolicy,
      effectiveNativePolicy,
      assurance: descriptor.assurance,
    };

    const result = await this.#mutate(() => {
      const deduplicated = this.#findIdempotent(request.idempotencyKey, requestDigest);
      if (deduplicated !== undefined) {
        return { value: this.#startResult(deduplicated, true), changed: false };
      }
      const lockOwner = this.#workspaceLocks.get(workspaceKey);
      if (lockOwner !== undefined) {
        throw new BridgeError({
          code: "invocation_conflict",
          message: "Another active invocation already owns this working directory.",
          retryable: false,
          details: { workingDirectory: workspaceKey, invocationId: lockOwner },
        });
      }
      const base: InvocationRecord = {
        schemaVersion: SCHEMA_VERSION,
        invocationId,
        ...(request.callerCorrelationId === undefined ? {} : { callerCorrelationId: request.callerCorrelationId }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        requestDigest,
        request,
        resolvedRoute: route,
        policy,
        state: "queued",
        createdAt,
        updatedAt: createdAt,
        events: [],
      };
      const record = this.#appendBridgeEvent(base, "lifecycle", { state: "queued" }, createdAt);
      this.#records.set(invocationId, record);
      this.#workspaceLocks.set(workspaceKey, invocationId);
      return { value: this.#startResult(record, false), changed: true };
    });

    if (!result.deduplicated) {
      this.#beforeSnapshots.set(invocationId, await captureWorkspaceSnapshot(request.workingDirectory));
      this.#launch(invocationId);
    }
    return result;
  }

  async inspect(invocationId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#mutationTail;
    const record = this.#requireRecord(invocationId);
    const lastEvent = record.events.at(-1);
    return {
      schemaVersion: SCHEMA_VERSION,
      invocationId: record.invocationId,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.callerCorrelationId === undefined ? {} : { callerCorrelationId: record.callerCorrelationId }),
      requested: record.request.selector,
      resolved: record.resolvedRoute,
      policy: record.policy,
      eventCount: record.events.length,
      ...(lastEvent === undefined ? {} : { lastCursor: lastEvent.cursor }),
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      next: TERMINAL_STATES.has(record.state)
        ? ["invocation.events"]
        : ["invocation.events", "invocation.cancel"],
    };
  }

  async result(invocationId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#mutationTail;
    const record = this.#requireRecord(invocationId);
    if (!TERMINAL_STATES.has(record.state) || record.outcome === undefined) {
      throw new BridgeError({
        code: "invocation_not_active",
        message: `Invocation ${invocationId} has no terminal result yet.`,
        retryable: true,
      });
    }
    return {
      invocationId,
      state: record.state,
      outcome: record.outcome,
    };
  }

  async wait(invocationId: string, timeoutMs = 30_000): Promise<Readonly<Record<string, unknown>>> {
    const deadline = Date.now() + timeoutMs;
    let after: string | undefined;
    while (true) {
      const inspected = await this.inspect(invocationId);
      const record = this.#records.get(invocationId);
      if (record !== undefined && TERMINAL_STATES.has(record.state)) {
        return { ...inspected, waited: true };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ...inspected, waited: false };
      }
      const page = await this.events({
        invocationId,
        ...(after === undefined ? {} : { after }),
        waitMs: Math.min(30_000, remaining),
      });
      after = page.nextCursor ?? after;
      if (page.terminal) {
        return { ...(await this.inspect(invocationId)), waited: true };
      }
    }
  }

  async events(params: {
    readonly invocationId: string;
    readonly after?: string;
    readonly waitMs?: number;
  }): Promise<EventsResult> {
    const deadline = Date.now() + (params.waitMs ?? 0);
    while (true) {
      await this.#mutationTail;
      const record = this.#requireRecord(params.invocationId);
      const events = eventAfterCursor(record.events, params.after);
      if (events.length > 0 || TERMINAL_STATES.has(record.state) || Date.now() >= deadline) {
        const lastEvent = events.at(-1);
        return {
          invocationId: record.invocationId,
          state: record.state,
          events,
          ...(lastEvent === undefined ? {} : { nextCursor: lastEvent.cursor }),
          terminal: TERMINAL_STATES.has(record.state),
        };
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  async cancel(invocationId: string): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return {
          value: { invocationId, state: current.state, accepted: false, terminal: true },
          changed: false,
        };
      }
      if (current.state === "cancelling") {
        return {
          value: { invocationId, state: current.state, accepted: true, terminal: false },
          changed: false,
        };
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(current, "lifecycle", {
        state: "cancelling",
        reason: "caller_request",
      }, timestamp);
      this.#records.set(invocationId, {
        ...withEvent,
        state: "cancelling",
        updatedAt: timestamp,
      });
      return {
        value: { invocationId, state: "cancelling", accepted: true, terminal: false },
        changed: true,
      };
    });
    this.#controllers.get(invocationId)?.abort();
    return result;
  }

  #launch(invocationId: string): void {
    const run = this.#runInvocation(invocationId)
      .catch(async (error: unknown) => {
        try {
          await this.#failUnexpected(invocationId, error);
        } catch (nested) {
          process.emitWarning(`Failed to record invocation crash: ${messageFrom(nested)}`);
        }
      })
      .finally(() => {
        this.#runs.delete(invocationId);
      });
    this.#runs.set(invocationId, run);
  }

  async #runInvocation(invocationId: string): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(invocationId, controller);
    const startedAt = new Date().toISOString();
    const shouldRun = await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (current.state === "cancelling") {
        return { value: false, changed: false };
      }
      if (current.state !== "queued") {
        return { value: false, changed: false };
      }
      const withEvent = this.#appendBridgeEvent(current, "lifecycle", { state: "running" }, startedAt);
      this.#records.set(invocationId, {
        ...withEvent,
        state: "running",
        startedAt,
        updatedAt: startedAt,
      });
      return { value: true, changed: true };
    });
    if (!shouldRun) {
      await this.#complete(invocationId, "cancelled", {
        observedIdentity: unverifiedIdentity(),
        effectObservation: { complete: false, diagnostics: ["Invocation was cancelled before an effect snapshot could be collected."] },
        error: { code: "cancelled", message: "The invocation was cancelled before the adapter started." },
      });
      this.#controllers.delete(invocationId);
      return;
    }

    const current = this.#requireRecord(invocationId);
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    if (current.request.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        this.#markTimingOut(invocationId).then(
          () => controller.abort(),
          (error: unknown) => process.emitWarning(`Failed to record invocation timeout: ${messageFrom(error)}`),
        );
      }, current.request.timeoutMs);
      timeout.unref();
    }

    try {
      const adapter = this.#registry.adapter(current.resolvedRoute.adapter);
      const result = await adapter.run({
        invocationId,
        request: current.request,
        route: current.resolvedRoute,
        signal: controller.signal,
        emit: (event) => this.#appendAdapterEvent(invocationId, event),
        awaitInput: (requestId, signal) => this.#awaitInput(invocationId, requestId, signal),
      });
      const latest = this.#requireRecord(invocationId);
      if (latest.state === "cancelling" || controller.signal.aborted) {
        await this.#complete(invocationId, timedOut ? "timed_out" : "cancelled", {
          observedIdentity: result.observedIdentity,
          error: {
            code: timedOut ? "timed_out" : "cancelled",
            message: timedOut ? "The invocation exceeded its timeout." : "The invocation was cancelled.",
          },
        });
      } else {
        await this.#complete(invocationId, "succeeded", result);
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        await this.#complete(invocationId, timedOut ? "timed_out" : "cancelled", {
          observedIdentity: unverifiedIdentity(),
          error: {
            code: timedOut ? "timed_out" : "cancelled",
            message: timedOut ? "The invocation exceeded its timeout." : "The invocation was cancelled.",
          },
        });
      } else {
        const errorCode = error instanceof BridgeError ? error.code : "adapter_failed";
        await this.#complete(invocationId, "failed", {
          observedIdentity: unverifiedIdentity(),
          error: { code: errorCode, message: messageFrom(error) },
        });
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.#controllers.delete(invocationId);
      this.#inputWaiters.delete(invocationId);
    }
  }

  async #markTimingOut(invocationId: string): Promise<void> {
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state) || current.state === "cancelling") {
        return { value: undefined, changed: false };
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(current, "lifecycle", {
        state: "cancelling",
        reason: "timeout",
      }, timestamp);
      this.#records.set(invocationId, {
        ...withEvent,
        state: "cancelling",
        updatedAt: timestamp,
      });
      return { value: undefined, changed: true };
    });
  }

  async #appendAdapterEvent(invocationId: string, event: AdapterEvent): Promise<void> {
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return { value: undefined, changed: false };
      }
      const timestamp = new Date().toISOString();
      const sequence = current.events.length + 1;
      const appended: InvocationEvent = {
        schemaVersion: SCHEMA_VERSION,
        invocationId,
        sequence,
        cursor: eventCursor(sequence),
        timestamp,
        category: event.category,
        ...(event.content === undefined ? {} : { content: event.content }),
        ...(event.data === undefined && event.inputRequest === undefined ? {} : {
          data: {
            ...(event.data ?? {}),
            ...(event.inputRequest === undefined ? {} : {
              requestId: event.inputRequest.requestId,
              kind: event.inputRequest.kind,
              prompt: event.inputRequest.prompt,
              ...(event.inputRequest.toolName === undefined ? {} : { toolName: event.inputRequest.toolName }),
            }),
          },
        }),
        provenance: { source: "adapter", adapter: current.resolvedRoute.adapter },
        ...(event.native === undefined ? {} : { native: persistedNative(event.native, this.#diagnosticMode) }),
      };
      let updated: InvocationRecord = {
        ...current,
        ...(event.category === "input_required" ? { state: "waiting_for_input" as const } : {}),
        updatedAt: timestamp,
        events: [...current.events, appended],
      };
      for (const effect of event.effects ?? []) {
        updated = this.#appendBridgeEvent(updated, "effect", {
          path: effect.path,
          ...(effect.previousPath === undefined ? {} : { previousPath: effect.previousPath }),
          kind: effect.kind,
          evidence: effect.evidence,
        }, timestamp);
      }
      this.#records.set(invocationId, updated);
      return { value: undefined, changed: true };
    });
  }

  async respond(response: InputResponse): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#mutate(() => {
      const current = this.#requireRecord(response.invocationId);
      if (current.state !== "waiting_for_input") {
        throw new BridgeError({
          code: "invocation_not_active",
          message: `Invocation ${response.invocationId} is not waiting for input.`,
          retryable: false,
        });
      }
      const pendingRequest = [...current.events]
        .reverse()
        .find((event) => event.category === "input_required");
      if (pendingRequest?.data?.requestId !== response.requestId) {
        throw new BridgeError({
          code: "invalid_request",
          message: `Request ${response.requestId} is not the pending input request for invocation ${response.invocationId}.`,
          retryable: false,
          details: { invocationId: response.invocationId, requestId: response.requestId },
        });
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(current, "lifecycle", {
        state: "running",
        reason: "caller_response",
        requestId: response.requestId,
        decision: response.decision,
      }, timestamp);
      this.#records.set(response.invocationId, {
        ...withEvent,
        state: "running",
        updatedAt: timestamp,
      });
      return {
        value: { invocationId: response.invocationId, requestId: response.requestId, accepted: true, state: "running" },
        changed: true,
      };
    });
    const key = `${response.invocationId}:${response.requestId}`;
    const waiter = this.#inputWaiters.get(response.invocationId)?.get(response.requestId);
    if (waiter !== undefined) {
      this.#inputWaiters.get(response.invocationId)?.delete(response.requestId);
      waiter({ decision: response.decision });
    } else {
      this.#inputResponses.set(key, { decision: response.decision });
    }
    return result;
  }

  async #awaitInput(invocationId: string, requestId: string, signal?: AbortSignal): Promise<Pick<InputResponse, "decision">> {
    const key = `${invocationId}:${requestId}`;
    const response = this.#inputResponses.get(key);
    if (response !== undefined) {
      this.#inputResponses.delete(key);
      return response;
    }
    return new Promise((resolve) => {
      const waiters = this.#inputWaiters.get(invocationId) ?? new Map();
      const finish = (decision: Pick<InputResponse, "decision">): void => {
        waiters.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = (): void => finish({ decision: "deny" });
      waiters.set(requestId, finish);
      this.#inputWaiters.set(invocationId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  async #complete(
    invocationId: string,
    status: TerminalStatus,
    result: Partial<AdapterRunResult> & {
      readonly observedIdentity: ObservedIdentity;
      readonly effectObservation?: EffectObservation;
      readonly error?: InvocationOutcome["error"];
    },
  ): Promise<void> {
    const current = this.#records.get(invocationId);
    const afterSnapshot = current === undefined
      ? undefined
      : await captureWorkspaceSnapshot(current.request.workingDirectory);
    const observed = await observeWorkspaceEffects(this.#beforeSnapshots.get(invocationId), afterSnapshot ?? {
      root: current?.request.workingDirectory ?? "",
      files: new Map(),
      complete: false,
      diagnostics: ["Invocation record was not available for effect observation."],
    });
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return { value: undefined, changed: false };
      }
      const completedAt = new Date().toISOString();
      const allEffects = [...(result.effects ?? []), ...observed.effects];
      let withEvent = current;
      for (const effect of observed.effects) {
        withEvent = this.#appendBridgeEvent(withEvent, "effect", {
          path: effect.path,
          ...(effect.previousPath === undefined ? {} : { previousPath: effect.previousPath }),
          kind: effect.kind,
          evidence: effect.evidence,
        }, completedAt);
      }
      withEvent = this.#appendBridgeEvent(withEvent, "lifecycle", { state: status }, completedAt);
      const outcome = this.#outcome(withEvent, status, completedAt, {
        ...result,
        effects: allEffects,
        effectObservation: result.effectObservation ?? {
          complete: observed.complete,
          diagnostics: observed.diagnostics,
        },
      });
      this.#records.set(invocationId, {
        ...withEvent,
        state: status,
        updatedAt: completedAt,
        outcome,
      });
      for (const [workspace, owner] of this.#workspaceLocks) {
        if (owner === invocationId) {
          this.#workspaceLocks.delete(workspace);
        }
      }
      this.#beforeSnapshots.delete(invocationId);
      return { value: undefined, changed: true };
    });
  }

  #outcome(
    record: InvocationRecord,
    status: TerminalStatus,
    completedAt: string,
    result: Partial<AdapterRunResult> & {
      readonly observedIdentity: ObservedIdentity;
      readonly effectObservation?: EffectObservation;
      readonly error?: InvocationOutcome["error"];
    },
  ): InvocationOutcome {
    const durationMs = record.startedAt === undefined
      ? undefined
      : Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt));
    return {
      schemaVersion: SCHEMA_VERSION,
      invocationId: record.invocationId,
      status,
      content: result.content ?? [],
      artifacts: result.artifacts ?? [],
      effects: result.effects ?? [],
      effectObservation: result.effectObservation ?? { complete: true, diagnostics: [] },
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      observedIdentity: result.observedIdentity,
      policy: record.policy,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      completedAt,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  async #failUnexpected(invocationId: string, error: unknown): Promise<void> {
    const record = this.#records.get(invocationId);
    if (record === undefined || TERMINAL_STATES.has(record.state)) {
      return;
    }
    await this.#complete(invocationId, "failed", {
      observedIdentity: unverifiedIdentity(),
      error: { code: "broker_internal_error", message: messageFrom(error) },
    });
  }

  #appendBridgeEvent(
    record: InvocationRecord,
    category: InvocationEvent["category"],
    data: NonNullable<InvocationEvent["data"]>,
    timestamp: string,
  ): InvocationRecord {
    const sequence = record.events.length + 1;
    const event: InvocationEvent = {
      schemaVersion: SCHEMA_VERSION,
      invocationId: record.invocationId,
      sequence,
      cursor: eventCursor(sequence),
      timestamp,
      category,
      data,
      provenance: { source: "bridge" },
    };
    return {
      ...record,
      events: [...record.events, event],
      updatedAt: timestamp,
    };
  }

  #startResult(record: InvocationRecord, deduplicated: boolean): StartInvocationResult {
    return {
      invocationId: record.invocationId,
      state: record.state,
      deduplicated,
      next: ["invocation.inspect", "invocation.events", "invocation.cancel"],
    };
  }

  async #existingIdempotent(idempotencyKey: string | undefined, digest: string): Promise<InvocationRecord | undefined> {
    await this.#mutationTail;
    return this.#findIdempotent(idempotencyKey, digest);
  }

  #findIdempotent(idempotencyKey: string | undefined, digest: string): InvocationRecord | undefined {
    if (idempotencyKey === undefined) {
      return undefined;
    }
    const record = [...this.#records.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (record === undefined) {
      return undefined;
    }
    if (record.requestDigest !== digest) {
      throw new BridgeError({
        code: "invocation_conflict",
        message: "The idempotency key is already bound to a different start request.",
        retryable: false,
        details: { idempotencyKey, invocationId: record.invocationId },
      });
    }
    return record;
  }

  #requireRecord(invocationId: string): InvocationRecord {
    const record = this.#records.get(invocationId);
    if (record === undefined) {
      const tombstone = this.#tombstones.get(invocationId);
      if (tombstone !== undefined) {
        throw new BridgeError({
          code: "invocation_evicted",
          message: `Invocation ${invocationId} was evicted by retention policy.`,
          retryable: false,
          details: { ...tombstone },
        });
      }
      throw new BridgeError({
        code: "invocation_not_found",
        message: `Invocation ${invocationId} was not found.`,
        retryable: false,
      });
    }
    return record;
  }

  async #mutate<T>(mutation: () => MutableResult<T>): Promise<T> {
    const scheduled = this.#mutationTail.then(async () => {
      const result = mutation();
      if (result.changed) {
        this.#applyRetention();
        await this.#store.save([...this.#records.values()], [...this.#tombstones.values()]);
      }
      return result.value;
    });
    this.#mutationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  #applyRetention(): void {
    const now = Date.now();
    const candidates = [...this.#records.values()]
      .filter((record) => TERMINAL_STATES.has(record.state) && record.outcome !== undefined)
      .sort((left, right) => Date.parse(left.outcome?.completedAt ?? left.updatedAt)
        - Date.parse(right.outcome?.completedAt ?? right.updatedAt));
    const evict = (record: InvocationRecord): void => {
      this.#records.delete(record.invocationId);
      this.#tombstones.set(record.invocationId, {
        invocationId: record.invocationId,
        evictedAt: new Date(now).toISOString(),
        reason: "retention",
      });
    };

    for (const record of candidates) {
      const completedAt = Date.parse(record.outcome?.completedAt ?? record.updatedAt);
      if (Number.isFinite(completedAt) && now - completedAt >= this.#retention.completedMs) {
        evict(record);
      }
    }

    const serializedSize = (): number => Buffer.byteLength(JSON.stringify({
      storageVersion: 1,
      invocations: [...this.#records.values()],
      tombstones: [...this.#tombstones.values()],
    }, null, 2), "utf8");
    for (const record of candidates) {
      if (!this.#records.has(record.invocationId) || serializedSize() <= this.#retention.maxBytes) {
        continue;
      }
      evict(record);
    }
  }
}
