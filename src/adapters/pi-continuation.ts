import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AdapterConnectionContext } from "../connections.js";
import type { ResolvedRoute, StartInvocationRequest } from "../contract.js";
import type { PiRuntimeConfiguration } from "./pi-supervisor.js";
import type { AdapterContinuationHandle } from "./types.js";

import { BridgeError } from "../errors.js";

const DEFAULT_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;

export type PiNativeSessionSnapshot = {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly terminalLeafId: string;
};

export type PiContinuationContext = {
  readonly request: StartInvocationRequest;
  readonly route: ResolvedRoute;
  readonly connection?: AdapterConnectionContext;
};

export type PiContinuationBindingOptions = {
  /** Require a live physical working directory when verifying a retained handle. */
  readonly requireWorkingDirectory?: boolean;
};

export type PiRetainedSession = {
  readonly directory: string;
  readonly snapshot: PiNativeSessionSnapshot;
};

function continuationError(
  code: "continuation_expired" | "continuation_route_changed" | "continuation_unavailable",
  message: string,
): BridgeError {
  return new BridgeError({ code, message, retryable: false });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

async function modelFileDigest(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      return createHash("sha256")
        .update(JSON.stringify(stableValue(parsed)))
        .digest("hex");
    } catch {
      return createHash("sha256").update(content).digest("hex");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Pi's auth and models stores create empty JSON objects when first read.
      return createHash("sha256").update("{}").digest("hex");
    }
    throw continuationError(
      "continuation_route_changed",
      "The Pi model configuration could not be verified for continuation.",
    );
  }
}

/** Bind a retained session to every input that can select or configure its Pi runtime. */
export async function piContinuationBinding(
  context: PiContinuationContext,
  configuration: PiRuntimeConfiguration,
  options: PiContinuationBindingOptions = {},
): Promise<string> {
  let workingDirectory: string;
  try {
    workingDirectory = await realpath(context.request.workingDirectory);
    if (!(await stat(workingDirectory)).isDirectory()) {
      throw new Error("working directory is not a directory");
    }
  } catch {
    if (options.requireWorkingDirectory) {
      throw continuationError(
        "continuation_route_changed",
        "The Pi working directory is missing or cannot be verified; continuation was rejected.",
      );
    }
    // Let the worker report ordinary start-time working-directory failures. A
    // failed fresh invocation cannot retain this fallback binding.
    workingDirectory = resolve(context.request.workingDirectory);
  }
  const modelFileDigests = await Promise.all(
    Object.values(configuration.modelFiles).map(async (path) => modelFileDigest(path)),
  );
  const material = {
    request: {
      selector: context.request.selector,
      workingDirectory,
      interactionStrategy: context.request.interactionStrategy,
      requestedPolicy: context.request.requestedPolicy,
      timeoutMs: context.request.timeoutMs,
    },
    route: context.route,
    connection: context.connection ?? null,
    configuration,
    modelFileDigests,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(material)))
    .digest("hex");
}

type RetainedRecord = {
  readonly binding: string;
  readonly directory: string;
  readonly expiresAt: string;
  readonly snapshot: PiNativeSessionSnapshot;
};

function isChildPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function validSessionFile(
  directory: string,
  sessionFile: string,
): Promise<{ readonly directory: string; readonly sessionFile: string }> {
  try {
    const [canonicalDirectory, canonicalFile, fileInfo] = await Promise.all([
      realpath(directory),
      realpath(sessionFile),
      lstat(sessionFile),
    ]);
    if (
      !fileInfo.isFile() ||
      fileInfo.isSymbolicLink() ||
      !isChildPath(canonicalDirectory, canonicalFile)
    ) {
      throw new Error("invalid native session path");
    }
    return { directory: canonicalDirectory, sessionFile: canonicalFile };
  } catch {
    throw continuationError(
      "continuation_unavailable",
      "The retained Pi session file is no longer available.",
    );
  }
}

export class PiContinuationStore {
  readonly #baseDirectory: string;
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, RetainedRecord>();
  #rootDirectory: Promise<string> | undefined;

  constructor(options?: { readonly baseDirectory?: string; readonly ttlMs?: number }) {
    this.#baseDirectory = options?.baseDirectory ?? tmpdir();
    this.#ttlMs = options?.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  }

  async createSessionDirectory(): Promise<string> {
    await this.#pruneExpired();
    const root = await this.#ensureRootDirectory();
    const directory = join(root, `session-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    return realpath(directory);
  }

  async retain(
    directory: string,
    snapshot: PiNativeSessionSnapshot,
    binding: string,
  ): Promise<AdapterContinuationHandle> {
    await this.#pruneExpired();
    if (
      snapshot.sessionId.length === 0 ||
      snapshot.cwd !== resolve(snapshot.cwd) ||
      snapshot.terminalLeafId.length === 0 ||
      !isAbsolute(snapshot.sessionFile)
    ) {
      throw continuationError(
        "continuation_unavailable",
        "Pi did not return a complete settled session checkpoint.",
      );
    }
    const validated = await validSessionFile(directory, snapshot.sessionFile);
    const normalizedSnapshot = Object.freeze({ ...snapshot, sessionFile: validated.sessionFile });
    const expiresAt = new Date(Date.now() + this.#ttlMs).toISOString();
    const reference = randomUUID();
    this.#sessions.set(reference, {
      binding,
      directory: validated.directory,
      expiresAt,
      snapshot: normalizedSnapshot,
    });
    return { reference, expiresAt };
  }

  async resume(handle: AdapterContinuationHandle, binding: string): Promise<PiRetainedSession> {
    if (handle.expiresAt !== undefined && Date.parse(handle.expiresAt) <= Date.now()) {
      await this.#pruneExpired();
      throw continuationError("continuation_expired", "The retained Pi session has expired.");
    }
    const record = this.#sessions.get(handle.reference);
    if (record === undefined) {
      throw continuationError(
        "continuation_unavailable",
        "The retained Pi session is unavailable in this broker process.",
      );
    }
    if (handle.expiresAt !== record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) {
      throw continuationError("continuation_expired", "The retained Pi session has expired.");
    }
    if (record.binding !== binding) {
      throw continuationError(
        "continuation_route_changed",
        "The Pi route, account, policy, or model configuration changed; continuation was rejected.",
      );
    }
    const validated = await validSessionFile(record.directory, record.snapshot.sessionFile);
    return {
      directory: validated.directory,
      snapshot: { ...record.snapshot, sessionFile: validated.sessionFile },
    };
  }

  async discardSessionDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    const root = await this.#rootDirectory;
    this.#sessions.clear();
    this.#rootDirectory = undefined;
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }

  async #ensureRootDirectory(): Promise<string> {
    this.#rootDirectory ??= mkdtemp(join(this.#baseDirectory, "harness-relay-pi-sessions-"));
    return this.#rootDirectory;
  }

  async #pruneExpired(): Promise<void> {
    const now = Date.now();
    const expiredDirectories = new Set<string>();
    for (const [reference, record] of this.#sessions) {
      if (Date.parse(record.expiresAt) <= now) {
        this.#sessions.delete(reference);
        expiredDirectories.add(record.directory);
      }
    }
    const retainedDirectories = new Set(
      [...this.#sessions.values()].map(({ directory }) => directory),
    );
    await Promise.all(
      [...expiredDirectories]
        .filter((directory) => !retainedDirectories.has(directory))
        .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}
