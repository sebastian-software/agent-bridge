import assert from "node:assert/strict";
import test from "node:test";

import { brokerPaths } from "../src/paths.js";

test("scopes the default XDG socket without an unscoped fallback", () => {
  assert.deepEqual(
    brokerPaths({ XDG_RUNTIME_DIR: "/tmp/harness-relay-runtime", XDG_STATE_HOME: "/tmp/state" }),
    {
      runtimeDirectory: "/tmp/harness-relay-runtime/harness-relay",
      stateDirectory: "/tmp/state/harness-relay",
      socketPath: "/tmp/harness-relay-runtime/harness-relay/broker.sock",
      stateFile: "/tmp/state/harness-relay/state.json",
    },
  );
});

test("explicit runtime and socket overrides take precedence", () => {
  const paths = brokerPaths({
    HARNESS_RELAY_RUNTIME_DIR: "/tmp/custom-runtime",
    HARNESS_RELAY_SOCKET_PATH: "/tmp/custom.sock",
    XDG_RUNTIME_DIR: "/tmp/harness-relay-runtime",
  });
  assert.equal(paths.runtimeDirectory, "/tmp/custom-runtime");
  assert.equal(paths.socketPath, "/tmp/custom.sock");
});
