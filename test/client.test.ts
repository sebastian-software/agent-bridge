import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../src/broker.js";
import { createClient } from "../src/client.js";
import { BrokerServer } from "../src/ipc.js";
import type { BrokerPaths } from "../src/paths.js";

function paths(root: string): BrokerPaths {
  return {
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    socketPath: join(root, "run", "broker.sock"),
    stateFile: join(root, "state", "state.json"),
  };
}

test("typed client follows and runs an invocation through the broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-client-"));
  const brokerPaths = paths(root);
  const broker = new Broker(brokerPaths);
  await broker.initialize();
  const server = new BrokerServer(broker, brokerPaths.socketPath, brokerPaths.runtimeDirectory);
  await server.start();
  const client = createClient({ socketPath: brokerPaths.socketPath });
  try {
    const result = await client.run({
      selector: { provider: "agent-bridge", model: "fake-echo", via: "fake", requiredCapabilities: [] },
      input: [{ type: "text", text: "typed client" }],
      workingDirectory: root,
      interactionStrategy: "orchestrator",
      requestedPolicy: { minimumAssurance: "none" },
    });
    assert.equal(result.outcome.status, "succeeded");
    assert.equal((await client.list()).invocations.length, 1);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
