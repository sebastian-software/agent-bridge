import type { Dirent } from "node:fs";

import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type Assurance,
  type EventCategory,
  type EvidenceStatus,
  type InvocationEvent,
  type InvocationOutcome,
  type InvocationRecord,
  type InvocationState,
  type InvocationTombstone,
  isJsonValue,
  type JsonValue,
  type ObservedIdentity,
  type ObservedValue,
  parseContentParts,
  parseStartInvocationRequest,
  type PolicyEvidence,
  type QualificationEvidence,
  type ResolvedRoute,
  SCHEMA_VERSION,
  type StartInvocationRequest,
  TERMINAL_STATES,
  type TerminalStatus,
  type Usage,
  type WorkspaceEffect,
} from "./contract.js";
import { BridgeError } from "./errors.js";

type PersistedState = {
  readonly storageVersion: 1;
  readonly invocations: readonly InvocationRecord[];
  readonly tombstones: readonly InvocationTombstone[];
};

export type StoreSnapshot = {
  readonly invocations: readonly InvocationRecord[];
  readonly tombstones: readonly InvocationTombstone[];
};

type UnknownRecord = Record<string, unknown>;

type FileSizes = {
  events: number;
  metadata: number;
  outcome: number;
};

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
  return source;
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
  const executable = optionalString(source.executable, `${field}.executable`);
  const canonicalModel = optionalString(source.canonicalModel, `${field}.canonicalModel`);
  const effort = optionalString(source.effort, `${field}.effort`);
  return {
    routeId: requiredString(source.routeId, `${field}.routeId`),
    ...(executable === undefined ? {} : { executable }),
    ...(canonicalModel === undefined ? {} : { canonicalModel }),
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

function parseUsage(value: unknown, field: string): Usage {
  const source = objectValue(value, field);
  const optionalCount = (candidate: unknown, name: string): number | undefined => {
    if (candidate === undefined) {
      return undefined;
    }
    const parsed = finiteNumber(candidate, `${field}.${name}`);
    if (parsed < 0) {
      corrupt(`${field}.${name} must not be negative.`);
    }
    return parsed;
  };
  const inputTokens = optionalCount(source.inputTokens, "inputTokens");
  const outputTokens = optionalCount(source.outputTokens, "outputTokens");
  const cacheReadTokens = optionalCount(source.cacheReadTokens, "cacheReadTokens");
  const cacheWriteTokens = optionalCount(source.cacheWriteTokens, "cacheWriteTokens");
  const turns = optionalCount(source.turns, "turns");
  const costUsd = optionalCount(source.costUsd, "costUsd");
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(turns === undefined ? {} : { turns }),
    ...(costUsd === undefined ? {} : { costUsd }),
    evidence: literal(source.evidence, `${field}.evidence`, ["reported"] as const),
    source: requiredString(source.source, `${field}.source`),
  };
}

function parsePolicy(
  value: unknown,
  field: string,
  requestPolicy: PolicyEvidence["requestedPolicy"],
): PolicyEvidence {
  const source = objectValue(value, field);
  return {
    requestedPolicy: requestPolicy,
    effectiveNativePolicy: jsonObject(
      source.effectiveNativePolicy,
      `${field}.effectiveNativePolicy`,
    ),
    assurance: literal<Assurance>(source.assurance, `${field}.assurance`, [
      "none",
      "native",
      "isolated",
    ]),
  };
}

function parseEffect(value: unknown, field: string): WorkspaceEffect {
  const source = objectValue(value, field);
  const previousPath = optionalString(source.previousPath, `${field}.previousPath`);
  if (source.outsideWorkspace !== undefined && source.outsideWorkspace !== true) {
    corrupt(`${field}.outsideWorkspace must be true when present.`);
  }
  return {
    path: requiredString(source.path, `${field}.path`),
    ...(previousPath === undefined ? {} : { previousPath }),
    kind: literal(source.kind, `${field}.kind`, [
      "created",
      "deleted",
      "modified",
      "renamed",
      "unknown",
    ] as const),
    evidence: literal(source.evidence, `${field}.evidence`, [
      "git-status",
      "harness-reported",
    ] as const),
    ...(source.outsideWorkspace === true ? { outsideWorkspace: true } : {}),
  };
}

function parseEvent(
  value: unknown,
  field: string,
  invocationId: string,
  expectedSequence: number,
): InvocationEvent {
  const source = objectValue(value, field);
  const sequence = finiteNumber(source.sequence, `${field}.sequence`);
  if (!Number.isSafeInteger(sequence) || sequence !== expectedSequence) {
    corrupt(`${field}.sequence must be contiguous from one.`);
  }
  if (source.invocationId !== invocationId || source.schemaVersion !== SCHEMA_VERSION) {
    corrupt(`${field} identity does not match its invocation.`);
  }
  const content =
    source.content === undefined
      ? undefined
      : parseContentParts(source.content, `${field}.content`);
  const data = source.data === undefined ? undefined : jsonObject(source.data, `${field}.data`);
  const native =
    source.native === undefined ? undefined : jsonObject(source.native, `${field}.native`);
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
      source: literal(provenanceSource.source, `${field}.provenance.source`, [
        "adapter",
        "bridge",
      ] as const),
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
  const durationMs =
    source.durationMs === undefined
      ? undefined
      : finiteNumber(source.durationMs, `${field}.durationMs`);
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
  const effectObservation =
    source.effectObservation === undefined
      ? { complete: true, diagnostics: [] }
      : objectValue(source.effectObservation, `${field}.effectObservation`);
  if (typeof effectObservation.complete !== "boolean") {
    corrupt(`${field}.effectObservation.complete must be a boolean.`);
  }
  const usage = source.usage === undefined ? undefined : parseUsage(source.usage, `${field}.usage`);
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
    effects: source.effects.map((effect, index) =>
      parseEffect(effect, `${field}.effects[${index}]`),
    ),
    effectObservation: {
      complete: effectObservation.complete,
      diagnostics: stringList(
        effectObservation.diagnostics ?? [],
        `${field}.effectObservation.diagnostics`,
      ),
    },
    ...(usage === undefined ? {} : { usage }),
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
  let request: StartInvocationRequest;
  try {
    request = parseStartInvocationRequest(source.request);
  } catch (error) {
    throw new BridgeError(
      {
        code: "internal_error",
        message: `Persisted broker state is invalid: ${field}.request failed validation.`,
        retryable: false,
      },
      { cause: error },
    );
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
  const events = source.events.map((event, eventIndex) =>
    parseEvent(event, `${field}.events[${eventIndex}]`, invocationId, eventIndex + 1),
  );
  const persistedEventCount =
    source.eventCount === undefined
      ? events.length
      : finiteNumber(source.eventCount, `${field}.eventCount`);
  if (!Number.isSafeInteger(persistedEventCount) || persistedEventCount < 0) {
    corrupt(`${field}.eventCount must be a non-negative safe integer.`);
  }
  const eventCount = Math.max(events.length, persistedEventCount);
  const outcome =
    source.outcome === undefined
      ? undefined
      : parseOutcome(source.outcome, `${field}.outcome`, invocationId, policy);
  if (TERMINAL_STATES.has(state) !== (outcome !== undefined)) {
    corrupt(`${field} must have exactly one outcome if and only if it is terminal.`);
  }
  const callerCorrelationId = optionalString(
    source.callerCorrelationId,
    `${field}.callerCorrelationId`,
  );
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
    eventCount,
    events,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function parseTombstone(value: unknown, index: number): InvocationTombstone {
  const field = `tombstones[${index}]`;
  const source = objectValue(value, field);
  return {
    invocationId: requiredString(source.invocationId, `${field}.invocationId`),
    evictedAt: requiredString(source.evictedAt, `${field}.evictedAt`),
    reason: literal(source.reason, `${field}.reason`, ["retention"] as const),
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
    tombstones:
      source.tombstones === undefined
        ? []
        : Array.isArray(source.tombstones)
          ? source.tombstones.map(parseTombstone)
          : corrupt("tombstones must be an array."),
  };
}

export class InvocationStore {
  readonly #stateFile: string;
  readonly #stateDirectory: string;
  readonly #invocationsDirectory: string;
  readonly #tombstonesFile: string;
  readonly #knownSequences = new Map<string, number>();
  readonly #knownRecords = new Map<string, InvocationRecord>();
  readonly #knownSizes = new Map<string, FileSizes>();
  #tombstonesBytes = 0;
  #manifestBytes = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(stateFile: string) {
    this.#stateFile = stateFile;
    this.#stateDirectory = dirname(stateFile);
    this.#invocationsDirectory = join(this.#stateDirectory, "invocations");
    this.#tombstonesFile = join(this.#stateDirectory, "tombstones.json");
  }

  get path(): string {
    return this.#stateFile;
  }

  get directory(): string {
    return this.#stateDirectory;
  }

  async load(): Promise<StoreSnapshot> {
    let text: string | undefined;
    try {
      text = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return this.#loadDirectory();
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch (error) {
      throw new BridgeError(
        {
          code: "internal_error",
          message: "Persisted broker state is not valid JSON.",
          retryable: false,
        },
        { cause: error },
      );
    }
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      !Array.isArray(decoded) &&
      "storageVersion" in decoded &&
      decoded.storageVersion === 2
    ) {
      return this.#loadDirectory();
    }
    const state = parseState(decoded);
    await this.#ensureDirectories();
    await this.#writeRecords(state.invocations);
    await this.#writeTombstones(state.tombstones);
    await this.#writeManifest();
    return { invocations: state.invocations, tombstones: state.tombstones };
  }

  async save(
    invocations: readonly InvocationRecord[],
    tombstones: readonly InvocationTombstone[] = [],
  ): Promise<void> {
    const work = async (): Promise<void> => {
      await this.#ensureDirectories();
      await this.#writeRecords(invocations);
      const retained = new Set(invocations.map((record) => record.invocationId));
      // oxlint-disable-next-line unicorn/no-useless-spread -- the loop body deletes from #knownSequences while iterating it
      for (const invocationId of [...this.#knownSequences.keys()]) {
        if (retained.has(invocationId)) {
          continue;
        }
        await rm(this.#invocationDirectory(invocationId), { recursive: true, force: true });
        this.#knownSequences.delete(invocationId);
        this.#knownRecords.delete(invocationId);
        this.#knownSizes.delete(invocationId);
      }
      await this.#writeTombstones(tombstones);
      await this.#writeManifest();
    };
    const scheduled = this.#writeTail.then(work, work);
    this.#writeTail = scheduled;
    await scheduled;
  }

  retainedBytes(): number {
    let total = this.#tombstonesBytes + this.#manifestBytes;
    for (const sizes of this.#knownSizes.values()) {
      total += sizes.events + sizes.metadata + sizes.outcome;
    }
    return total;
  }

  invocationBytes(invocationId: string): number {
    const sizes = this.#knownSizes.get(invocationId);
    return sizes === undefined ? 0 : sizes.events + sizes.metadata + sizes.outcome;
  }

  async events(invocationId: string): Promise<readonly InvocationEvent[]> {
    await this.#writeTail;
    return this.#readEvents(
      join(this.#invocationDirectory(invocationId), "events.jsonl"),
      invocationId,
    );
  }

  async #loadDirectory(): Promise<StoreSnapshot> {
    const invocations: InvocationRecord[] = [];
    let entries: Dirent[];
    try {
      entries = await readdir(this.#invocationsDirectory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await this.#refreshAuxiliarySizes();
        return { invocations: [], tombstones: [] };
      }
      throw error;
    }
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const invocationId = decodeURIComponent(entry.name);
      const directory = this.#invocationDirectory(invocationId);
      const metadata = objectValue(
        await this.#readJson(join(directory, "meta.json"), `meta for ${invocationId}`),
        `meta for ${invocationId}`,
      );
      const events = await this.#readEvents(join(directory, "events.jsonl"), invocationId);
      let outcome: unknown;
      try {
        outcome = await this.#readJson(
          join(directory, "outcome.json"),
          `outcome for ${invocationId}`,
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      invocations.push(
        parseInvocation(
          {
            ...metadata,
            events,
            ...(outcome === undefined ? {} : { outcome }),
          },
          invocations.length,
        ),
      );
      const record = invocations.at(-1);
      if (record === undefined) {
        corrupt(`invocation ${invocationId} could not be loaded.`);
      }
      this.#knownSequences.set(invocationId, events.length);
      this.#knownRecords.set(invocationId, record);
      this.#knownSizes.set(invocationId, {
        events: await this.#fileSize(join(directory, "events.jsonl")),
        metadata: await this.#fileSize(join(directory, "meta.json")),
        outcome: await this.#fileSize(join(directory, "outcome.json")),
      });
    }
    let tombstones: readonly InvocationTombstone[] = [];
    try {
      const source = objectValue(
        await this.#readJson(this.#tombstonesFile, "tombstones"),
        "tombstones",
      );
      if (!Array.isArray(source.tombstones)) {
        corrupt("tombstones.tombstones must be an array.");
      }
      tombstones = source.tombstones.map(parseTombstone);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await this.#refreshAuxiliarySizes();
    return { invocations, tombstones };
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.#invocationsDirectory, { recursive: true, mode: 0o700 });
  }

  #invocationDirectory(invocationId: string): string {
    return join(this.#invocationsDirectory, encodeURIComponent(invocationId));
  }

  async #writeRecords(invocations: readonly InvocationRecord[]): Promise<void> {
    for (const record of invocations) {
      const directory = this.#invocationDirectory(record.invocationId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const sizes = this.#knownSizes.get(record.invocationId) ?? {
        events: 0,
        metadata: 0,
        outcome: 0,
      };
      const eventsPath = join(directory, "events.jsonl");
      const eventsLoaded = record.events.length === record.eventCount;
      if (eventsLoaded) {
        let previousSequence = this.#knownSequences.get(record.invocationId) ?? 0;
        if (record.events.length < previousSequence) {
          await writeFile(eventsPath, "", { encoding: "utf8", mode: 0o600 });
          previousSequence = 0;
          sizes.events = 0;
        }
        if (record.events.length > previousSequence) {
          const events = record.events.slice(previousSequence);
          const serialized = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
          await appendFile(eventsPath, serialized, { encoding: "utf8", mode: 0o600 });
          sizes.events += Buffer.byteLength(serialized, "utf8");
        }
        this.#knownSequences.set(record.invocationId, record.events.length);
      }
      const { events: _events, outcome: _outcome, ...metadata } = record;
      const previous = this.#knownRecords.get(record.invocationId);
      if (previous === undefined || metadataChanged(previous, record)) {
        sizes.metadata = await this.#writeJson(join(directory, "meta.json"), metadata);
      }
      if (previous === undefined || previous.outcome !== record.outcome) {
        if (record.outcome === undefined) {
          await rm(join(directory, "outcome.json"), { force: true });
          sizes.outcome = 0;
        } else {
          sizes.outcome = await this.#writeJson(join(directory, "outcome.json"), record.outcome);
        }
      }
      this.#knownRecords.set(record.invocationId, record);
      this.#knownSizes.set(record.invocationId, sizes);
    }
  }

  async #writeTombstones(tombstones: readonly InvocationTombstone[]): Promise<void> {
    this.#tombstonesBytes = await this.#writeJson(this.#tombstonesFile, {
      storageVersion: 2,
      tombstones,
    });
  }

  async #writeManifest(): Promise<void> {
    this.#manifestBytes = await this.#writeJson(this.#stateFile, {
      storageVersion: 2,
      format: "directory-v1",
    });
  }

  async #writeJson(path: string, value: unknown): Promise<number> {
    const temporaryFile = join(dirname(path), `.state-${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temporaryFile, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, path);
    return Buffer.byteLength(serialized, "utf8");
  }

  async #fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return 0;
      }
      throw error;
    }
  }

  async #refreshAuxiliarySizes(): Promise<void> {
    this.#tombstonesBytes = await this.#fileSize(this.#tombstonesFile);
    this.#manifestBytes = await this.#fileSize(this.#stateFile);
  }

  async #readJson(path: string, field: string): Promise<unknown> {
    const text = await readFile(path, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new BridgeError(
        {
          code: "internal_error",
          message: `Persisted broker ${field} is not valid JSON.`,
          retryable: false,
        },
        { cause: error },
      );
    }
  }

  async #readEvents(path: string, invocationId: string): Promise<readonly InvocationEvent[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    return text
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line, index) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(line) as unknown;
        } catch (error) {
          throw new BridgeError(
            {
              code: "internal_error",
              message: `Persisted events for ${invocationId} are not valid JSON.`,
              retryable: false,
            },
            { cause: error },
          );
        }
        return parseEvent(decoded, `events[${index}]`, invocationId, index + 1);
      });
  }
}

function metadataChanged(previous: InvocationRecord, current: InvocationRecord): boolean {
  return (
    previous.schemaVersion !== current.schemaVersion ||
    previous.invocationId !== current.invocationId ||
    previous.callerCorrelationId !== current.callerCorrelationId ||
    previous.idempotencyKey !== current.idempotencyKey ||
    previous.requestDigest !== current.requestDigest ||
    previous.request !== current.request ||
    previous.resolvedRoute !== current.resolvedRoute ||
    previous.policy !== current.policy ||
    previous.state !== current.state ||
    previous.createdAt !== current.createdAt ||
    previous.startedAt !== current.startedAt
  );
}
