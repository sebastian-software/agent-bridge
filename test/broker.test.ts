import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Broker } from "../src/broker.js";
import type { StartInvocationRequest, StartInvocationResult } from "../src/contract.js";
import { BridgeError } from "../src/errors.js";
import type { BrokerPaths } from "../src/paths.js";

function paths(root: string): BrokerPaths {
  return {
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    socketPath: join(root, "run", "broker.sock"),
    stateFile: join(root, "state", "state.json"),
  };
}

function request(root: string, model: string, overrides?: Partial<StartInvocationRequest>): StartInvocationRequest {
  return {
    selector: {
      provider: "agent-bridge",
      model,
      via: "fake",
      effort: "high",
      requiredCapabilities: ["core.input.text"],
    },
    input: [{ type: "text", text: "echo this" }],
    workingDirectory: root,
    interactionStrategy: "orchestrator",
    requestedPolicy: { minimumAssurance: "none" },
    ...overrides,
  };
}

function stateOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("state" in value) || typeof value.state !== "string") {
    assert.fail("Expected an object with a string state.");
  }
  return value.state;
}

async function waitForTerminal(broker: Broker, invocationId: string): Promise<Readonly<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const inspected = await broker.inspect(invocationId);
    if (["cancelled", "failed", "interrupted", "succeeded", "timed_out"].includes(stateOf(inspected))) {
      return inspected;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Invocation did not become terminal.");
}

test("broker runs asynchronously, persists events, and deduplicates starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-broker-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const originalRequest = request(root, "fake-echo", { idempotencyKey: "same-request" });
    const started = await broker.start(originalRequest);
    assert.equal(started.state, "queued");
    assert.equal(started.deduplicated, false);

    const duplicate = await broker.start(originalRequest);
    assert.equal(duplicate.invocationId, started.invocationId);
    assert.equal(duplicate.deduplicated, true);

    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "succeeded");
    assert.ok("outcome" in terminal);

    const firstPage = await broker.events({ invocationId: started.invocationId });
    assert.ok(firstPage.events.length >= 5);
    assert.equal(firstPage.events[0]?.sequence, 1);
    assert.equal(firstPage.terminal, true);
    const cursor = firstPage.events[1]?.cursor;
    if (cursor === undefined) {
      assert.fail("Expected a second event cursor.");
    }
    const after = await broker.events({ invocationId: started.invocationId, after: cursor });
    assert.equal(after.events[0]?.sequence, 3);

    await assert.rejects(
      broker.start(request(root, "fake-echo", {
        idempotencyKey: "same-request",
        input: [{ type: "text", text: "different" }],
      })),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker cancels active adapter work before producing a terminal outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-cancel-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-slow"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (stateOf(await broker.inspect(started.invocationId)) === "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancellation = await broker.cancel(started.invocationId);
    assert.equal(stateOf(cancellation), "cancelling");
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "cancelled");
    assert.ok("outcome" in terminal);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker distinguishes timeout from caller cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-timeout-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-slow", { timeoutMs: 25 }));
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "timed_out");
    assert.ok("outcome" in terminal);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("route resolution rejects assurance the fake route cannot provide", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-policy-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    await assert.rejects(
      broker.start(request(root, "fake-echo", {
        requestedPolicy: { minimumAssurance: "isolated" },
      })),
      (error: unknown) => error instanceof BridgeError && error.code === "route_unavailable",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker rejects overlapping active invocations in one working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-concurrency-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const first = await broker.start(request(root, "fake-slow"));
    await assert.rejects(
      broker.start(request(root, "fake-slow", { idempotencyKey: "different" })),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
    );
    await broker.cancel(first.invocationId);
    await waitForTerminal(broker, first.invocationId);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart reconciliation marks a persisted active snapshot interrupted", async () => {
  const liveRoot = await mkdtemp(join(tmpdir(), "agent-bridge-live-"));
  const restartRoot = await mkdtemp(join(tmpdir(), "agent-bridge-restart-"));
  const liveBroker = new Broker(paths(liveRoot));
  await liveBroker.initialize();
  let started: StartInvocationResult | undefined;
  try {
    started = await liveBroker.start(request(liveRoot, "fake-slow"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (stateOf(await liveBroker.inspect(started.invocationId)) === "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const snapshot = await readFile(paths(liveRoot).stateFile, "utf8");
    await mkdir(paths(restartRoot).stateDirectory, { recursive: true });
    await writeFile(paths(restartRoot).stateFile, snapshot, "utf8");
  } finally {
    await liveBroker.close();
  }

  assert.notEqual(started, undefined);
  const restarted = new Broker(paths(restartRoot));
  await restarted.initialize();
  try {
    const inspected = await restarted.inspect(started.invocationId);
    assert.equal(stateOf(inspected), "interrupted");
  } finally {
    await restarted.close();
    await rm(liveRoot, { recursive: true, force: true });
    await rm(restartRoot, { recursive: true, force: true });
  }
});

test("retention evicts completed records and persists tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-retention-"));
  const brokerOptions = { retention: { completedMs: 0, maxBytes: 1_073_741_824 } };
  const broker = new Broker(paths(root), brokerOptions);
  await broker.initialize();
  let invocationId = "";
  try {
    invocationId = (await broker.start(request(root, "fake-echo"))).invocationId;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      broker.inspect(invocationId),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_evicted",
    );
  } finally {
    await broker.close();
  }

  const restarted = new Broker(paths(root), brokerOptions);
  await restarted.initialize();
  try {
    await assert.rejects(
      restarted.inspect(invocationId),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_evicted",
    );
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});
