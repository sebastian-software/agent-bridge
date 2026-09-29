import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Adapter,
  AdapterEvent,
  AdapterInputResult,
  AdapterRunContext,
  AdapterRunResult,
  AdapterSendInputContext,
} from "./adapters/types.js";
import type { AdapterConnectionContext, HarnessConnection } from "./connections.js";
import type { BrokerPaths } from "./paths.js";

import { inspectNativeContextDirectory } from "./adapters/environment.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { type BrokerConfig, brokerConfigFromValues, type BrokerConfigValues } from "./config.js";
import {
  createHarnessConnection,
  loadUserConnections,
  mutateUserConnections,
  summarizeConnection,
  updateHarnessConnection,
} from "./connections.js";
import {
  type AnswerInputRequest,
  type ConnectionDiscoverResult,
  type ConnectionInspection,
  type ConnectionPrepareResult,
  type ContentPart,
  type ContinueInvocationRequest,
  type EffectObservation,
  type EventsResult,
  type InputResponse,
  type InvocationEvent,
  type InvocationListResult,
  type InvocationOutcome,
  type InvocationRecord,
  type InvocationState,
  type InvocationTombstone,
  type JsonValue,
  type ObservedIdentity,
  parseAnswerParams,
  parseConnectionDiscoverParams,
  parseConnectionIdParams,
  parseConnectionPrepareParams,
  parseConnectionRegisterParams,
  parseConnectionRemoveParams,
  parseConnectionUpdateParams,
  parseContinueInvocationParams,
  parseEventsParams,
  parseInvocationIdParams,
  parseInvocationListParams,
  parseRespondParams,
  parseRouteDiscoverParams,
  parseSendInvocationParams,
  parseShutdownParams,
  parseStartInvocationRequest,
  parseWaitParams,
  type PolicyEvidence,
  SCHEMA_VERSION,
  type SendInvocationRequest,
  type SendInvocationResult,
  type StartInvocationRequest,
  type StartInvocationResult,
  TERMINAL_STATES,
  type TerminalStatus,
  type Usage,
} from "./contract.js";
import {
  captureWorkspaceSnapshot,
  normalizeHarnessEffect,
  observeWorkspaceEffects,
  type WorkspaceSnapshot,
} from "./effects.js";
import { BridgeError } from "./errors.js";
import { writeBrokerLog } from "./log.js";
import { describeContract } from "./operations.js";
import { ensurePrivateDirectory } from "./paths.js";
import { InvocationStore, type StoredAcceptedInput, type StoredInvocationRecord } from "./store.js";
import { canonicalJson, messageFrom, sha256 } from "./util.js";
import { PACKAGE_VERSION } from "./version.js";

type MutableResult<T> = {
  readonly value: T;
  readonly changed: boolean;
};

type QuestionWaiter = {
  readonly resolve: (answer: readonly ContentPart[]) => void;
  readonly reject: (error: unknown) => void;
};

function unverifiedIdentity(): ObservedIdentity {
  return {
    provider: { evidence: "unverified" },
    model: { evidence: "unverified" },
    harnessVersion: { evidence: "unverified" },
    nativeSessionId: { evidence: "unverified" },
  };
}

function sameConnectionInput(left: HarnessConnection, right: HarnessConnection): boolean {
  return (
    left.id === right.id &&
    left.harness === right.harness &&
    left.nativeContextRef === right.nativeContextRef &&
    left.purpose === right.purpose
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"))
  );
}

function invocationCancelledError(): Error {
  const error = new Error("The invocation was cancelled.");
  error.name = "AbortError";
  return error;
}

function eventCursor(sequence: number): string {
  return `v1:${sequence}`;
}

function eventAfterCursor(
  events: readonly InvocationEvent[],
  cursor: string | undefined,
): readonly InvocationEvent[] {
  if (cursor === undefined) {
    return events;
  }
  const match = /^v1:(0|[1-9]\d*)$/.exec(cursor);
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

function isEffectOnlyCarrier(event: AdapterEvent): boolean {
  return (
    event.category === "effect" &&
    (event.effects?.length ?? 0) > 0 &&
    (event.content === undefined || event.content.length === 0) &&
    (event.data === undefined || Object.keys(event.data).length === 0) &&
    event.usage === undefined &&
    event.failure === undefined &&
    event.inputRequest === undefined
  );
}

function numberValue(candidate: JsonValue | undefined): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function usageFromEvent(value: JsonValue | undefined): undefined | Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, JsonValue>;
  const inputTokens = numberValue(source.inputTokens);
  const outputTokens = numberValue(source.outputTokens);
  const cacheReadTokens = numberValue(source.cacheReadTokens);
  const cacheWriteTokens = numberValue(source.cacheWriteTokens);
  const turns = numberValue(source.turns);
  const costUsd = numberValue(source.costUsd);
  if (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns, costUsd].every(
      (item) => item === undefined,
    )
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(turns === undefined ? {} : { turns }),
    ...(costUsd === undefined ? {} : { costUsd }),
    evidence: "reported",
    source: typeof source.source === "string" ? source.source : "persisted-event",
  };
}

export class Broker {
  readonly #paths: BrokerPaths;
  readonly #store: InvocationStore;
  readonly #registry: AdapterRegistry;
  readonly #records = new Map<string, StoredInvocationRecord>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #connectionContexts = new Map<string, AdapterConnectionContext>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #completing = new Set<string>();
  readonly #adapterReady = new Set<string>();
  readonly #inputDeliveryRuns = new Map<string, Promise<void>>();
  readonly #inputDeliveryControllers = new Map<string, AbortController>();
  readonly #workspaceLocks = new Map<string, string>();
  readonly #beforeSnapshots = new Map<string, WorkspaceSnapshot>();
  readonly #inputWaiters = new Map<
    string,
    Map<string, (response: Pick<InputResponse, "decision">) => void>
  >();
  readonly #inputResponses = new Map<string, Pick<InputResponse, "decision">>();
  readonly #questionWaiters = new Map<string, Map<string, QuestionWaiter>>();
  readonly #questionResponses = new Map<string, readonly ContentPart[]>();
  readonly #tombstones = new Map<string, InvocationTombstone>();
  readonly #diagnosticMode: boolean;
  readonly #config: BrokerConfig;
  #shutdownRequested = false;
  readonly #retention: {
    readonly completedMs: number;
    readonly maxBytes: number;
  };
  readonly #effectLimits: { readonly maxFiles: number; readonly maxBytes: number };
  readonly #terminationGraceMs: number;
  readonly #logFile: string;
  readonly #startedAt = new Date().toISOString();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    paths: BrokerPaths,
    options?: {
      readonly registry?: AdapterRegistry;
      readonly config?: BrokerConfig;
      readonly retention?: {
        readonly completedMs?: number;
        readonly maxBytes?: number;
      };
      readonly diagnosticMode?: boolean;
      readonly logFile?: string;
    },
  ) {
    this.#paths = paths;
    this.#store = new InvocationStore(paths.stateFile);
    this.#registry = options?.registry ?? new AdapterRegistry();
    const compatibility: Partial<BrokerConfigValues> = {
      ...(options?.retention?.completedMs === undefined
        ? {}
        : { retentionCompletedDays: options.retention.completedMs / (24 * 60 * 60 * 1000) }),
      ...(options?.retention?.maxBytes === undefined
        ? {}
        : { retentionMaxBytes: options.retention.maxBytes }),
      ...(options?.diagnosticMode === undefined ? {} : { diagnosticMode: options.diagnosticMode }),
    };
    this.#config = options?.config ?? brokerConfigFromValues(compatibility);
    this.#retention = {
      completedMs: this.#config.retentionCompletedDays * 24 * 60 * 60 * 1000,
      maxBytes: this.#config.retentionMaxBytes,
    };
    this.#diagnosticMode = this.#config.diagnosticMode;
    this.#effectLimits = {
      maxFiles: this.#config.effectsMaxFiles,
      maxBytes: this.#config.effectsMaxBytes,
    };
    this.#terminationGraceMs = this.#config.terminationGraceMs;
    this.#logFile = options?.logFile ?? `${paths.stateDirectory}/broker.log`;
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#store.directory, "state");
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
      this.#releaseCompletedEvents();
      return;
    }
    await this.#mutate(() => {
      const completedAt = new Date().toISOString();
      for (const invocationId of activeIds) {
        const current = this.#requireRecord(invocationId);
        const expired = this.#expirePendingInputs(current, "broker_restart", completedAt);
        const withEvent = this.#appendBridgeEvent(
          expired,
          "lifecycle",
          {
            state: "interrupted",
            reason: "broker_restart",
          },
          completedAt,
        );
        const outcome = this.#outcome(withEvent, "interrupted", completedAt, {
          observedIdentity: unverifiedIdentity(),
          effectObservation: {
            complete: false,
            diagnostics: ["Broker restart ended the active invocation before its after-snapshot."],
          },
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
    await Promise.allSettled([...this.#runs.values(), ...this.#inputDeliveryRuns.values()]);
    await this.#mutationTail;
    this.#inputWaiters.clear();
    this.#inputResponses.clear();
    this.#questionWaiters.clear();
    this.#questionResponses.clear();
    this.#adapterReady.clear();
    this.#inputDeliveryRuns.clear();
    this.#inputDeliveryControllers.clear();
  }

  async execute(operation: string, params: unknown): Promise<unknown> {
    switch (operation) {
      case "system.describe":
        return this.describe();
      case "system.shutdown":
        return this.shutdown(parseShutdownParams(params).force);
      case "system.status":
        return this.status();
      case "route.discover":
        return { routes: await this.#registry.discover(parseRouteDiscoverParams(params)) };
      case "connection.discover":
        return this.#connectionDiscover(parseConnectionDiscoverParams(params));
      case "connection.list":
        return this.#connectionList();
      case "connection.inspect":
        return this.#connectionInspect(parseConnectionIdParams(params).id);
      case "connection.register":
        return this.#connectionRegister(parseConnectionRegisterParams(params));
      case "connection.prepare":
        return this.#connectionPrepare(parseConnectionPrepareParams(params));
      case "connection.update":
        return this.#connectionUpdate(parseConnectionUpdateParams(params));
      case "connection.remove":
        return this.#connectionRemove(parseConnectionRemoveParams(params));
      case "invocation.start":
        return this.start(parseStartInvocationRequest(params));
      case "invocation.inspect":
        return this.inspect(parseInvocationIdParams(params).invocationId);
      case "invocation.list":
        return this.list(parseInvocationListParams(params));
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
      case "invocation.answer":
        return this.answer(parseAnswerParams(params));
      case "invocation.send":
        return this.send(parseSendInvocationParams(params));
      case "invocation.continue":
        return this.continue(parseContinueInvocationParams(params));
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

  async #connectionDiscover(
    params: ReturnType<typeof parseConnectionDiscoverParams>,
  ): Promise<ConnectionDiscoverResult> {
    const snapshot = await loadUserConnections(this.#registry.connectionsPath);
    const routes = await this.#registry.discover({ refresh: params.refresh });
    const current = await loadUserConnections(this.#registry.connectionsPath);
    if (JSON.stringify(snapshot) !== JSON.stringify(current)) {
      throw new BridgeError({
        code: "connection_conflict",
        message: "Connection registrations changed during discovery. Refresh and retry.",
        retryable: true,
      });
    }
    return {
      connections: snapshot.map(summarizeConnection),
      routes,
      nextSteps: [
        "Use a listed connection ID explicitly when starting an invocation; omit it to preserve the native default login.",
        "Readiness describes the available route only and does not verify account identity.",
      ],
    };
  }

  async #connectionList(): Promise<{
    readonly connections: ReadonlyArray<ReturnType<typeof summarizeConnection>>;
  }> {
    const connections = await loadUserConnections(this.#registry.connectionsPath);
    return { connections: connections.map(summarizeConnection) };
  }

  async #connectionInspect(id: string): Promise<ConnectionInspection> {
    const connections = await loadUserConnections(this.#registry.connectionsPath);
    const connection = this.#requireConnection(id, connections);
    let routes;
    try {
      routes = await this.#registry.discover({ refresh: true, connectionId: id });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "route_unavailable") {
        throw error;
      }
      routes = [];
    }
    const latest = await loadUserConnections(this.#registry.connectionsPath);
    const latestConnection = latest.find((candidate) => candidate.id === id);
    if (latestConnection?.revision !== connection.revision) {
      throw new BridgeError({
        code: "connection_conflict",
        message: "The connection changed during inspection. Refresh and retry.",
        retryable: true,
      });
    }
    const readiness = routes.some((route) => route.readiness === "ready")
      ? "ready"
      : routes.some((route) => route.readiness === "unqualified")
        ? "unqualified"
        : "unavailable";
    return {
      connection: summarizeConnection(connection),
      readiness,
      userActionRequired: readiness !== "ready",
      routes,
      nextSteps:
        readiness === "ready"
          ? [
              "Select this connection explicitly for an invocation if you want to use it.",
              "Route readiness does not verify account identity; confirm the selected native account yourself.",
            ]
          : [
              "Review the route diagnostics and complete any required native harness setup yourself.",
              "Inspect again after setup; Relay does not infer account identity from a context directory.",
            ],
    };
  }

  async #connectionRegister(params: ReturnType<typeof parseConnectionRegisterParams>) {
    const connection = createHarnessConnection(params);
    await this.#validateConnectionInput(connection);
    const mutation = await mutateUserConnections((current) => {
      const existing = current.find((candidate) => candidate.id === connection.id);
      if (existing !== undefined) {
        if (sameConnectionInput(existing, connection)) {
          return { connections: current, result: existing };
        }
        throw new BridgeError({
          code: "connection_conflict",
          message: `Connection ${connection.id} is already registered with different settings. Update it or choose another ID.`,
          retryable: false,
        });
      }
      const duplicate = current.find(
        (candidate) =>
          candidate.harness === connection.harness &&
          candidate.nativeContextRef === connection.nativeContextRef,
      );
      if (duplicate !== undefined) {
        throw new BridgeError({
          code: "connection_conflict",
          message: `This native context is already registered as ${duplicate.id}.`,
          retryable: false,
        });
      }
      return { connections: [...current, connection], result: connection };
    }, this.#registry.connectionsPath);
    return this.#connectionInspect(mutation.result.id);
  }

  async #connectionPrepare(
    params: ReturnType<typeof parseConnectionPrepareParams>,
  ): Promise<ConnectionPrepareResult> {
    const validatedInput = createHarnessConnection({
      ...params,
      nativeContextRef: "native-context-validation-placeholder",
    });
    const login =
      validatedInput.harness === "codex"
        ? { executable: "codex", args: ["login"], env: { CODEX_HOME: "" } }
        : validatedInput.harness === "claude"
          ? { executable: "claude", args: [], env: { CLAUDE_CONFIG_DIR: "" } }
          : undefined;
    if (login === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Harness ${validatedInput.harness} has no supported native login setup instructions.`,
        retryable: false,
      });
    }
    await this.#validateHarness(validatedInput.harness);
    const contextPath = join(
      dirname(this.#registry.connectionsPath),
      "native-contexts",
      validatedInput.harness,
      validatedInput.id,
    );
    const registered = await loadUserConnections(this.#registry.connectionsPath);
    const existing = registered.find((candidate) => candidate.id === validatedInput.id);
    if (
      existing !== undefined &&
      (existing.harness !== validatedInput.harness ||
        existing.nativeContextRef !== contextPath ||
        existing.purpose !== validatedInput.purpose)
    ) {
      throw new BridgeError({
        code: "connection_conflict",
        message: `Connection ${validatedInput.id} is already registered with different settings. Update it or choose another ID.`,
        retryable: false,
      });
    }
    const duplicate = registered.find(
      (candidate) =>
        candidate.id !== validatedInput.id &&
        candidate.harness === validatedInput.harness &&
        candidate.nativeContextRef === contextPath,
    );
    if (duplicate !== undefined) {
      throw new BridgeError({
        code: "connection_conflict",
        message: `This native context is already registered as ${duplicate.id}.`,
        retryable: false,
      });
    }
    try {
      await ensurePrivateDirectory(contextPath, "prepared native context");
    } catch (error) {
      throw new BridgeError(
        {
          code: "invalid_request",
          message:
            "The prepared native context could not be created with private permissions. Inspect the existing context directory and retry.",
          retryable: false,
        },
        { cause: error },
      );
    }
    const inspection = await this.#connectionRegister({
      id: validatedInput.id,
      harness: validatedInput.harness,
      ...(validatedInput.purpose === undefined ? {} : { purpose: validatedInput.purpose }),
      nativeContextRef: contextPath,
    });
    const environmentKey = validatedInput.harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    return {
      ...inspection,
      setup: {
        contextPath,
        login: {
          ...login,
          env: { [environmentKey]: contextPath },
        },
      },
    };
  }

  async #connectionUpdate(params: ReturnType<typeof parseConnectionUpdateParams>) {
    if (
      params.nativeContextRef === undefined &&
      params.purpose === undefined &&
      params.clearPurpose !== true
    ) {
      throw new BridgeError({
        code: "invalid_request",
        message: "Provide nativeContextRef, purpose, or clearPurpose=true for a connection update.",
        retryable: false,
      });
    }
    const mutation = await mutateUserConnections(async (current) => {
      const existing = this.#requireConnection(params.id, current);
      if (existing.revision !== params.expectedRevision) {
        throw this.#staleConnectionRevision(params.expectedRevision, existing.revision);
      }
      const nativeContextRef = params.nativeContextRef ?? existing.nativeContextRef;
      if (nativeContextRef !== existing.nativeContextRef) {
        await this.#validateConnectionInput({ ...existing, nativeContextRef });
      }
      const duplicate = current.find(
        (candidate) =>
          candidate.id !== existing.id &&
          candidate.harness === existing.harness &&
          candidate.nativeContextRef === nativeContextRef,
      );
      if (duplicate !== undefined) {
        throw new BridgeError({
          code: "connection_conflict",
          message: `This native context is already registered as ${duplicate.id}.`,
          retryable: false,
        });
      }
      const purpose =
        params.clearPurpose === true ? undefined : (params.purpose ?? existing.purpose);
      if (nativeContextRef === existing.nativeContextRef && purpose === existing.purpose) {
        return { connections: current, result: existing };
      }
      const updated = updateHarnessConnection(existing, {
        id: existing.id,
        harness: existing.harness,
        nativeContextRef,
        ...(purpose === undefined ? {} : { purpose }),
      });
      return {
        connections: current.map((candidate) => (candidate.id === params.id ? updated : candidate)),
        result: updated,
      };
    }, this.#registry.connectionsPath);
    return this.#connectionInspect(mutation.result.id);
  }

  async #connectionRemove(params: ReturnType<typeof parseConnectionRemoveParams>) {
    const mutation = await mutateUserConnections((current) => {
      const existing = this.#requireConnection(params.id, current);
      if (existing.revision !== params.expectedRevision) {
        throw this.#staleConnectionRevision(params.expectedRevision, existing.revision);
      }
      return {
        connections: current.filter((candidate) => candidate.id !== params.id),
        result: summarizeConnection(existing),
      };
    }, this.#registry.connectionsPath);
    return { removed: true, connection: mutation.result };
  }

  async #validateConnectionInput(connection: HarnessConnection): Promise<void> {
    await this.#validateHarness(connection.harness);
    if ((await inspectNativeContextDirectory(connection.nativeContextRef)) === undefined) {
      throw new BridgeError({
        code: "invalid_request",
        message: "nativeContextRef must identify an absolute, readable native context directory.",
        retryable: false,
      });
    }
  }

  async #validateHarness(harness: string): Promise<void> {
    const adapter = this.#registry.adapter(harness);
    if (adapter.discoverConnection === undefined || adapter.runConnection === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Harness ${harness} does not support named native contexts.`,
        retryable: false,
      });
    }
  }

  #requireConnection(id: string, connections: readonly HarnessConnection[]): HarnessConnection {
    const connection = connections.find((candidate) => candidate.id === id);
    if (connection === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Connection ${id} is not registered. List connections and choose an existing ID.`,
        retryable: false,
      });
    }
    return connection;
  }

  #staleConnectionRevision(expectedRevision: string, actualRevision: string): BridgeError {
    return new BridgeError({
      code: "connection_conflict",
      message: "The connection changed since it was read. Refresh it and retry the update.",
      retryable: true,
      details: { expectedRevision, actualRevision },
    });
  }

  async shutdown(force = false): Promise<Readonly<Record<string, unknown>>> {
    const active = [...this.#records.values()].filter(
      (record) => !TERMINAL_STATES.has(record.state),
    );
    if (active.length > 0 && !force) {
      throw new BridgeError({
        code: "invocation_conflict",
        message:
          "The broker has active invocations. Pass force=true to interrupt them during shutdown.",
        retryable: false,
        details: { activeInvocations: active.map((record) => record.invocationId) },
      });
    }
    this.#shutdownRequested = force && active.length > 0;
    return { accepted: true, force, activeInvocations: active.length };
  }

  describe(): Readonly<Record<string, unknown>> {
    return {
      ...describeContract(),
      broker: {
        packageVersion: PACKAGE_VERSION,
        startedAt: this.#startedAt,
        platform: process.platform,
        pid: process.pid,
        socketPath: this.#paths.socketPath,
        stateFile: this.#store.path,
        logFile: `${this.#store.directory}/broker.log`,
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
      configuration: this.#config,
    };
  }

  status(): Readonly<Record<string, unknown>> {
    const records = [...this.#records.values()];
    return {
      ready: true,
      running: true,
      packageVersion: PACKAGE_VERSION,
      startedAt: this.#startedAt,
      pid: process.pid,
      platform: process.platform,
      socketPath: this.#paths.socketPath,
      stateFile: this.#store.path,
      logFile: `${this.#store.directory}/broker.log`,
      idleShutdownMinutes: this.#config.idleShutdownMinutes,
      activeInvocations: records.filter((record) => !TERMINAL_STATES.has(record.state)).length,
      retainedInvocations: records.length,
      tombstones: this.#tombstones.size,
      diagnosticMode: this.#diagnosticMode,
      environmentVariableNames: Object.keys(process.env).sort(),
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
    let workspaceStat: Awaited<ReturnType<typeof stat>>;
    try {
      workspaceStat = await stat(request.workingDirectory);
    } catch (error) {
      throw new BridgeError(
        {
          code: "invalid_request",
          message: "workingDirectory does not exist or cannot be inspected.",
          retryable: false,
          details: { workingDirectory: request.workingDirectory },
        },
        { cause: error },
      );
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

    const { route, descriptor, effectiveNativePolicy, connectionContext } =
      await this.#registry.resolve(request);
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
        ...(request.callerCorrelationId === undefined
          ? {}
          : { callerCorrelationId: request.callerCorrelationId }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        requestDigest,
        request,
        resolvedRoute: route,
        policy,
        state: "queued",
        createdAt,
        updatedAt: createdAt,
        eventCount: 0,
        events: [],
      };
      const record = this.#appendBridgeEvent(base, "lifecycle", { state: "queued" }, createdAt);
      this.#records.set(invocationId, record);
      this.#workspaceLocks.set(workspaceKey, invocationId);
      return { value: this.#startResult(record, false), changed: true };
    });

    if (!result.deduplicated) {
      this.#beforeSnapshots.set(
        invocationId,
        await captureWorkspaceSnapshot(request.workingDirectory, this.#effectLimits),
      );
      if (connectionContext !== undefined) {
        this.#connectionContexts.set(invocationId, connectionContext);
      }
      this.#launch(invocationId);
    }
    return result;
  }

  async continue(request: ContinueInvocationRequest): Promise<StartInvocationResult> {
    const requestDigest = sha256(
      canonicalJson({
        operation: "invocation.continue",
        invocationId: request.invocationId,
        input: request.input,
        idempotencyKey: request.idempotencyKey,
      }),
    );
    const existing = await this.#existingIdempotent(request.idempotencyKey, requestDigest);
    if (existing !== undefined) {
      return this.#startResult(existing, true);
    }

    const predecessor = this.#requireRecord(request.invocationId);
    if (!TERMINAL_STATES.has(predecessor.state) || predecessor.outcome === undefined) {
      throw new BridgeError({
        code: "invocation_not_active",
        message: `Invocation ${request.invocationId} must be terminal before it can be continued.`,
        retryable: false,
        details: { invocationId: request.invocationId, state: predecessor.state },
      });
    }
    if (!predecessor.resolvedRoute.capabilities.includes("continuation")) {
      throw new BridgeError({
        code: "unsupported_capability",
        message: `Resolved route ${predecessor.resolvedRoute.routeId} does not support native continuation.`,
        retryable: false,
        details: { routeId: predecessor.resolvedRoute.routeId, capability: "continuation" },
      });
    }
    const handle = predecessor.continuationHandle;
    if (handle === undefined) {
      throw new BridgeError({
        code: "continuation_unavailable",
        message: `Invocation ${request.invocationId} has no retained native continuation handle.`,
        retryable: false,
        details: { invocationId: request.invocationId },
      });
    }
    if (handle.expiresAt !== undefined && Date.parse(handle.expiresAt) <= Date.now()) {
      throw new BridgeError({
        code: "continuation_expired",
        message: `The native continuation handle for invocation ${request.invocationId} has expired.`,
        retryable: false,
        details: { invocationId: request.invocationId, expiresAt: handle.expiresAt },
      });
    }
    this.#registry.adapter(predecessor.resolvedRoute.adapter);
    let freshResolution: Awaited<ReturnType<AdapterRegistry["resolve"]>>;
    try {
      freshResolution = await this.#registry.resolve(predecessor.request, { refresh: true });
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === "route_unavailable" || error.code === "route_ambiguous")
      ) {
        throw new BridgeError(
          {
            code: "continuation_route_changed",
            message: `The requested route, interaction strategy, or policy for invocation ${request.invocationId} is no longer supported; continuation cannot safely use another route.`,
            retryable: false,
            details: { invocationId: request.invocationId, cause: error.code },
          },
          { cause: error },
        );
      }
      throw error;
    }
    if (
      canonicalJson(freshResolution.route) !== canonicalJson(predecessor.resolvedRoute) ||
      canonicalJson(freshResolution.effectiveNativePolicy) !==
        canonicalJson(predecessor.policy.effectiveNativePolicy) ||
      freshResolution.descriptor.assurance !== predecessor.policy.assurance ||
      (freshResolution.route.connectionId === undefined
        ? freshResolution.connectionContext !== undefined
        : freshResolution.connectionContext?.id !== freshResolution.route.connectionId ||
          freshResolution.connectionContext.revision !== freshResolution.route.connectionRevision)
    ) {
      throw new BridgeError({
        code: "continuation_route_changed",
        message: `The resolved route or effective policy for invocation ${request.invocationId} changed; continuation cannot safely use another route.`,
        retryable: false,
        details: { invocationId: request.invocationId, routeId: predecessor.resolvedRoute.routeId },
      });
    }

    const continuedRequest: StartInvocationRequest = {
      ...predecessor.request,
      input: request.input,
      idempotencyKey: request.idempotencyKey,
    };
    const invocationId = `inv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    let workspaceKey: string;
    try {
      workspaceKey = await realpath(continuedRequest.workingDirectory);
    } catch {
      workspaceKey = resolve(continuedRequest.workingDirectory);
    }

    const result = await this.#mutate(() => {
      const deduplicated = this.#findIdempotent(request.idempotencyKey, requestDigest);
      if (deduplicated !== undefined) {
        return { value: this.#startResult(deduplicated, true), changed: false };
      }
      const currentPredecessor = this.#requireRecord(request.invocationId);
      if (
        !TERMINAL_STATES.has(currentPredecessor.state) ||
        currentPredecessor.continuationHandle?.reference !== handle.reference ||
        canonicalJson(currentPredecessor.resolvedRoute) !==
          canonicalJson(predecessor.resolvedRoute) ||
        canonicalJson(currentPredecessor.policy.effectiveNativePolicy) !==
          canonicalJson(predecessor.policy.effectiveNativePolicy)
      ) {
        throw new BridgeError({
          code: "continuation_route_changed",
          message: `Invocation ${request.invocationId} no longer has the same retained continuation context.`,
          retryable: false,
          details: { invocationId: request.invocationId },
        });
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
      const base: StoredInvocationRecord = {
        schemaVersion: SCHEMA_VERSION,
        invocationId,
        ...(currentPredecessor.callerCorrelationId === undefined
          ? {}
          : { callerCorrelationId: currentPredecessor.callerCorrelationId }),
        idempotencyKey: request.idempotencyKey,
        requestDigest,
        continuedFrom: currentPredecessor.invocationId,
        continuationHandle: handle,
        request: continuedRequest,
        resolvedRoute: freshResolution.route,
        policy: {
          requestedPolicy: continuedRequest.requestedPolicy,
          effectiveNativePolicy: freshResolution.effectiveNativePolicy,
          assurance: freshResolution.descriptor.assurance,
        },
        state: "queued",
        createdAt,
        updatedAt: createdAt,
        eventCount: 0,
        events: [],
      };
      const record = this.#appendBridgeEvent(
        base,
        "lifecycle",
        { state: "queued", continuedFrom: currentPredecessor.invocationId },
        createdAt,
      );
      this.#records.set(invocationId, record);
      this.#workspaceLocks.set(workspaceKey, invocationId);
      return { value: this.#startResult(record, false), changed: true };
    });

    if (!result.deduplicated) {
      this.#beforeSnapshots.set(
        invocationId,
        await captureWorkspaceSnapshot(continuedRequest.workingDirectory, this.#effectLimits),
      );
      if (freshResolution.connectionContext !== undefined) {
        this.#connectionContexts.set(invocationId, freshResolution.connectionContext);
      }
      this.#launch(invocationId);
    }
    return result;
  }

  async send(request: SendInvocationRequest): Promise<SendInvocationResult> {
    const digest = sha256(canonicalJson(request.input));
    const result = await this.#mutate<{
      readonly result: SendInvocationResult;
      readonly dispatch: boolean;
    }>(() => {
      const current = this.#requireRecord(request.invocationId);
      const prior = (current.acceptedInputs ?? []).find(
        (candidate) => candidate.idempotencyKey === request.idempotencyKey,
      );
      if (prior !== undefined) {
        if (prior.digest !== digest) {
          throw new BridgeError({
            code: "invocation_conflict",
            message: "The send idempotency key is already bound to different input.",
            retryable: false,
            details: {
              invocationId: request.invocationId,
              inputId: prior.inputId,
              idempotencyKey: request.idempotencyKey,
            },
          });
        }
        return {
          value: {
            result: {
              invocationId: request.invocationId,
              inputId: prior.inputId,
              accepted: true as const,
              deduplicated: true,
              delivery: prior.delivery,
            },
            dispatch: false,
          },
          changed: false,
        };
      }
      if (TERMINAL_STATES.has(current.state) || current.state === "cancelling") {
        throw new BridgeError({
          code: "invocation_not_active",
          message: `Invocation ${request.invocationId} is not accepting new input.`,
          retryable: false,
          details: { invocationId: request.invocationId, state: current.state },
        });
      }
      if (this.#completing.has(request.invocationId)) {
        throw new BridgeError({
          code: "invocation_not_active",
          message: `Invocation ${request.invocationId} is completing and cannot accept new input.`,
          retryable: false,
          details: { invocationId: request.invocationId, state: current.state },
        });
      }
      if (this.#controllers.get(request.invocationId)?.signal.aborted === true) {
        throw new BridgeError({
          code: "invocation_not_active",
          message: `Invocation ${request.invocationId} is closing and cannot accept new input.`,
          retryable: false,
          details: { invocationId: request.invocationId, state: current.state },
        });
      }
      if (current.state === "waiting_for_input") {
        throw new BridgeError({
          code: "invocation_conflict",
          message: `Invocation ${request.invocationId} is waiting for a correlated permission response or question answer.`,
          retryable: false,
          details: { invocationId: request.invocationId, state: current.state },
        });
      }
      const adapter = this.#registry.adapter(current.resolvedRoute.adapter);
      if (
        !current.resolvedRoute.capabilities.includes("steering") ||
        adapter.sendInput === undefined
      ) {
        throw new BridgeError({
          code: "unsupported_capability",
          message: `Resolved route ${current.resolvedRoute.routeId} does not implement active invocation input.`,
          retryable: false,
          details: { routeId: current.resolvedRoute.routeId, capability: "steering" },
        });
      }
      const inputId = `input_${randomUUID()}`;
      const accepted: StoredAcceptedInput = {
        inputId,
        idempotencyKey: request.idempotencyKey,
        digest,
        delivery: "pending",
      };
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(
        current,
        "input_accepted",
        { inputId, delivery: "pending" },
        timestamp,
        request.input,
      );
      this.#records.set(request.invocationId, {
        ...withEvent,
        acceptedInputs: [...(current.acceptedInputs ?? []), accepted],
      });
      return {
        value: {
          result: {
            invocationId: request.invocationId,
            inputId,
            accepted: true as const,
            deduplicated: false,
            delivery: "pending",
          },
          dispatch: this.#adapterReady.has(request.invocationId),
        },
        changed: true,
      };
    });
    if (result.dispatch) {
      this.#launchPendingInputs(request.invocationId);
    }
    return result.result;
  }

  async inspect(invocationId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#mutationTail;
    const record = this.#requireRecord(invocationId);
    const events = await this.#eventsFor(record);
    const lastEvent = events.at(-1);
    return {
      schemaVersion: SCHEMA_VERSION,
      invocationId: record.invocationId,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.callerCorrelationId === undefined
        ? {}
        : { callerCorrelationId: record.callerCorrelationId }),
      ...(record.continuedFrom === undefined ? {} : { continuedFrom: record.continuedFrom }),
      requested: record.request.selector,
      resolved: record.resolvedRoute,
      policy: record.policy,
      eventCount: record.eventCount,
      ...(lastEvent === undefined ? {} : { lastCursor: lastEvent.cursor }),
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      next: this.#nextOperations(record),
    };
  }

  async list(params: {
    readonly active?: boolean;
    readonly state?: InvocationState;
    readonly callerCorrelationId?: string;
    readonly since?: string;
    readonly limit: number;
    readonly includeTombstones: boolean;
  }): Promise<InvocationListResult> {
    await this.#mutationTail;
    const since = params.since === undefined ? undefined : Date.parse(params.since);
    const invocations = [...this.#records.values()]
      .filter((record) => params.active !== true || !TERMINAL_STATES.has(record.state))
      .filter((record) => params.state === undefined || record.state === params.state)
      .filter(
        (record) =>
          params.callerCorrelationId === undefined ||
          record.callerCorrelationId === params.callerCorrelationId,
      )
      .filter((record) => since === undefined || Date.parse(record.createdAt) >= since)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, params.limit)
      .map((record) => ({
        invocationId: record.invocationId,
        state: record.state,
        requestedSelector: record.request.selector,
        resolvedRouteId: record.resolvedRoute.routeId,
        ...(record.continuedFrom === undefined ? {} : { continuedFrom: record.continuedFrom }),
        createdAt: record.createdAt,
        ...(record.outcome?.completedAt === undefined
          ? {}
          : { completedAt: record.outcome.completedAt }),
        workingDirectory: record.request.workingDirectory,
        ...(record.callerCorrelationId === undefined
          ? {}
          : { callerCorrelationId: record.callerCorrelationId }),
      }));
    return {
      invocations,
      tombstones: params.includeTombstones ? [...this.#tombstones.values()] : [],
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
      const events = eventAfterCursor(await this.#eventsFor(record), params.after);
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
      const withEvent = this.#appendBridgeEvent(
        current,
        "lifecycle",
        {
          state: "cancelling",
          reason: "caller_request",
        },
        timestamp,
      );
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
        } catch (error) {
          this.#log("error", `Failed to record invocation crash: ${messageFrom(error)}`);
        }
      })
      .finally(() => {
        this.#runs.delete(invocationId);
        this.#connectionContexts.delete(invocationId);
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
      const withEvent = this.#appendBridgeEvent(
        current,
        "lifecycle",
        { state: "running" },
        startedAt,
      );
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
        effectObservation: {
          complete: false,
          diagnostics: ["Invocation was cancelled before an effect snapshot could be collected."],
        },
        error: {
          code: "cancelled",
          message: "The invocation was cancelled before the adapter started.",
        },
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
          () => {
            controller.abort();
          },
          (error: unknown) => {
            this.#log("error", `Failed to record invocation timeout: ${messageFrom(error)}`);
          },
        );
      }, current.request.timeoutMs);
      timeout.unref();
    }

    let partialResult: Partial<AdapterRunResult> = {};
    try {
      const adapter = this.#registry.adapter(current.resolvedRoute.adapter);
      const runContext: AdapterRunContext = {
        invocationId,
        request: current.request,
        route: current.resolvedRoute,
        ...(current.continuationHandle === undefined
          ? {}
          : { continuationHandle: current.continuationHandle }),
        signal: controller.signal,
        emit: async (event: AdapterEvent) => this.#appendAdapterEvent(invocationId, event),
        reportPartial(partial: Partial<AdapterRunResult>) {
          partialResult = { ...partialResult, ...partial };
        },
        awaitInput: async (requestId: string, signal?: AbortSignal) =>
          this.#awaitInput(invocationId, requestId, signal),
        awaitAnswer: async (requestId: string, signal?: AbortSignal) =>
          this.#awaitAnswer(invocationId, requestId, signal),
        terminationGraceMs: this.#terminationGraceMs,
      };
      const connectionContext = this.#connectionContexts.get(invocationId);
      let run: Promise<AdapterRunResult>;
      if (connectionContext === undefined) {
        run = adapter.run(runContext);
      } else {
        if (adapter.runConnection === undefined) {
          throw new BridgeError({
            code: "route_unavailable",
            message: "The selected connection lost its qualified adapter binding.",
            retryable: false,
          });
        }
        run = adapter.runConnection({ ...runContext, connection: connectionContext });
      }
      this.#adapterReady.add(invocationId);
      this.#launchPendingInputs(invocationId);
      const result = await run;
      const latest = this.#requireRecord(invocationId);
      if (latest.state === "cancelling" || controller.signal.aborted) {
        const interrupted = this.#shutdownRequested;
        await this.#complete(
          invocationId,
          interrupted ? "interrupted" : timedOut ? "timed_out" : "cancelled",
          {
            ...result,
            observedIdentity: result.observedIdentity,
            error: {
              code: interrupted ? "broker_shutdown" : timedOut ? "timed_out" : "cancelled",
              message: interrupted
                ? "The broker shut down while the invocation was active."
                : timedOut
                  ? "The invocation exceeded its timeout."
                  : "The invocation was cancelled.",
            },
          },
        );
      } else {
        await this.#complete(invocationId, "succeeded", result);
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        const interrupted = this.#shutdownRequested;
        const partial = this.#partialResult(this.#requireRecord(invocationId), partialResult);
        await this.#complete(
          invocationId,
          interrupted ? "interrupted" : timedOut ? "timed_out" : "cancelled",
          {
            ...partial,
            error: {
              code: interrupted ? "broker_shutdown" : timedOut ? "timed_out" : "cancelled",
              message: interrupted
                ? "The broker shut down while the invocation was active."
                : timedOut
                  ? "The invocation exceeded its timeout."
                  : "The invocation was cancelled.",
            },
          },
        );
      } else {
        const errorCode = error instanceof BridgeError ? error.code : "adapter_failed";
        const partial = this.#partialResult(this.#requireRecord(invocationId), partialResult);
        await this.#complete(invocationId, "failed", {
          ...partial,
          error: { code: errorCode, message: messageFrom(error) },
        });
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.#controllers.delete(invocationId);
      this.#adapterReady.delete(invocationId);
      this.#inputWaiters.delete(invocationId);
      this.#inputResponses.forEach((_response, key) => {
        if (key.startsWith(`${invocationId}:`)) {
          this.#inputResponses.delete(key);
        }
      });
      for (const waiter of this.#questionWaiters.get(invocationId)?.values() ?? []) {
        waiter.reject(new DOMException("The invocation is no longer active.", "AbortError"));
      }
      this.#questionWaiters.delete(invocationId);
      this.#questionResponses.forEach((_answer, key) => {
        if (key.startsWith(`${invocationId}:`)) {
          this.#questionResponses.delete(key);
        }
      });
    }
  }

  async #markTimingOut(invocationId: string): Promise<void> {
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state) || current.state === "cancelling") {
        return { value: undefined, changed: false };
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(
        current,
        "lifecycle",
        {
          state: "cancelling",
          reason: "timeout",
        },
        timestamp,
      );
      this.#records.set(invocationId, {
        ...withEvent,
        state: "cancelling",
        updatedAt: timestamp,
      });
      return { value: undefined, changed: true };
    });
  }

  async #appendAdapterEvent(invocationId: string, event: AdapterEvent): Promise<void> {
    const current = this.#records.get(invocationId);
    if (
      event.inputRequest?.kind === "question" &&
      current !== undefined &&
      !current.resolvedRoute.capabilities.includes("questions")
    ) {
      throw new BridgeError({
        code: "unsupported_capability",
        message: `Resolved route ${current.resolvedRoute.routeId} emitted an unqualified delegate question.`,
        retryable: false,
        details: { routeId: current.resolvedRoute.routeId, capability: "questions" },
      });
    }
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return { value: undefined, changed: false };
      }
      const timestamp = new Date().toISOString();
      let updated: StoredInvocationRecord = current;
      if (!isEffectOnlyCarrier(event)) {
        const sequence = current.eventCount + 1;
        const appended: InvocationEvent = {
          schemaVersion: SCHEMA_VERSION,
          invocationId,
          sequence,
          cursor: eventCursor(sequence),
          timestamp,
          category: event.category,
          ...(event.content === undefined ? {} : { content: event.content }),
          ...(event.data === undefined &&
          event.inputRequest === undefined &&
          event.usage === undefined
            ? {}
            : {
                data: {
                  ...event.data,
                  ...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
                  ...(event.inputRequest === undefined
                    ? {}
                    : {
                        requestId: event.inputRequest.requestId,
                        kind: event.inputRequest.kind,
                        prompt: event.inputRequest.prompt,
                        ...(event.inputRequest.kind !== "permission" ||
                        event.inputRequest.toolName === undefined
                          ? {}
                          : { toolName: event.inputRequest.toolName }),
                        ...(event.inputRequest.kind !== "permission" ||
                        event.inputRequest.input === undefined
                          ? {}
                          : { input: event.inputRequest.input }),
                      }),
                },
              }),
          provenance: { source: "adapter", adapter: current.resolvedRoute.adapter },
          ...(event.native === undefined
            ? {}
            : { native: persistedNative(event.native, this.#diagnosticMode) }),
        };
        updated = {
          ...current,
          ...(event.category === "input_required" ? { state: "waiting_for_input" as const } : {}),
          updatedAt: timestamp,
          eventCount: sequence,
          events: [...current.events, appended],
        };
      }
      const effects = (event.effects ?? []).map((effect) =>
        effect.evidence === "harness-reported"
          ? normalizeHarnessEffect(effect, current.request.workingDirectory)
          : effect,
      );
      for (const effect of effects) {
        updated = this.#appendBridgeEvent(
          updated,
          "effect",
          {
            path: effect.path,
            ...(effect.previousPath === undefined ? {} : { previousPath: effect.previousPath }),
            kind: effect.kind,
            evidence: effect.evidence,
            ...(effect.outsideWorkspace === true ? { outsideWorkspace: true } : {}),
          },
          timestamp,
        );
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
      if (
        pendingRequest?.data?.requestId !== response.requestId ||
        pendingRequest.data.kind !== "permission"
      ) {
        throw new BridgeError({
          code: "invocation_input_stale",
          message: `Request ${response.requestId} is not the pending permission request for invocation ${response.invocationId}.`,
          retryable: false,
          details: { invocationId: response.invocationId, requestId: response.requestId },
        });
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(
        current,
        "lifecycle",
        {
          state: "running",
          reason: "caller_response",
          requestId: response.requestId,
          decision: response.decision,
        },
        timestamp,
      );
      this.#records.set(response.invocationId, {
        ...withEvent,
        state: "running",
        updatedAt: timestamp,
      });
      return {
        value: {
          invocationId: response.invocationId,
          requestId: response.requestId,
          accepted: true,
          state: "running",
        },
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

  async answer(request: AnswerInputRequest): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#mutate(() => {
      const current = this.#requireRecord(request.invocationId);
      if (current.state !== "waiting_for_input") {
        throw new BridgeError({
          code: "invocation_not_active",
          message: `Invocation ${request.invocationId} is not waiting for a question answer.`,
          retryable: false,
          details: { invocationId: request.invocationId, state: current.state },
        });
      }
      if (!current.resolvedRoute.capabilities.includes("questions")) {
        throw new BridgeError({
          code: "unsupported_capability",
          message: `Resolved route ${current.resolvedRoute.routeId} does not support caller answers to delegate questions.`,
          retryable: false,
          details: { routeId: current.resolvedRoute.routeId, capability: "questions" },
        });
      }
      const pendingRequest = [...current.events]
        .reverse()
        .find((event) => event.category === "input_required");
      if (
        pendingRequest?.data?.requestId !== request.requestId ||
        pendingRequest.data.kind !== "question"
      ) {
        throw new BridgeError({
          code: "invocation_input_stale",
          message: `Request ${request.requestId} is not the pending question for invocation ${request.invocationId}.`,
          retryable: false,
          details: { invocationId: request.invocationId, requestId: request.requestId },
        });
      }
      const timestamp = new Date().toISOString();
      const withEvent = this.#appendBridgeEvent(
        current,
        "input_answered",
        { requestId: request.requestId, kind: "question" },
        timestamp,
        request.answer,
      );
      this.#records.set(request.invocationId, {
        ...withEvent,
        state: "running",
        updatedAt: timestamp,
      });
      return {
        value: {
          invocationId: request.invocationId,
          requestId: request.requestId,
          accepted: true,
          state: "running",
        },
        changed: true,
      };
    });
    const waiter = this.#questionWaiters.get(request.invocationId)?.get(request.requestId);
    if (waiter !== undefined) {
      this.#questionWaiters.get(request.invocationId)?.delete(request.requestId);
      waiter.resolve(request.answer);
    } else {
      this.#questionResponses.set(`${request.invocationId}:${request.requestId}`, request.answer);
    }
    return result;
  }

  async #awaitInput(
    invocationId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Pick<InputResponse, "decision">> {
    const key = `${invocationId}:${requestId}`;
    const response = this.#inputResponses.get(key);
    if (response !== undefined) {
      this.#inputResponses.delete(key);
      return response;
    }
    return new Promise((resolve) => {
      const waiters =
        this.#inputWaiters.get(invocationId) ??
        new Map<string, (response: Pick<InputResponse, "decision">) => void>();
      const finish = (decision: Pick<InputResponse, "decision">): void => {
        waiters.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = (): void => {
        finish({ decision: "deny" });
      };
      waiters.set(requestId, finish);
      this.#inputWaiters.set(invocationId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  async #awaitAnswer(
    invocationId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<readonly ContentPart[]> {
    const key = `${invocationId}:${requestId}`;
    const answer = this.#questionResponses.get(key);
    if (answer !== undefined) {
      this.#questionResponses.delete(key);
      return answer;
    }
    if (signal?.aborted === true) {
      throw invocationCancelledError();
    }
    return new Promise((resolve, reject) => {
      const waiters = this.#questionWaiters.get(invocationId) ?? new Map<string, QuestionWaiter>();
      const finish = (callback: () => void): void => {
        waiters.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(invocationCancelledError());
        });
      };
      waiters.set(requestId, {
        resolve(response) {
          finish(() => {
            resolve(response);
          });
        },
        reject(error) {
          finish(() => {
            reject(error instanceof Error ? error : new Error(messageFrom(error)));
          });
        },
      });
      this.#questionWaiters.set(invocationId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  #launchPendingInputs(invocationId: string): void {
    const record = this.#records.get(invocationId);
    if (
      record === undefined ||
      TERMINAL_STATES.has(record.state) ||
      record.state === "cancelling" ||
      this.#completing.has(invocationId) ||
      this.#controllers.get(invocationId)?.signal.aborted === true ||
      [...this.#inputDeliveryRuns.keys()].some((key) => key.startsWith(`${invocationId}:`))
    ) {
      return;
    }
    const accepted = (record.acceptedInputs ?? []).find(
      (candidate) => candidate.delivery === "pending",
    );
    if (accepted === undefined) {
      return;
    }
    const event = record.events.find(
      (candidate) =>
        candidate.category === "input_accepted" && candidate.data?.inputId === accepted.inputId,
    );
    if (event?.content === undefined) {
      return;
    }
    this.#launchInputDelivery(invocationId, accepted.inputId, event.content);
  }

  #launchInputDelivery(
    invocationId: string,
    inputId: string,
    content: readonly ContentPart[],
  ): void {
    const key = `${invocationId}:${inputId}`;
    if (this.#inputDeliveryRuns.has(key)) {
      return;
    }
    const record = this.#records.get(invocationId);
    const controller = this.#controllers.get(invocationId);
    if (
      record === undefined ||
      controller === undefined ||
      TERMINAL_STATES.has(record.state) ||
      record.state === "cancelling" ||
      this.#completing.has(invocationId) ||
      controller.signal.aborted ||
      !this.#adapterReady.has(invocationId)
    ) {
      return;
    }
    const adapter = this.#registry.adapter(record.resolvedRoute.adapter);
    if (adapter.sendInput === undefined) {
      return;
    }
    const sendInput = adapter.sendInput.bind(adapter);
    const deliveryController = new AbortController();
    const abortWithInvocation = (): void => {
      deliveryController.abort("invocation_cancelled");
    };
    if (controller.signal.aborted) {
      abortWithInvocation();
    } else {
      controller.signal.addEventListener("abort", abortWithInvocation, { once: true });
    }
    this.#inputDeliveryControllers.set(key, deliveryController);
    const context: AdapterSendInputContext = {
      invocationId,
      route: record.resolvedRoute,
      inputId,
      content,
      signal: deliveryController.signal,
    };
    const delivery = this.#deliverInput(sendInput, context)
      .catch((error: unknown) => {
        this.#log(
          "error",
          `Failed to record input delivery for ${invocationId}: ${messageFrom(error)}`,
        );
      })
      .finally(() => {
        controller.signal.removeEventListener("abort", abortWithInvocation);
        this.#inputDeliveryControllers.delete(key);
        this.#inputDeliveryRuns.delete(key);
        this.#launchPendingInputs(invocationId);
      });
    this.#inputDeliveryRuns.set(key, delivery);
  }

  async #deliverInput(
    sendInput: NonNullable<Adapter["sendInput"]>,
    context: AdapterSendInputContext,
  ): Promise<void> {
    try {
      const result: AdapterInputResult = await sendInput(context);
      await this.#mutate(() => {
        const current = this.#records.get(context.invocationId);
        const accepted = current?.acceptedInputs?.find(
          (input) => input.inputId === context.inputId,
        );
        if (
          accepted?.delivery !== "pending" ||
          current === undefined ||
          this.#completing.has(context.invocationId) ||
          TERMINAL_STATES.has(current.state)
        ) {
          return { value: undefined, changed: false };
        }
        const timestamp = new Date().toISOString();
        const withEvent = this.#appendBridgeEvent(
          current,
          "input_delivered",
          {
            inputId: context.inputId,
            boundary: result.boundary,
            evidence: "native_session_acknowledgement",
          },
          timestamp,
          undefined,
          { source: "adapter", adapter: current.resolvedRoute.adapter },
        );
        const acceptedInputs = current.acceptedInputs?.map((input) =>
          input.inputId === context.inputId ? { ...input, delivery: "delivered" as const } : input,
        );
        this.#records.set(context.invocationId, {
          ...withEvent,
          ...(acceptedInputs === undefined ? {} : { acceptedInputs }),
        });
        return { value: undefined, changed: true };
      });
    } catch (error) {
      await this.#mutate(() => {
        const current = this.#records.get(context.invocationId);
        const accepted = current?.acceptedInputs?.find(
          (input) => input.inputId === context.inputId,
        );
        if (
          accepted?.delivery !== "pending" ||
          current === undefined ||
          this.#completing.has(context.invocationId) ||
          TERMINAL_STATES.has(current.state)
        ) {
          return { value: undefined, changed: false };
        }
        const expired = current.state === "cancelling" || context.signal.aborted;
        const timestamp = new Date().toISOString();
        const withEvent = this.#appendBridgeEvent(
          current,
          expired ? "input_expired" : "input_delivery_failed",
          {
            inputId: context.inputId,
            ...(expired
              ? {
                  reason:
                    current.state === "cancelling" ? "invocation_cancelled" : "invocation_terminal",
                }
              : {}),
            ...(error instanceof BridgeError ? { code: error.code } : { code: "adapter_failed" }),
          },
          timestamp,
        );
        const acceptedInputs = current.acceptedInputs?.map((input) =>
          input.inputId === context.inputId
            ? { ...input, delivery: expired ? ("expired" as const) : ("failed" as const) }
            : input,
        );
        this.#records.set(context.invocationId, {
          ...withEvent,
          ...(acceptedInputs === undefined ? {} : { acceptedInputs }),
        });
        return { value: undefined, changed: true };
      });
    }
  }

  #expirePendingInputs(
    record: StoredInvocationRecord,
    reason: "broker_restart" | "invocation_terminal",
    timestamp: string,
  ): StoredInvocationRecord {
    const pending = (record.acceptedInputs ?? []).filter((input) => input.delivery === "pending");
    if (pending.length === 0) {
      return record;
    }
    let updated = record;
    for (const input of pending) {
      updated = this.#appendBridgeEvent(
        updated,
        "input_expired",
        { inputId: input.inputId, reason },
        timestamp,
      );
    }
    const acceptedInputs = updated.acceptedInputs?.map((input) =>
      input.delivery === "pending" ? { ...input, delivery: "expired" as const } : input,
    );
    return {
      ...updated,
      ...(acceptedInputs === undefined ? {} : { acceptedInputs }),
    };
  }

  async #complete(
    invocationId: string,
    status: TerminalStatus,
    result: {
      readonly observedIdentity: ObservedIdentity;
      readonly effectObservation?: EffectObservation;
      readonly error?: InvocationOutcome["error"];
    } & Partial<AdapterRunResult>,
  ): Promise<void> {
    this.#completing.add(invocationId);
    for (const [key, controller] of this.#inputDeliveryControllers) {
      if (key.startsWith(`${invocationId}:`)) {
        controller.abort("invocation_terminal");
      }
    }
    const current = this.#records.get(invocationId);
    const afterSnapshot =
      current === undefined
        ? undefined
        : await captureWorkspaceSnapshot(current.request.workingDirectory, this.#effectLimits);
    const observed = await observeWorkspaceEffects(
      this.#beforeSnapshots.get(invocationId),
      afterSnapshot ?? {
        root: current?.request.workingDirectory ?? "",
        files: new Map(),
        complete: false,
        diagnostics: ["Invocation record was not available for effect observation."],
      },
    );
    await this.#mutate(() => {
      const current = this.#requireRecord(invocationId);
      if (TERMINAL_STATES.has(current.state)) {
        return { value: undefined, changed: false };
      }
      const completedAt = new Date().toISOString();
      const allEffects = [
        ...(result.effects ?? []).map((effect) =>
          effect.evidence === "harness-reported"
            ? normalizeHarnessEffect(effect, current.request.workingDirectory)
            : effect,
        ),
        ...observed.effects,
      ];
      let withEvent = this.#expirePendingInputs(current, "invocation_terminal", completedAt);
      for (const effect of observed.effects) {
        withEvent = this.#appendBridgeEvent(
          withEvent,
          "effect",
          {
            path: effect.path,
            ...(effect.previousPath === undefined ? {} : { previousPath: effect.previousPath }),
            kind: effect.kind,
            evidence: effect.evidence,
          },
          completedAt,
        );
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
        ...(result.continuationHandle === undefined
          ? {}
          : { continuationHandle: result.continuationHandle }),
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
    this.#completing.delete(invocationId);
  }

  #outcome(
    record: InvocationRecord,
    status: TerminalStatus,
    completedAt: string,
    result: {
      readonly observedIdentity: ObservedIdentity;
      readonly effectObservation?: EffectObservation;
      readonly error?: InvocationOutcome["error"];
    } & Partial<AdapterRunResult>,
  ): InvocationOutcome {
    const durationMs =
      record.startedAt === undefined
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

  #partialResult(
    record: InvocationRecord,
    partial: Partial<AdapterRunResult>,
  ): {
    readonly observedIdentity: ObservedIdentity;
  } & Partial<AdapterRunResult> {
    const output = record.events.flatMap((event) =>
      event.category === "output" ? (event.content ?? []) : [],
    );
    const usageEvent = [...record.events].reverse().find((event) => event.category === "usage");
    const usage = usageEvent === undefined ? undefined : usageFromEvent(usageEvent.data?.usage);
    const effectiveUsage = partial.usage ?? usage;
    return {
      content: partial.content ?? output,
      artifacts: partial.artifacts ?? [],
      effects: partial.effects ?? [],
      observedIdentity: partial.observedIdentity ?? unverifiedIdentity(),
      ...(effectiveUsage === undefined ? {} : { usage: effectiveUsage }),
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

  #log(level: "error" | "info" | "warn", message: string): void {
    void writeBrokerLog(this.#logFile, level, message);
  }

  #appendBridgeEvent(
    record: StoredInvocationRecord,
    category: InvocationEvent["category"],
    data: NonNullable<InvocationEvent["data"]>,
    timestamp: string,
    content?: readonly ContentPart[],
    provenance: InvocationEvent["provenance"] = { source: "bridge" },
  ): StoredInvocationRecord {
    const sequence = record.eventCount + 1;
    const event: InvocationEvent = {
      schemaVersion: SCHEMA_VERSION,
      invocationId: record.invocationId,
      sequence,
      cursor: eventCursor(sequence),
      timestamp,
      category,
      ...(content === undefined ? {} : { content }),
      data,
      provenance,
    };
    return {
      ...record,
      eventCount: record.eventCount + 1,
      events: [...record.events, event],
      updatedAt: timestamp,
    };
  }

  #startResult(record: InvocationRecord, deduplicated: boolean): StartInvocationResult {
    return {
      invocationId: record.invocationId,
      state: record.state,
      deduplicated,
      next: ["invocation.inspect", ...this.#nextOperations(record)],
    };
  }

  #nextOperations(record: StoredInvocationRecord): readonly string[] {
    if (TERMINAL_STATES.has(record.state)) {
      const handleAvailable =
        record.continuationHandle !== undefined &&
        (record.continuationHandle.expiresAt === undefined ||
          Date.parse(record.continuationHandle.expiresAt) > Date.now());
      return record.resolvedRoute.capabilities.includes("continuation") && handleAvailable
        ? ["invocation.events", "invocation.continue"]
        : ["invocation.events"];
    }
    const next = ["invocation.events", "invocation.cancel"];
    if (record.state === "waiting_for_input") {
      const inputRequest = [...record.events]
        .reverse()
        .find((event) => event.category === "input_required");
      if (inputRequest?.data?.kind === "permission") next.push("invocation.respond");
      if (inputRequest?.data?.kind === "question") next.push("invocation.answer");
      return next;
    }
    const adapter = this.#registry.adapter(record.resolvedRoute.adapter);
    if (
      record.state !== "cancelling" &&
      record.resolvedRoute.capabilities.includes("steering") &&
      adapter.sendInput !== undefined
    ) {
      next.push("invocation.send");
    }
    return next;
  }

  async #existingIdempotent(
    idempotencyKey: string | undefined,
    digest: string,
  ): Promise<InvocationRecord | undefined> {
    await this.#mutationTail;
    return this.#findIdempotent(idempotencyKey, digest);
  }

  #findIdempotent(
    idempotencyKey: string | undefined,
    digest: string,
  ): InvocationRecord | undefined {
    if (idempotencyKey === undefined) {
      return undefined;
    }
    const record = [...this.#records.values()].find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
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

  #requireRecord(invocationId: string): StoredInvocationRecord {
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
        await this.#store.save([...this.#records.values()], [...this.#tombstones.values()]);
        if (this.#applyRetention()) {
          await this.#store.save([...this.#records.values()], [...this.#tombstones.values()]);
        }
        this.#releaseCompletedEvents();
      }
      return result.value;
    });
    this.#mutationTail = scheduled.then(
      () => {},
      () => {},
    );
    return scheduled;
  }

  #applyRetention(): boolean {
    const now = Date.now();
    let retainedBytes = this.#store.retainedBytes();
    let evicted = false;
    const candidates = [...this.#records.values()]
      .filter((record) => TERMINAL_STATES.has(record.state) && record.outcome !== undefined)
      .sort(
        (left, right) =>
          Date.parse(left.outcome?.completedAt ?? left.updatedAt) -
          Date.parse(right.outcome?.completedAt ?? right.updatedAt),
      );
    const evict = (record: InvocationRecord): void => {
      this.#records.delete(record.invocationId);
      retainedBytes -= this.#store.invocationBytes(record.invocationId);
      this.#tombstones.set(record.invocationId, {
        invocationId: record.invocationId,
        evictedAt: new Date(now).toISOString(),
        reason: "retention",
      });
      evicted = true;
    };

    for (const record of candidates) {
      const completedAt = Date.parse(record.outcome?.completedAt ?? record.updatedAt);
      if (Number.isFinite(completedAt) && now - completedAt >= this.#retention.completedMs) {
        evict(record);
      }
    }

    for (const record of candidates) {
      if (!this.#records.has(record.invocationId) || retainedBytes <= this.#retention.maxBytes) {
        continue;
      }
      evict(record);
    }
    return evicted;
  }

  async #eventsFor(record: InvocationRecord): Promise<readonly InvocationEvent[]> {
    if (record.events.length === record.eventCount) {
      return record.events;
    }
    return this.#store.events(record.invocationId);
  }

  #releaseCompletedEvents(): void {
    for (const [invocationId, record] of this.#records) {
      if (!TERMINAL_STATES.has(record.state) || record.events.length === 0) {
        continue;
      }
      this.#records.set(invocationId, { ...record, events: [] });
    }
  }
}
