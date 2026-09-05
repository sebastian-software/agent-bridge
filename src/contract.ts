import { BridgeError } from "./errors.js";

export const SCHEMA_VERSION = "1.0" as const;
export const IPC_PROTOCOL_VERSION = "1.0" as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Assurance = "isolated" | "native" | "none";
export type EvidenceStatus = "inferred" | "reported" | "unverified" | "verified";
export type InteractionStrategy = "deny" | "orchestrator" | "unattended";
export type InvocationState = "queued" | "running" | "waiting_for_input" | "cancelling" | TerminalStatus;
export type TerminalStatus = "cancelled" | "failed" | "interrupted" | "succeeded" | "timed_out";

export const TERMINAL_STATES: ReadonlySet<InvocationState> = new Set([
  "cancelled",
  "failed",
  "interrupted",
  "succeeded",
  "timed_out",
]);

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "json"; readonly value: JsonValue }
  | {
      readonly type: "image" | "audio" | "file";
      readonly path: string;
      readonly mimeType: string;
      readonly byteSize?: number;
      readonly digest?: string;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType?: string;
      readonly byteSize?: number;
      readonly digest?: string;
    };

export interface DelegationSelector {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly via?: string;
  readonly requiredCapabilities: readonly string[];
  readonly minimumObservedEvidence?: EvidenceStatus;
}

export interface RequestedPolicy {
  readonly filesystem?: "inherit" | "read-only" | "workspace-write";
  readonly commands?: "allow" | "deny" | "inherit";
  readonly network?: "allow" | "deny" | "inherit";
  readonly additionalDirectories?: readonly string[];
  readonly minimumAssurance: Assurance;
}

export interface StartInvocationRequest {
  readonly selector: DelegationSelector;
  readonly input: readonly ContentPart[];
  readonly workingDirectory: string;
  readonly interactionStrategy: InteractionStrategy;
  readonly requestedPolicy: RequestedPolicy;
  readonly timeoutMs?: number;
  readonly callerCorrelationId?: string;
  readonly idempotencyKey?: string;
}

export interface QualificationEvidence {
  readonly qualificationId: string;
  readonly testedAt: string;
  readonly claim: string;
}

export interface RouteDescriptor {
  readonly routeId: string;
  readonly executable?: string;
  readonly canonicalModel?: string;
  readonly provider: string;
  readonly model: string;
  readonly efforts: readonly string[];
  readonly via: string;
  readonly adapter: string;
  readonly harnessVersion: string;
  readonly authenticationMode: string;
  readonly capabilities: readonly string[];
  readonly interactionStrategies: readonly InteractionStrategy[];
  readonly assurance: Assurance;
  readonly runtimeIdentityEvidence: EvidenceStatus;
  readonly readiness: "ready" | "unavailable" | "unqualified";
  readonly qualification: readonly QualificationEvidence[];
  readonly diagnostics: readonly string[];
  readonly discoveredAt?: string;
  readonly policySupport?: Readonly<Record<string, readonly string[]>>;
}

export interface ResolvedRoute {
  readonly routeId: string;
  readonly executable?: string;
  readonly canonicalModel?: string;
  readonly adapter: string;
  readonly harnessVersion: string;
  readonly authenticationMode: string;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly via: string;
  readonly capabilities: readonly string[];
  readonly qualification: readonly QualificationEvidence[];
}

export interface ObservedValue {
  readonly value?: string;
  readonly evidence: EvidenceStatus;
  readonly source?: string;
}

export interface ObservedIdentity {
  readonly provider: ObservedValue;
  readonly model: ObservedValue;
  readonly harnessVersion: ObservedValue;
  readonly nativeSessionId: ObservedValue;
}

export interface PolicyEvidence {
  readonly requestedPolicy: RequestedPolicy;
  readonly effectiveNativePolicy: Readonly<Record<string, JsonValue>>;
  readonly assurance: Assurance;
}

export type EventCategory =
  | "activity"
  | "diagnostic"
  | "effect"
  | "input_accepted"
  | "input_required"
  | "lifecycle"
  | "output"
  | "usage";

export interface InvocationEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly invocationId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly timestamp: string;
  readonly category: EventCategory;
  readonly content?: readonly ContentPart[];
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly provenance: {
    readonly source: "adapter" | "bridge";
    readonly adapter?: string;
  };
  readonly native?: Readonly<Record<string, JsonValue>>;
}

export interface WorkspaceEffect {
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: "created" | "deleted" | "modified" | "renamed" | "unknown";
  readonly evidence: "git-status" | "harness-reported";
}

export interface EffectObservation {
  readonly complete: boolean;
  readonly diagnostics: readonly string[];
}

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly turns?: number;
  readonly costUsd?: number;
  readonly evidence: "reported";
  readonly source: string;
}

export interface InputRequest {
  readonly requestId: string;
  readonly kind: "permission";
  readonly prompt: string;
  readonly toolName?: string;
  /** Original tool input, kept transiently for native permission responses. */
  readonly input?: JsonValue;
}

export interface InputResponse {
  readonly invocationId: string;
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}

export interface InvocationOutcome {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly invocationId: string;
  readonly status: TerminalStatus;
  readonly content: readonly ContentPart[];
  readonly artifacts: readonly ContentPart[];
  readonly effects: readonly WorkspaceEffect[];
  readonly effectObservation: EffectObservation;
  readonly usage?: Usage;
  readonly observedIdentity: ObservedIdentity;
  readonly policy: PolicyEvidence;
  readonly startedAt?: string;
  readonly completedAt: string;
  readonly durationMs?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface InvocationRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly invocationId: string;
  readonly callerCorrelationId?: string;
  readonly idempotencyKey?: string;
  readonly requestDigest: string;
  readonly request: StartInvocationRequest;
  readonly resolvedRoute: ResolvedRoute;
  readonly policy: PolicyEvidence;
  readonly state: InvocationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  /** Total number of events, including events loaded from disk on demand. */
  readonly eventCount: number;
  readonly events: readonly InvocationEvent[];
  readonly outcome?: InvocationOutcome;
}

export interface InvocationTombstone {
  readonly invocationId: string;
  readonly evictedAt: string;
  readonly reason: "retention";
}

export interface StartInvocationResult {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly deduplicated: boolean;
  readonly next: readonly string[];
}

export interface EventsResult {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly events: readonly InvocationEvent[];
  readonly nextCursor?: string;
  readonly terminal: boolean;
}

export interface InvocationSummary {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly requestedSelector: DelegationSelector;
  readonly resolvedRouteId: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly workingDirectory: string;
  readonly callerCorrelationId?: string;
}

export interface InvocationListResult {
  readonly invocations: readonly InvocationSummary[];
  readonly tombstones: readonly InvocationTombstone[];
}

export interface OperationRequest {
  readonly protocolVersion: typeof IPC_PROTOCOL_VERSION;
  readonly id: string;
  readonly operation: string;
  readonly params: unknown;
}

export type OperationResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

type UnknownRecord = Record<string, unknown>;

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new BridgeError({
    code: "invalid_request",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function record(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown, field: string, options?: { nonEmpty?: boolean }): string {
  if (typeof value !== "string" || (options?.nonEmpty === true && value.trim() === "")) {
    invalid(`${field} must be${options?.nonEmpty === true ? " a non-empty" : ""} string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field, { nonEmpty: true });
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array.`);
  }
  return value.map((item, index) => stringValue(item, `${field}[${index}]`, { nonEmpty: true }));
}

function oneOf<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    invalid(`${field} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    invalid(`${field} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    invalid(`${field} must be a non-negative integer.`);
  }
  return value;
}

function parseContentPart(value: unknown, field: string): ContentPart {
  const source = record(value, field);
  const type = oneOf(source.type, `${field}.type`, ["text", "json", "image", "audio", "file", "resource"] as const);

  if (type === "text") {
    return { type, text: stringValue(source.text, `${field}.text`) };
  }
  if (type === "json") {
    if (!isJsonValue(source.value)) {
      invalid(`${field}.value must be JSON-compatible.`);
    }
    return { type, value: source.value };
  }
  if (type === "resource") {
    const mimeType = optionalString(source.mimeType, `${field}.mimeType`);
    const byteSize = optionalNonNegativeInteger(source.byteSize, `${field}.byteSize`);
    const digest = optionalString(source.digest, `${field}.digest`);
    return {
      type,
      uri: stringValue(source.uri, `${field}.uri`, { nonEmpty: true }),
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(byteSize === undefined ? {} : { byteSize }),
      ...(digest === undefined ? {} : { digest }),
    };
  }

  const byteSize = optionalNonNegativeInteger(source.byteSize, `${field}.byteSize`);
  const digest = optionalString(source.digest, `${field}.digest`);
  return {
    type,
    path: stringValue(source.path, `${field}.path`, { nonEmpty: true }),
    mimeType: stringValue(source.mimeType, `${field}.mimeType`, { nonEmpty: true }),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(digest === undefined ? {} : { digest }),
  };
}

export function parseContentParts(value: unknown, field = "content"): readonly ContentPart[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array.`);
  }
  return value.map((part, index) => parseContentPart(part, `${field}[${index}]`));
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function parseOperationRequest(value: unknown): OperationRequest {
  const source = record(value, "request");
  if (source.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new BridgeError({
      code: "protocol_version_mismatch",
      message: `The IPC protocol version is unsupported; expected ${IPC_PROTOCOL_VERSION}.`,
      retryable: false,
      details: { expected: IPC_PROTOCOL_VERSION, received: source.protocolVersion ?? null },
    });
  }
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: stringValue(source.id, "request.id", { nonEmpty: true }),
    operation: stringValue(source.operation, "request.operation", { nonEmpty: true }),
    params: source.params ?? {},
  };
}

export function parseStartInvocationRequest(value: unknown): StartInvocationRequest {
  const source = record(value, "params");
  const selectorSource = record(source.selector, "params.selector");
  const policySource =
    source.requestedPolicy === undefined ? {} : record(source.requestedPolicy, "params.requestedPolicy");
  if (!Array.isArray(source.input) || source.input.length === 0) {
    invalid("params.input must contain at least one content part.");
  }

  const effort = optionalString(selectorSource.effort, "params.selector.effort");
  const via = optionalString(selectorSource.via, "params.selector.via");
  const minimumObservedEvidence =
    selectorSource.minimumObservedEvidence === undefined
      ? undefined
      : oneOf(selectorSource.minimumObservedEvidence, "params.selector.minimumObservedEvidence", [
          "unverified",
          "inferred",
          "reported",
          "verified",
        ] as const);
  const filesystem =
    policySource.filesystem === undefined
      ? undefined
      : oneOf(policySource.filesystem, "params.requestedPolicy.filesystem", [
          "inherit",
          "read-only",
          "workspace-write",
        ] as const);
  const commands =
    policySource.commands === undefined
      ? undefined
      : oneOf(policySource.commands, "params.requestedPolicy.commands", ["inherit", "deny", "allow"] as const);
  const network =
    policySource.network === undefined
      ? undefined
      : oneOf(policySource.network, "params.requestedPolicy.network", ["inherit", "deny", "allow"] as const);
  const additionalDirectories =
    policySource.additionalDirectories === undefined
      ? undefined
      : stringArray(policySource.additionalDirectories, "params.requestedPolicy.additionalDirectories");
  const timeoutMs = optionalPositiveInteger(source.timeoutMs, "params.timeoutMs");
  const callerCorrelationId = optionalString(source.callerCorrelationId, "params.callerCorrelationId");
  const idempotencyKey = optionalString(source.idempotencyKey, "params.idempotencyKey");

  return {
    selector: {
      provider: stringValue(selectorSource.provider, "params.selector.provider", { nonEmpty: true }),
      model: stringValue(selectorSource.model, "params.selector.model", { nonEmpty: true }),
      ...(effort === undefined ? {} : { effort }),
      ...(via === undefined ? {} : { via }),
      requiredCapabilities:
        selectorSource.requiredCapabilities === undefined
          ? []
          : stringArray(selectorSource.requiredCapabilities, "params.selector.requiredCapabilities"),
      ...(minimumObservedEvidence === undefined ? {} : { minimumObservedEvidence }),
    },
    input: parseContentParts(source.input, "params.input"),
    workingDirectory: stringValue(source.workingDirectory, "params.workingDirectory", { nonEmpty: true }),
    interactionStrategy:
      source.interactionStrategy === undefined
        ? "orchestrator"
        : oneOf(source.interactionStrategy, "params.interactionStrategy", [
            "orchestrator",
            "deny",
            "unattended",
          ] as const),
    requestedPolicy: {
      ...(filesystem === undefined ? {} : { filesystem }),
      ...(commands === undefined ? {} : { commands }),
      ...(network === undefined ? {} : { network }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
      minimumAssurance:
        policySource.minimumAssurance === undefined
          ? "none"
          : oneOf(policySource.minimumAssurance, "params.requestedPolicy.minimumAssurance", [
              "none",
              "native",
              "isolated",
            ] as const),
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(callerCorrelationId === undefined ? {} : { callerCorrelationId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

export function parseInvocationIdParams(value: unknown): { readonly invocationId: string } {
  const source = record(value, "params");
  return {
    invocationId: stringValue(source.invocationId, "params.invocationId", { nonEmpty: true }),
  };
}

export function parseRouteDiscoverParams(value: unknown): { readonly refresh: boolean } {
  const source = record(value, "params");
  if (source.refresh === undefined) {
    return { refresh: false };
  }
  if (typeof source.refresh !== "boolean") {
    invalid("params.refresh must be a boolean.");
  }
  return { refresh: source.refresh };
}

export function parseShutdownParams(value: unknown): { readonly force: boolean } {
  const source = record(value, "params");
  if (source.force === undefined) {
    return { force: false };
  }
  if (typeof source.force !== "boolean") {
    invalid("params.force must be a boolean.");
  }
  return { force: source.force };
}

export function parseRespondParams(value: unknown): InputResponse {
  const source = record(value, "params");
  return {
    invocationId: stringValue(source.invocationId, "params.invocationId", { nonEmpty: true }),
    requestId: stringValue(source.requestId, "params.requestId", { nonEmpty: true }),
    decision: oneOf(source.decision, "params.decision", ["allow", "deny"] as const),
  };
}

export function parseWaitParams(value: unknown): {
  readonly invocationId: string;
  readonly timeoutMs?: number;
} {
  const source = record(value, "params");
  const invocationId = stringValue(source.invocationId, "params.invocationId", { nonEmpty: true });
  const timeoutMs = optionalPositiveInteger(source.timeoutMs, "params.timeoutMs");
  if (timeoutMs !== undefined && timeoutMs > 30_000) {
    invalid("params.timeoutMs must not exceed 30000.");
  }
  return {
    invocationId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function parseEventsParams(value: unknown): {
  readonly invocationId: string;
  readonly after?: string;
  readonly waitMs?: number;
} {
  const source = record(value, "params");
  const after = optionalString(source.after, "params.after");
  const waitMs = optionalPositiveInteger(source.waitMs, "params.waitMs");
  if (waitMs !== undefined && waitMs > 30_000) {
    invalid("params.waitMs must not exceed 30000.");
  }
  return {
    invocationId: stringValue(source.invocationId, "params.invocationId", { nonEmpty: true }),
    ...(after === undefined ? {} : { after }),
    ...(waitMs === undefined ? {} : { waitMs }),
  };
}

export function parseInvocationListParams(value: unknown): {
  readonly state?: InvocationState;
  readonly callerCorrelationId?: string;
  readonly since?: string;
  readonly limit: number;
  readonly includeTombstones: boolean;
} {
  const source = record(value, "params");
  const state =
    source.state === undefined
      ? undefined
      : oneOf(source.state, "params.state", [
          "queued",
          "running",
          "waiting_for_input",
          "cancelling",
          "cancelled",
          "failed",
          "interrupted",
          "succeeded",
          "timed_out",
        ] as const);
  const callerCorrelationId = optionalString(source.callerCorrelationId, "params.callerCorrelationId");
  const since = optionalString(source.since, "params.since");
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    invalid("params.since must be an ISO-8601 timestamp.");
  }
  const limit = source.limit === undefined ? 50 : source.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    invalid("params.limit must be a positive integer not exceeding 1000.");
  }
  const includeTombstones = source.includeTombstones === undefined ? false : source.includeTombstones;
  if (typeof includeTombstones !== "boolean") {
    invalid("params.includeTombstones must be a boolean.");
  }
  return {
    ...(state === undefined ? {} : { state }),
    ...(callerCorrelationId === undefined ? {} : { callerCorrelationId }),
    ...(since === undefined ? {} : { since }),
    limit,
    includeTombstones,
  };
}
