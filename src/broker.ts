import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AdapterRegistry } from "./adapters/registry.js";
import type { AdapterEvent, AdapterRunResult } from "./adapters/types.js";
import {
  SCHEMA_VERSION,
  TERMINAL_STATES,
  parseEventsParams,
  parseInvocationIdParams,
  parseStartInvocationRequest,
  type EventsResult,
  type InvocationEvent,
  type InvocationOutcome,
  type InvocationRecord,
  type InvocationState,
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

export class Broker {
  readonly #paths: BrokerPaths;
  readonly #store: InvocationStore;
  readonly #registry: AdapterRegistry;
  readonly #records = new Map<string, InvocationRecord>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #runs = new Map<string, Promise<void>>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(paths: BrokerPaths, options?: { readonly registry?: AdapterRegistry }) {
    this.#paths = paths;
    this.#store = new InvocationStore(paths.stateFile);
    this.#registry = options?.registry ?? new AdapterRegistry();
  }

  async initialize(): Promise<void> {
    const persisted = await this.#store.load();
    for (const record of persisted) {
      this.#records.set(record.invocationId, record);
    }
    const activeIds = persisted
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
  }

  async execute(operation: string, params: unknown): Promise<unknown> {
    switch (operation) {
      case "system.describe":
        return this.describe();
      case "system.shutdown":
        return { accepted: true };
      case "route.discover":
        return { routes: await this.#registry.discover() };
      case "invocation.start":
        return this.start(parseStartInvocationRequest(params));
      case "invocation.inspect":
        return this.inspect(parseInvocationIdParams(params).invocationId);
      case "invocation.events":
        return this.events(parseEventsParams(params));
      case "invocation.cancel":
        return this.cancel(parseInvocationIdParams(params).invocationId);
      case "invocation.send":
      case "invocation.respond":
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
        completedDays: 7,
        completedBytes: 1_073_741_824,
        evictionGranularity: "invocation",
        implemented: false,
      },
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

    const { route, descriptor } = await this.#registry.resolve(request);
    const invocationId = `inv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const policy: PolicyEvidence = {
      requestedPolicy: request.requestedPolicy,
      effectiveNativePolicy: {
        adapter: descriptor.adapter,
        controls: [],
      },
      assurance: descriptor.assurance,
    };

    const result = await this.#mutate(() => {
      const deduplicated = this.#findIdempotent(request.idempotencyKey, requestDigest);
      if (deduplicated !== undefined) {
        return { value: this.#startResult(deduplicated, true), changed: false };
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
      return { value: this.#startResult(record, false), changed: true };
    });

    if (!result.deduplicated) {
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
        ...(event.data === undefined ? {} : { data: event.data }),
        provenance: { source: "adapter", adapter: current.resolvedRoute.adapter },
        ...(event.native === undefined ? {} : { native: event.native }),
      };
      this.#records.set(invocationId, {
        ...current,
        updatedAt: timestamp,
        events: [...current.events, appended],
      });
      return { value: undefined, changed: true };
    });
  }

  async #complete(
    invocationId: string,
    status: TerminalStatus,
    result: Partial<AdapterRunResult> & {
      readonly observedIdentity: ObservedIdentity;
      readonly error?: InvocationOutcome["error"];
    },
  ): Promise<void> {
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return { value: undefined, changed: false };
      }
      const completedAt = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(current, "lifecycle", { state: status }, completedAt);
      const outcome = this.#outcome(withEvent, status, completedAt, result);
      this.#records.set(invocationId, {
        ...withEvent,
        state: status,
        updatedAt: completedAt,
        outcome,
      });
      return { value: undefined, changed: true };
    });
  }

  #outcome(
    record: InvocationRecord,
    status: TerminalStatus,
    completedAt: string,
    result: Partial<AdapterRunResult> & {
      readonly observedIdentity: ObservedIdentity;
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
        await this.#store.save([...this.#records.values()]);
      }
      return result.value;
    });
    this.#mutationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }
}
