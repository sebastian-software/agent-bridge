import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface BrokerPaths {
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly stateFile: string;
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
