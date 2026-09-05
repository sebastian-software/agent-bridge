import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { Adapter, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import { Broker } from "../src/broker.js";
import type {
  ObservedIdentity,
  RouteDescriptor,
  StartInvocationRequest,
  StartInvocationResult,
} from "../src/contract.js";
import { BridgeError } from "../src/errors.js";
import type { BrokerPaths } from "../src/paths.js";
import { ensurePrivateDirectory } from "../src/paths.js";

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

class InteractiveAdapter implements Adapter {
  readonly id = "interactive";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [
      {
        routeId: "interactive:test",
        provider: "agent-bridge",
        model: "interactive",
        efforts: ["low", "medium", "high"],
        via: "interactive",
        adapter: this.id,
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        capabilities: ["core.input.text", "core.output.text"],
        interactionStrategies: ["orchestrator"],
        assurance: "none",
        runtimeIdentityEvidence: "verified",
        readiness: "ready",
        qualification: [
          {
            qualificationId: "interactive-v1",
            testedAt: "2026-08-27T00:00:00.000Z",
            claim: "Deterministic interactive fixture for broker tests.",
          },
        ],
        diagnostics: [],
      },
    ];
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    await context.emit({
      category: "input_required",
      inputRequest: { requestId: "permission-1", kind: "permission", prompt: "Allow the fixture?" },
    });
    assert.ok(context.awaitInput);
    const response = await context.awaitInput("permission-1", context.signal);
    await context.emit({ category: "output", content: [{ type: "text", text: response.decision }] });
    const identity: ObservedIdentity = {
      provider: { value: "agent-bridge", evidence: "verified", source: "interactive-fixture" },
      model: { value: "interactive", evidence: "verified", source: "interactive-fixture" },
      harnessVersion: { value: "1.0.0", evidence: "verified", source: "interactive-fixture" },
      nativeSessionId: { evidence: "unverified" },
    };
    return {
      content: [{ type: "text", text: response.decision }],
      artifacts: [],
      effects: [],
      observedIdentity: identity,
    };
  }
}

class NativePayloadAdapter implements Adapter {
  readonly id = "native-payload";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [
      {
        routeId: "native-payload:test",
        provider: "agent-bridge",
        model: "native-payload",
        efforts: ["high"],
        via: "native-payload",
        adapter: this.id,
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        capabilities: ["core.input.text", "core.output.text"],
        interactionStrategies: ["deny"],
        assurance: "none",
        runtimeIdentityEvidence: "verified",
        readiness: "ready",
        qualification: [
          { qualificationId: "native-v1", testedAt: "2026-08-27T00:00:00.000Z", claim: "Native payload fixture." },
        ],
        diagnostics: [],
      },
    ];
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    await context.emit({
      category: "output",
      content: [{ type: "text", text: "done" }],
      native: { type: "assistant", model: "fixture", secret: "do-not-persist" },
    });
    return {
      content: [{ type: "text", text: "done" }],
      artifacts: [],
      effects: [],
      observedIdentity: {
        provider: { value: "agent-bridge", evidence: "verified", source: "native-fixture" },
        model: { value: "native-payload", evidence: "verified", source: "native-fixture" },
        harnessVersion: { value: "1.0.0", evidence: "verified", source: "native-fixture" },
        nativeSessionId: { evidence: "unverified" },
      },
    };
  }
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

    const listed = (await broker.execute("invocation.list", {
      callerCorrelationId: undefined,
      includeTombstones: false,
    })) as { invocations: readonly { invocationId: string; resolvedRouteId: string }[] };
    assert.equal(listed.invocations[0]?.invocationId, started.invocationId);
    assert.equal(listed.invocations[0]?.resolvedRouteId, "fake:fake-echo");

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
      broker.start(
        request(root, "fake-echo", {
          idempotencyKey: "same-request",
          input: [{ type: "text", text: "different" }],
        }),
      ),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("store persists invocation metadata and events in separate files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-store-layout-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-echo"));
    await waitForTerminal(broker, started.invocationId);
    const manifest = JSON.parse(await readFile(paths(root).stateFile, "utf8")) as {
      storageVersion?: unknown;
      format?: unknown;
    };
    assert.deepEqual(manifest, { storageVersion: 2, format: "directory-v1" });
    const invocationDirectory = join(
      paths(root).stateDirectory,
      "invocations",
      encodeURIComponent(started.invocationId),
    );
    const metadata = JSON.parse(await readFile(join(invocationDirectory, "meta.json"), "utf8")) as {
      events?: unknown;
      outcome?: unknown;
      state?: unknown;
    };
    assert.equal(metadata.events, undefined);
    assert.equal(metadata.outcome, undefined);
    assert.equal(metadata.state, "succeeded");
    const eventLines = (await readFile(join(invocationDirectory, "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(eventLines.length, (await broker.events({ invocationId: started.invocationId })).events.length);
    assert.ok(await readFile(join(invocationDirectory, "outcome.json"), "utf8"));
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

test("forced broker shutdown records active invocations as interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-shutdown-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-slow"));
    await assert.rejects(
      broker.execute("system.shutdown", {}),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
    );
    const accepted = (await broker.execute("system.shutdown", { force: true })) as {
      accepted: boolean;
      activeInvocations: number;
    };
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.activeInvocations, 1);
    await broker.close();
    const terminal = await broker.inspect(started.invocationId);
    assert.equal(stateOf(terminal), "interrupted");
    assert.equal((terminal.outcome as { error?: { code?: string } }).error?.code, "broker_shutdown");
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("private broker directories reject world-writable paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-private-dir-"));
  const wide = join(root, "wide");
  try {
    await mkdir(wide);
    await chmod(wide, 0o777);
    await assert.rejects(
      ensurePrivateDirectory(wide, "state"),
      (error: unknown) => error instanceof BridgeError && error.code === "broker_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker supervises the fake harness process across success and failure scenarios", async () => {
  const scenarios = [
    { model: "success", state: "succeeded" },
    { model: "truncated", state: "succeeded" },
    { model: "failure", state: "failed", errorCode: "harness_failed" },
    { model: "malformed", state: "failed", errorCode: "output_unparseable" },
    { model: "timeout", state: "timed_out", timeoutMs: 100 },
    { model: "effects", state: "succeeded" },
  ] as const;
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `agent-bridge-process-${scenario.model}-`));
    const broker = new Broker(paths(root));
    await broker.initialize();
    try {
      const started = await broker.start(
        request(root, scenario.model, {
          selector: {
            provider: "agent-bridge",
            model: scenario.model,
            via: "fake-process",
            effort: "high",
            requiredCapabilities: ["core.input.text"],
          },
          interactionStrategy: "deny",
          ...(!("timeoutMs" in scenario) ? {} : { timeoutMs: scenario.timeoutMs }),
        }),
      );
      const terminal = await waitForTerminal(broker, started.invocationId);
      assert.equal(stateOf(terminal), scenario.state);
      if ("errorCode" in scenario) {
        assert.equal((terminal.outcome as { error?: { code?: string } }).error?.code, scenario.errorCode);
      }
      if (scenario.model === "success") {
        assert.deepEqual((terminal.outcome as { content: unknown }).content, [{ type: "text", text: "echo this" }]);
      }
      if (scenario.model === "effects") {
        assert.ok(
          (terminal.outcome as { effects: readonly { path: string }[] }).effects.some((effect) =>
            effect.path.endsWith("fake-renamed.txt"),
          ),
        );
      }
    } finally {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("broker cancellation terminates a supervised fake harness process", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-process-cancel-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "cancel", {
        selector: {
          provider: "agent-bridge",
          model: "cancel",
          via: "fake-process",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
        interactionStrategy: "deny",
      }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (stateOf(await broker.inspect(started.invocationId)) === "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await broker.cancel(started.invocationId);
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "cancelled");
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker resumes an invocation after an orchestrator input response", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-input-"));
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([new InteractiveAdapter()]) });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "interactive", {
        selector: {
          provider: "agent-bridge",
          model: "interactive",
          via: "interactive",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (stateOf(await broker.inspect(started.invocationId)) === "waiting_for_input") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stateOf(await broker.inspect(started.invocationId)), "waiting_for_input");
    const response = (await broker.execute("invocation.respond", {
      invocationId: started.invocationId,
      requestId: "permission-1",
      decision: "allow",
    })) as { readonly accepted: boolean };
    assert.equal(response.accepted, true);
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "succeeded");
    assert.deepEqual((terminal.outcome as { content: unknown }).content, [{ type: "text", text: "allow" }]);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker keeps native payloads bounded unless diagnostic mode is enabled", async () => {
  const regularRoot = await mkdtemp(join(tmpdir(), "agent-bridge-native-regular-"));
  const diagnosticRoot = await mkdtemp(join(tmpdir(), "agent-bridge-native-diagnostic-"));
  const run = async (root: string, diagnosticMode: boolean): Promise<Readonly<Record<string, unknown>>> => {
    const broker = new Broker(paths(root), {
      registry: new AdapterRegistry([new NativePayloadAdapter()]),
      diagnosticMode,
    });
    await broker.initialize();
    try {
      const started = await broker.start(
        request(root, "native-payload", {
          selector: {
            provider: "agent-bridge",
            model: "native-payload",
            via: "native-payload",
            effort: "high",
            requiredCapabilities: ["core.input.text"],
          },
          interactionStrategy: "deny",
        }),
      );
      return await waitForTerminal(broker, started.invocationId);
    } finally {
      await broker.close();
    }
  };
  try {
    const regular = await run(regularRoot, false);
    const diagnostic = await run(diagnosticRoot, true);
    const regularEvent = (regular.outcome as { content: unknown }).content;
    assert.deepEqual(regularEvent, [{ type: "text", text: "done" }]);
    const regularEvents = await (async () => {
      const broker = new Broker(paths(regularRoot), { diagnosticMode: false });
      await broker.initialize();
      try {
        return broker.events({ invocationId: (regular as { invocationId: string }).invocationId });
      } finally {
        await broker.close();
      }
    })();
    const regularNative = regularEvents.events.find((event) => event.category === "output")?.native;
    assert.equal(regularNative?.secret, undefined);
    const diagnosticEvents = await (async () => {
      const broker = new Broker(paths(diagnosticRoot), { diagnosticMode: true });
      await broker.initialize();
      try {
        return broker.events({ invocationId: (diagnostic as { invocationId: string }).invocationId });
      } finally {
        await broker.close();
      }
    })();
    const diagnosticNative = diagnosticEvents.events.find((event) => event.category === "output")?.native;
    assert.equal(diagnosticNative?.secret, "do-not-persist");
  } finally {
    await rm(regularRoot, { recursive: true, force: true });
    await rm(diagnosticRoot, { recursive: true, force: true });
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

test("cancelled process invocations retain output and usage observed before termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-partial-result-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "slow", {
        selector: {
          provider: "agent-bridge",
          model: "slow",
          via: "fake-process",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
        interactionStrategy: "deny",
      }),
    );
    let after: string | undefined;
    let cancelled = false;
    for (let attempt = 0; attempt < 100 && !cancelled; attempt += 1) {
      const page = await broker.events({
        invocationId: started.invocationId,
        ...(after === undefined ? {} : { after }),
      });
      if (page.nextCursor !== undefined) {
        after = page.nextCursor;
      }
      if (page.events.some((event) => event.category === "output")) {
        await broker.cancel(started.invocationId);
        cancelled = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(cancelled, true);
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "cancelled");
    const outcome = terminal.outcome as {
      content: readonly { type: string; text?: string }[];
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    assert.deepEqual(outcome.content, [{ type: "text", text: "echo this" }]);
    assert.deepEqual(
      outcome.usage && { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
      {
        inputTokens: 1,
        outputTokens: 1,
      },
    );
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
      broker.start(
        request(root, "fake-echo", {
          requestedPolicy: { minimumAssurance: "isolated" },
        }),
      ),
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
    await cp(paths(liveRoot).stateDirectory, paths(restartRoot).stateDirectory, { recursive: true });
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
