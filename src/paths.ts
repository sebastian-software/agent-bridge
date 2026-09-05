import { homedir, tmpdir } from "node:os";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { BridgeError } from "./errors.js";

export interface BrokerPaths {
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly stateFile: string;
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

function usableEnvironmentPath(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function brokerPaths(): BrokerPaths {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const runtimeDirectory = usableEnvironmentPath("AGENT_BRIDGE_RUNTIME_DIR")
    ?? usableEnvironmentPath("XDG_RUNTIME_DIR")
    ?? join(tmpdir(), `agent-bridge-${uid}`);
  const stateDirectory = usableEnvironmentPath("AGENT_BRIDGE_STATE_DIR")
    ?? join(usableEnvironmentPath("XDG_STATE_HOME") ?? join(homedir(), ".local", "state"), "agent-bridge");
  return {
    runtimeDirectory,
    stateDirectory,
    socketPath: usableEnvironmentPath("AGENT_BRIDGE_SOCKET_PATH") ?? join(runtimeDirectory, "broker.sock"),
    stateFile: join(stateDirectory, "state.json"),
  };
}
