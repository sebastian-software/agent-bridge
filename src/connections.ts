import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BridgeError } from "./errors.js";
import { defaultCatalogPath } from "./model-catalog.js";

const CONNECTION_FILE_VERSION = 1 as const;
const CONNECTION_ID_PATTERN = /^[A-Z0-9][\w.-]{0,63}$/i;
const REVISION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
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
  return parseConnectionFile(decoded, `connections file ${path}`);
}

export async function writeUserConnections(
  connections: readonly HarnessConnection[],
  path = defaultConnectionsPath(),
): Promise<void> {
  const normalized = parseConnectionFile(
    { version: CONNECTION_FILE_VERSION, connections },
    "connections",
  );
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
