import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BrokerPaths } from "../src/paths.js";

import { Broker } from "../src/broker.js";
import { createClient } from "../src/client.js";
import { BrokerServer } from "../src/ipc.js";
import { PACKAGE_VERSION } from "../src/version.js";

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
      selector: {
        provider: "agent-bridge",
        model: "fake-echo",
        via: "fake",
        requiredCapabilities: [],
      },
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

test("typed client checks broker version once per client instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-client-cache-"));
  const socketPath = join(root, "broker.sock");
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(received.slice(0, newline)) as { id: string; operation: string };
      requests.push(request.operation);
      const result =
        request.operation === "system.status"
          ? { running: true, packageVersion: PACKAGE_VERSION, activeInvocations: 0, socketPath }
          : request.operation === "system.describe"
            ? { schemaVersion: "1.0", operationsVersion: "1.0", schemas: [], operations: [] }
            : { routes: [] };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const client = createClient({ socketPath, autostart: false });
    await client.describe();
    await client.routes();
    assert.deepEqual(requests, ["system.status", "system.describe", "route.discover"]);
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
});
