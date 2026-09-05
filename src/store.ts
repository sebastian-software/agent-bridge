import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SCHEMA_VERSION,
  TERMINAL_STATES,
  isJsonValue,
  parseContentParts,
  parseStartInvocationRequest,
  type Assurance,
  type EventCategory,
  type EvidenceStatus,
  type InvocationEvent,
  type InvocationOutcome,
  type InvocationRecord,
  type InvocationState,
  type JsonValue,
  type ObservedIdentity,
  type ObservedValue,
  type PolicyEvidence,
  type QualificationEvidence,
  type ResolvedRoute,
  type TerminalStatus,
  type WorkspaceEffect,
} from "./contract.js";
import { BridgeError } from "./errors.js";

interface PersistedState {
  readonly storageVersion: 1;
  readonly invocations: readonly InvocationRecord[];
}

type UnknownRecord = Record<string, unknown>;

function corrupt(message: string): never {
  throw new BridgeError({
    code: "internal_error",
    message: `Persisted broker state is invalid: ${message}`,
    retryable: false,
  });
}

function objectValue(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    corrupt(`${field} must be an object.`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    corrupt(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    corrupt(`${field} must be an array.`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    corrupt(`${field} must be a finite number.`);
  }
  return value;
}

function literal<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    corrupt(`${field} has an unsupported value.`);
  }
  return value as T;
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, JsonValue>> {
  const source = objectValue(value, field);
  if (!isJsonValue(source)) {
    corrupt(`${field} must contain only JSON values.`);
  }
  return source as Readonly<Record<string, JsonValue>>;
}

function parseQualification(value: unknown, field: string): readonly QualificationEvidence[] {
  if (!Array.isArray(value)) {
    corrupt(`${field} must be an array.`);
  }
  return value.map((entry, index) => {
    const source = objectValue(entry, `${field}[${index}]`);
    return {
      qualificationId: requiredString(source.qualificationId, `${field}[${index}].qualificationId`),
      testedAt: requiredString(source.testedAt, `${field}[${index}].testedAt`),
      claim: requiredString(source.claim, `${field}[${index}].claim`),
    };
  });
}

function parseResolvedRoute(value: unknown, field: string): ResolvedRoute {
  const source = objectValue(value, field);
  const effort = optionalString(source.effort, `${field}.effort`);
  return {
    routeId: requiredString(source.routeId, `${field}.routeId`),
    adapter: requiredString(source.adapter, `${field}.adapter`),
    harnessVersion: requiredString(source.harnessVersion, `${field}.harnessVersion`),
    authenticationMode: requiredString(source.authenticationMode, `${field}.authenticationMode`),
    provider: requiredString(source.provider, `${field}.provider`),
    model: requiredString(source.model, `${field}.model`),
    ...(effort === undefined ? {} : { effort }),
    via: requiredString(source.via, `${field}.via`),
    capabilities: stringList(source.capabilities, `${field}.capabilities`),
    qualification: parseQualification(source.qualification, `${field}.qualification`),
  };
}

function parseObservedValue(value: unknown, field: string): ObservedValue {
  const source = objectValue(value, field);
  const observed = optionalString(source.value, `${field}.value`);
  const evidence = literal<EvidenceStatus>(source.evidence, `${field}.evidence`, [
    "unverified",
    "inferred",
    "reported",
    "verified",
  ]);
  const sourceName = optionalString(source.source, `${field}.source`);
  return {
    ...(observed === undefined ? {} : { value: observed }),
    evidence,
    ...(sourceName === undefined ? {} : { source: sourceName }),
  };
}

function parseObservedIdentity(value: unknown, field: string): ObservedIdentity {
  const source = objectValue(value, field);
  return {
    provider: parseObservedValue(source.provider, `${field}.provider`),
    model: parseObservedValue(source.model, `${field}.model`),
    harnessVersion: parseObservedValue(source.harnessVersion, `${field}.harnessVersion`),
    nativeSessionId: parseObservedValue(source.nativeSessionId, `${field}.nativeSessionId`),
  };
}

function parsePolicy(value: unknown, field: string, requestPolicy: PolicyEvidence["requestedPolicy"]): PolicyEvidence {
  const source = objectValue(value, field);
  return {
    requestedPolicy: requestPolicy,
    effectiveNativePolicy: jsonObject(source.effectiveNativePolicy, `${field}.effectiveNativePolicy`),
    assurance: literal<Assurance>(source.assurance, `${field}.assurance`, ["none", "native", "isolated"]),
  };
}

function parseEffect(value: unknown, field: string): WorkspaceEffect {
  const source = objectValue(value, field);
  return {
    path: requiredString(source.path, `${field}.path`),
    kind: literal(source.kind, `${field}.kind`, ["created", "deleted", "modified", "renamed", "unknown"] as const),
    evidence: literal(source.evidence, `${field}.evidence`, ["git-status", "harness-reported"] as const),
  };
}

function parseEvent(value: unknown, field: string, invocationId: string, expectedSequence: number): InvocationEvent {
  const source = objectValue(value, field);
  const sequence = finiteNumber(source.sequence, `${field}.sequence`);
  if (!Number.isSafeInteger(sequence) || sequence !== expectedSequence) {
    corrupt(`${field}.sequence must be contiguous from one.`);
  }
  if (source.invocationId !== invocationId || source.schemaVersion !== SCHEMA_VERSION) {
    corrupt(`${field} identity does not match its invocation.`);
  }
  const content = source.content === undefined ? undefined : parseContentParts(source.content, `${field}.content`);
  const data = source.data === undefined ? undefined : jsonObject(source.data, `${field}.data`);
  const native = source.native === undefined ? undefined : jsonObject(source.native, `${field}.native`);
  const provenanceSource = objectValue(source.provenance, `${field}.provenance`);
  const adapter = optionalString(provenanceSource.adapter, `${field}.provenance.adapter`);
  return {
    schemaVersion: SCHEMA_VERSION,
    invocationId,
    sequence,
    cursor: requiredString(source.cursor, `${field}.cursor`),
    timestamp: requiredString(source.timestamp, `${field}.timestamp`),
    category: literal<EventCategory>(source.category, `${field}.category`, [
      "activity",
      "diagnostic",
      "effect",
      "input_accepted",
      "input_required",
      "lifecycle",
      "output",
      "usage",
    ]),
    ...(content === undefined ? {} : { content }),
    ...(data === undefined ? {} : { data }),
    provenance: {
      source: literal(provenanceSource.source, `${field}.provenance.source`, ["adapter", "bridge"] as const),
      ...(adapter === undefined ? {} : { adapter }),
    },
    ...(native === undefined ? {} : { native }),
  };
}

function parseOutcome(
  value: unknown,
  field: string,
  invocationId: string,
  policy: PolicyEvidence,
): InvocationOutcome {
  const source = objectValue(value, field);
  if (source.schemaVersion !== SCHEMA_VERSION || source.invocationId !== invocationId) {
    corrupt(`${field} identity does not match its invocation.`);
  }
  const startedAt = optionalString(source.startedAt, `${field}.startedAt`);
  const durationMs = source.durationMs === undefined ? undefined : finiteNumber(source.durationMs, `${field}.durationMs`);
  if (durationMs !== undefined && durationMs < 0) {
    corrupt(`${field}.durationMs must not be negative.`);
  }
  let parsedError: InvocationOutcome["error"];
  if (source.error !== undefined) {
    const error = objectValue(source.error, `${field}.error`);
    parsedError = {
      code: requiredString(error.code, `${field}.error.code`),
      message: requiredString(error.message, `${field}.error.message`),
    };
  }
  if (!Array.isArray(source.effects)) {
    corrupt(`${field}.effects must be an array.`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    invocationId,
    status: literal<TerminalStatus>(source.status, `${field}.status`, [
      "cancelled",
      "failed",
      "interrupted",
      "succeeded",
      "timed_out",
    ]),
    content: parseContentParts(source.content, `${field}.content`),
    artifacts: parseContentParts(source.artifacts, `${field}.artifacts`),
    effects: source.effects.map((effect, index) => parseEffect(effect, `${field}.effects[${index}]`)),
    observedIdentity: parseObservedIdentity(source.observedIdentity, `${field}.observedIdentity`),
    policy,
    ...(startedAt === undefined ? {} : { startedAt }),
    completedAt: requiredString(source.completedAt, `${field}.completedAt`),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(parsedError === undefined ? {} : { error: parsedError }),
  };
}

function parseInvocation(value: unknown, index: number): InvocationRecord {
  const field = `invocations[${index}]`;
  const source = objectValue(value, field);
  if (source.schemaVersion !== SCHEMA_VERSION) {
    corrupt(`${field}.schemaVersion is unsupported.`);
  }
  const invocationId = requiredString(source.invocationId, `${field}.invocationId`);
  let request;
  try {
    request = parseStartInvocationRequest(source.request);
  } catch (error) {
    throw new BridgeError({
      code: "internal_error",
      message: `Persisted broker state is invalid: ${field}.request failed validation.`,
      retryable: false,
    }, { cause: error });
  }
  const resolvedRoute = parseResolvedRoute(source.resolvedRoute, `${field}.resolvedRoute`);
  const policy = parsePolicy(source.policy, `${field}.policy`, request.requestedPolicy);
  const state = literal<InvocationState>(source.state, `${field}.state`, [
    "queued",
    "running",
    "waiting_for_input",
    "cancelling",
    "cancelled",
    "failed",
    "interrupted",
    "succeeded",
    "timed_out",
  ]);
  if (!Array.isArray(source.events)) {
    corrupt(`${field}.events must be an array.`);
  }
  const events = source.events.map((event, eventIndex) => parseEvent(event, `${field}.events[${eventIndex}]`, invocationId, eventIndex + 1));
  const outcome = source.outcome === undefined
    ? undefined
    : parseOutcome(source.outcome, `${field}.outcome`, invocationId, policy);
  if (TERMINAL_STATES.has(state) !== (outcome !== undefined)) {
    corrupt(`${field} must have exactly one outcome if and only if it is terminal.`);
  }
  const callerCorrelationId = optionalString(source.callerCorrelationId, `${field}.callerCorrelationId`);
  const idempotencyKey = optionalString(source.idempotencyKey, `${field}.idempotencyKey`);
  const startedAt = optionalString(source.startedAt, `${field}.startedAt`);
  return {
    schemaVersion: SCHEMA_VERSION,
    invocationId,
    ...(callerCorrelationId === undefined ? {} : { callerCorrelationId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    requestDigest: requiredString(source.requestDigest, `${field}.requestDigest`),
    request,
    resolvedRoute,
    policy,
    state,
    createdAt: requiredString(source.createdAt, `${field}.createdAt`),
    updatedAt: requiredString(source.updatedAt, `${field}.updatedAt`),
    ...(startedAt === undefined ? {} : { startedAt }),
    events,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function parseState(value: unknown): PersistedState {
  const source = objectValue(value, "state");
  if (source.storageVersion !== 1 || !Array.isArray(source.invocations)) {
    corrupt("storageVersion or invocations is invalid.");
  }
  return {
    storageVersion: 1,
    invocations: source.invocations.map(parseInvocation),
  };
}

export class InvocationStore {
  readonly #stateFile: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(stateFile: string) {
    this.#stateFile = stateFile;
  }

  get path(): string {
    return this.#stateFile;
  }

  async load(): Promise<readonly InvocationRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch (error) {
      throw new BridgeError({
        code: "internal_error",
        message: "Persisted broker state is not valid JSON.",
        retryable: false,
      }, { cause: error });
    }
    return parseState(decoded).invocations;
  }

  async save(invocations: readonly InvocationRecord[]): Promise<void> {
    const state: PersistedState = {
      storageVersion: 1,
      invocations,
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const work = async (): Promise<void> => {
      const directory = dirname(this.#stateFile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryFile = join(directory, `.state-${randomUUID()}.tmp`);
      await writeFile(temporaryFile, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryFile, this.#stateFile);
    };
    const scheduled = this.#writeTail.then(work, work);
    this.#writeTail = scheduled;
    await scheduled;
  }
}
