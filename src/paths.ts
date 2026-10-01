import { lstat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeError } from "./errors.js";

export type BrokerPaths = {
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly stateFile: string;
};

// Measured with Node's net module: macOS accepts 104-byte socket paths and
// rejects 105 with EINVAL; Linux's 108-byte sun_path keeps one byte for NUL.
const MAX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 104;

/** Fail with a readable diagnostic before a socket path is too long to bind or connect. */
export function assertSocketPathLength(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: `The broker socket path is ${String(bytes)} bytes long, but this platform allows at most ${String(MAX_SOCKET_PATH_BYTES)}: ${socketPath}. Set HARNESS_RELAY_RUNTIME_DIR or HARNESS_RELAY_SOCKET_PATH to a shorter path.`,
      retryable: false,
      details: { socketPath, bytes, maxBytes: MAX_SOCKET_PATH_BYTES },
    });
  }
}

export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: `Refusing a symbolic-link ${label} directory: ${path}.`,
      retryable: false,
    });
  }
  if (!info.isDirectory()) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: `The ${label} path is not a directory: ${path}.`,
      retryable: false,
    });
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: `The ${label} directory is not owned by the current user: ${path}.`,
      retryable: false,
    });
  }
  if ((info.mode & 0o077) !== 0) {
    throw new BridgeError({
      code: "broker_unavailable",
      message: `The ${label} directory must not be accessible by other users: ${path}.`,
      retryable: false,
    });
  }
}

function usableEnvironmentPath(name: string, environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function brokerPaths(environment: NodeJS.ProcessEnv = process.env): BrokerPaths {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const configuredRuntimeDirectory = usableEnvironmentPath(
    "HARNESS_RELAY_RUNTIME_DIR",
    environment,
  );
  const xdgRuntimeDirectory = usableEnvironmentPath("XDG_RUNTIME_DIR", environment);
  const configuredSocketPath = usableEnvironmentPath("HARNESS_RELAY_SOCKET_PATH", environment);
  const runtimeDirectory =
    configuredRuntimeDirectory ??
    (xdgRuntimeDirectory === undefined ? undefined : join(xdgRuntimeDirectory, "harness-relay")) ??
    join(tmpdir(), `harness-relay-${uid}`);
  const stateDirectory =
    usableEnvironmentPath("HARNESS_RELAY_STATE_DIR", environment) ??
    join(
      usableEnvironmentPath("XDG_STATE_HOME", environment) ?? join(homedir(), ".local", "state"),
      "harness-relay",
    );
  return {
    runtimeDirectory,
    stateDirectory,
    socketPath: configuredSocketPath ?? join(runtimeDirectory, "broker.sock"),
    stateFile: join(stateDirectory, "state.json"),
  };
}
