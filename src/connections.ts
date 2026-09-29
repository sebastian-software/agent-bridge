import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BridgeError } from "./errors.js";
import { defaultCatalogPath } from "./model-catalog.js";

const CONNECTION_FILE_VERSION = 1 as const;
const CONNECTION_ID_PATTERN = /^[A-Z0-9][\w.-]{0,63}$/i;
const REVISION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION_LOCK_WAIT_MS = 5000;
const CONNECTION_LOCK_POLL_MS = 25;

export type UserConnectionsSnapshot = {
  readonly connections: readonly HarnessConnection[];
  /** Opaque content token for compare-and-swap writes; `missing` represents no file. */
  readonly revision: string;
};

export type UserConnectionsMutation<T> = {
  readonly connections: readonly HarnessConnection[];
  readonly result: T;
};

export type HarnessConnectionInput = {
  readonly id: string;
  readonly harness: string;
  readonly nativeContextRef: string;
  readonly purpose?: string;
};

export type HarnessConnection = {
  /** Opaque registration revision; changes whenever the registration changes. */
  readonly revision: string;
} & HarnessConnectionInput;

export type HarnessConnectionSummary = {
  readonly id: string;
  readonly harness: string;
  readonly revision: string;
  readonly purpose?: string;
};

/** Internal adapter binding. nativeContextRef is never part of a public route. */
export type AdapterConnectionContext = {
  readonly id: string;
  readonly harness: string;
  readonly nativeContextRef: string;
  readonly revision: string;
  /** Private executable captured from the same discovery snapshot as the route. */
  readonly executable?: string;
  readonly purpose?: string;
};

function invalid(message: string): never {
  throw new BridgeError({ code: "invalid_request", message, retryable: false });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  source: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(source).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    invalid(`${field} contains unsupported field ${unexpected}.`);
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !CONNECTION_ID_PATTERN.test(value)) {
    invalid(
      `${field} must be a stable identifier of at most 64 letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return value;
}

function contextReference(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${field} must be a non-empty native context reference.`);
  }
  return value;
}

function purpose(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${field} must be a non-empty string when present.`);
  }
  return value;
}

function parseConnectionInput(value: unknown, field: string): HarnessConnectionInput {
  const source = object(value, field);
  exactKeys(source, ["id", "harness", "nativeContextRef", "purpose"], field);
  const parsedPurpose = purpose(source.purpose, `${field}.purpose`);
  return {
    id: identifier(source.id, `${field}.id`),
    harness: identifier(source.harness, `${field}.harness`),
    nativeContextRef: contextReference(source.nativeContextRef, `${field}.nativeContextRef`),
    ...(parsedPurpose === undefined ? {} : { purpose: parsedPurpose }),
  };
}

function parseStoredConnection(value: unknown, field: string): HarnessConnection {
  const source = object(value, field);
  exactKeys(source, ["id", "harness", "nativeContextRef", "purpose", "revision"], field);
  const input = parseConnectionInput(
    {
      id: source.id,
      harness: source.harness,
      nativeContextRef: source.nativeContextRef,
      ...(source.purpose === undefined ? {} : { purpose: source.purpose }),
    },
    field,
  );
  if (typeof source.revision !== "string" || !REVISION_PATTERN.test(source.revision)) {
    invalid(`${field}.revision must be an opaque revision identifier.`);
  }
  return { ...input, revision: source.revision };
}

function parseConnectionFile(value: unknown, field: string): readonly HarnessConnection[] {
  const source = object(value, field);
  exactKeys(source, ["version", "connections"], field);
  if (source.version !== CONNECTION_FILE_VERSION) {
    invalid(`${field}.version is unsupported.`);
  }
  if (!Array.isArray(source.connections)) {
    invalid(`${field}.connections must be an array.`);
  }
  const connections = source.connections.map((entry, index) =>
    parseStoredConnection(entry, `${field}.connections[${index}]`),
  );
  const ids = new Set<string>();
  for (const connection of connections) {
    if (ids.has(connection.id)) {
      invalid(`${field}.connections contains duplicate id ${connection.id}.`);
    }
    ids.add(connection.id);
  }
  return connections;
}

export function defaultConnectionsPath(): string {
  return join(dirname(defaultCatalogPath()), "connections.json");
}

export function createHarnessConnection(value: unknown): HarnessConnection {
  return { ...parseConnectionInput(value, "connection"), revision: randomUUID() };
}

export function updateHarnessConnection(
  current: HarnessConnection,
  value: unknown,
): HarnessConnection {
  const next = parseConnectionInput(value, "connection");
  if (next.id !== current.id || next.harness !== current.harness) {
    invalid("A connection update must preserve its id and harness.");
  }
  return { ...next, revision: randomUUID() };
}

export function summarizeConnection(connection: HarnessConnection): HarnessConnectionSummary {
  return {
    id: connection.id,
    harness: connection.harness,
    revision: connection.revision,
    ...(connection.purpose === undefined
      ? {}
      : { purpose: connection.purpose.replaceAll(connection.nativeContextRef, "[redacted]") }),
  };
}

export function adapterConnectionContext(connection: HarnessConnection): AdapterConnectionContext {
  return {
    id: connection.id,
    harness: connection.harness,
    nativeContextRef: connection.nativeContextRef,
    revision: connection.revision,
    ...(connection.purpose === undefined ? {} : { purpose: connection.purpose }),
  };
}

export async function loadUserConnections(
  path = defaultConnectionsPath(),
): Promise<readonly HarnessConnection[]> {
  return (await loadUserConnectionsSnapshot(path)).connections;
}

export async function loadUserConnectionsSnapshot(
  path = defaultConnectionsPath(),
): Promise<UserConnectionsSnapshot> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { connections: [], revision: "missing" };
    }
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Connections file ${path} could not be read.`,
        retryable: false,
      },
      { cause: error },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Connections file ${path} is not valid JSON.`,
        retryable: false,
      },
      { cause: error },
    );
  }
  return {
    connections: parseConnectionFile(decoded, `connections file ${path}`),
    revision: snapshotRevision(text),
  };
}

export async function writeUserConnections(
  connections: readonly HarnessConnection[],
  options: { readonly expectedRevision: string; readonly path?: string },
): Promise<UserConnectionsSnapshot> {
  const normalized = parseConnectionFile(
    { version: CONNECTION_FILE_VERSION, connections },
    "connections",
  );
  const path = options.path ?? defaultConnectionsPath();
  return withConnectionLock(path, async () => {
    const current = await loadUserConnectionsSnapshot(path);
    if (current.revision !== options.expectedRevision) {
      throw new BridgeError({
        code: "connection_conflict",
        message: "The connection registrations changed since they were read. Refresh and retry.",
        retryable: true,
        details: { expectedRevision: options.expectedRevision, actualRevision: current.revision },
      });
    }
    await writeConnectionsAtomically(normalized, path);
    return loadUserConnectionsSnapshot(path);
  });
}

/** Serialize read/modify/write work across processes and preserve updates from every writer. */
export async function mutateUserConnections<T>(
  mutate: (
    current: readonly HarnessConnection[],
  ) => Promise<UserConnectionsMutation<T>> | UserConnectionsMutation<T>,
  path = defaultConnectionsPath(),
): Promise<{ readonly result: T; readonly snapshot: UserConnectionsSnapshot }> {
  return withConnectionLock(path, async () => {
    const current = await loadUserConnectionsSnapshot(path);
    const mutation = await mutate(current.connections);
    const normalized = parseConnectionFile(
      { version: CONNECTION_FILE_VERSION, connections: mutation.connections },
      "connections",
    );
    if (JSON.stringify(normalized) !== JSON.stringify(current.connections)) {
      await writeConnectionsAtomically(normalized, path);
    }
    return { result: mutation.result, snapshot: await loadUserConnectionsSnapshot(path) };
  });
}

function snapshotRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function writeConnectionsAtomically(
  normalized: readonly HarnessConnection[],
  path: string,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(
      `${JSON.stringify({ version: CONNECTION_FILE_VERSION, connections: normalized }, null, 2)}\n`,
      "utf8",
    );
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    if (file !== undefined) {
      await file.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Connections file ${path} could not be written atomically.`,
        retryable: false,
      },
      { cause: error },
    );
  }
}

type ConnectionLockOwner = { readonly pid: number; readonly token: string };

async function withConnectionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const startedAt = Date.now();
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (lock === undefined) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      await lock.sync();
    } catch (error) {
      if (lock !== undefined) {
        await lock.close().catch(() => {});
        lock = undefined;
        await rm(lockPath, { force: true }).catch(() => {});
      }
      if (!isAlreadyExists(error)) {
        throw new BridgeError(
          {
            code: "invalid_request",
            message: "The connection registration lock could not be acquired.",
            retryable: false,
          },
          { cause: error },
        );
      }
      if (Date.now() - startedAt >= CONNECTION_LOCK_WAIT_MS) {
        throw new BridgeError({
          code: "connection_conflict",
          message: await lockTimeoutMessage(lockPath),
          retryable: true,
        });
      }
      await delay(CONNECTION_LOCK_POLL_MS);
    }
  }

  const ownedStat = await lock.stat();
  try {
    return await action();
  } finally {
    await lock.close().catch(() => {});
    try {
      const currentStat = await stat(lockPath);
      const owner = await readLockOwner(lockPath);
      if (
        currentStat.dev === ownedStat.dev &&
        currentStat.ino === ownedStat.ino &&
        owner?.token === token
      ) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Preserve the mutation result; a leftover lock produces a bounded actionable timeout.
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function readLockOwner(lockPath: string): Promise<ConnectionLockOwner | undefined> {
  try {
    const source = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    if (
      typeof source === "object" &&
      source !== null &&
      "pid" in source &&
      typeof source.pid === "number" &&
      Number.isSafeInteger(source.pid) &&
      "token" in source &&
      typeof source.token === "string"
    ) {
      return { pid: source.pid, token: source.token };
    }
  } catch {
    // A lock holder may still be writing its small owner record.
  }
  return undefined;
}

async function lockTimeoutMessage(lockPath: string): Promise<string> {
  const owner = await readLockOwner(lockPath);
  return owner === undefined
    ? "Timed out waiting for connection registrations to be updated. Retry after the active writer finishes; if it crashed, verify no writer owns the lock before removing the lock file."
    : `Timed out waiting for connection registrations to be updated (lock owner PID ${owner.pid}). Retry after that writer finishes; if it crashed, verify the PID is no longer active before removing the lock file.`;
}
