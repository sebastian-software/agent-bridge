import assert from "node:assert/strict";
import test from "node:test";

import { brokerPaths } from "../src/paths.js";

test("scopes the default XDG socket and exposes the legacy migration path", () => {
  assert.deepEqual(
    brokerPaths({ XDG_RUNTIME_DIR: "/tmp/agent-bridge-runtime", XDG_STATE_HOME: "/tmp/state" }),
    {
      runtimeDirectory: "/tmp/agent-bridge-runtime/agent-bridge",
      stateDirectory: "/tmp/state/agent-bridge",
      socketPath: "/tmp/agent-bridge-runtime/agent-bridge/broker.sock",
      legacySocketPath: "/tmp/agent-bridge-runtime/broker.sock",
      stateFile: "/tmp/state/agent-bridge/state.json",
    },
  );
});

test("explicit runtime and socket overrides do not invent a legacy path", () => {
  const paths = brokerPaths({
    AGENT_BRIDGE_RUNTIME_DIR: "/tmp/custom-runtime",
    AGENT_BRIDGE_SOCKET_PATH: "/tmp/custom.sock",
    XDG_RUNTIME_DIR: "/tmp/agent-bridge-runtime",
  });
  assert.equal(paths.runtimeDirectory, "/tmp/custom-runtime");
  assert.equal(paths.socketPath, "/tmp/custom.sock");
  assert.equal(paths.legacySocketPath, undefined);
});
