import { lstat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeError } from "./errors.js";

export type BrokerPaths = {
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  /**
   * Legacy socket kept reachable while brokers started before the scoped path
   * existed may still be running. Removal is tracked in issue #127, targeted at
   * the first release after 0.1.0.
   */
  readonly legacySocketPath?: string;
  readonly stateFile: string;
};

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
  const configuredRuntimeDirectory = usableEnvironmentPath("AGENT_BRIDGE_RUNTIME_DIR", environment);
  const xdgRuntimeDirectory = usableEnvironmentPath("XDG_RUNTIME_DIR", environment);
  const configuredSocketPath = usableEnvironmentPath("AGENT_BRIDGE_SOCKET_PATH", environment);
  const runtimeDirectory =
    configuredRuntimeDirectory ??
    (xdgRuntimeDirectory === undefined ? undefined : join(xdgRuntimeDirectory, "agent-bridge")) ??
    join(tmpdir(), `agent-bridge-${uid}`);
  const stateDirectory =
    usableEnvironmentPath("AGENT_BRIDGE_STATE_DIR", environment) ??
    join(
      usableEnvironmentPath("XDG_STATE_HOME", environment) ?? join(homedir(), ".local", "state"),
      "agent-bridge",
    );
  return {
    runtimeDirectory,
    stateDirectory,
    socketPath: configuredSocketPath ?? join(runtimeDirectory, "broker.sock"),
    ...(configuredSocketPath === undefined &&
    configuredRuntimeDirectory === undefined &&
    xdgRuntimeDirectory !== undefined
      ? { legacySocketPath: join(xdgRuntimeDirectory, "broker.sock") }
      : {}),
    stateFile: join(stateDirectory, "state.json"),
  };
}
