import assert from "node:assert/strict";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import { IpcClient } from "../src/ipc.js";
import { assertSocketPathLength, brokerPaths } from "../src/paths.js";

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

test("socket paths beyond the platform limit fail with a readable diagnostic", async () => {
  const limit = process.platform === "linux" ? 107 : 104;
  assert.doesNotThrow(() => {
    assertSocketPathLength(`/${"s".repeat(limit - 1)}`);
  });
  const tooLong = `/${"s".repeat(limit)}`;
  assert.throws(
    () => {
      assertSocketPathLength(tooLong);
    },
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "broker_unavailable" &&
      !error.retryable &&
      error.message.includes(`${String(limit + 1)} bytes long`) &&
      error.message.includes("HARNESS_RELAY_RUNTIME_DIR"),
  );
  await assert.rejects(
    new IpcClient(tooLong).request("system.describe", {}),
    (error: unknown) => error instanceof BridgeError && error.message.includes("bytes long"),
  );
});
