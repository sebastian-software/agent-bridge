import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Adapter,
  AdapterRunContext,
  AdapterRunResult,
  AdapterSendInputContext,
} from "../src/adapters/types.js";
import type {
  ContentPart,
  InvocationEvent,
  ObservedIdentity,
  RouteDescriptor,
  StartInvocationRequest,
  StartInvocationResult,
} from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import { BridgeError } from "../src/errors.js";
import { ensurePrivateDirectory } from "../src/paths.js";

function paths(root: string): BrokerPaths {
  return {
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    socketPath: join(root, "run", "broker.sock"),
    stateFile: join(root, "state", "state.json"),
  };
}

function request(
  root: string,
  model: string,
  overrides?: Partial<StartInvocationRequest>,
): StartInvocationRequest {
  return {
    selector: {
      provider: "harness-relay",
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

async function sendInvocationInput(
  broker: Broker,
  invocationId: string,
  text: string,
  idempotencyKey: string,
): Promise<unknown> {
  return broker.execute("invocation.send", {
    invocationId,
    input: [{ type: "text", text }],
    idempotencyKey,
  });
}

function stateOf(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("state" in value) ||
    typeof value.state !== "string"
  ) {
    assert.fail("Expected an object with a string state.");
  }
  return value.state;
}

async function waitForEviction(broker: Broker, invocationId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await broker.inspect(invocationId);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "invocation_evicted") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Invocation ${invocationId} was not evicted by retention.`);
}

async function waitForTerminal(
  broker: Broker,
  invocationId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const inspected = await broker.wait(invocationId, 15_000);
  if (inspected.waited !== true) assert.fail(`Invocation ${invocationId} did not become terminal.`);
  return inspected;
}

async function waitForState(broker: Broker, invocationId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (stateOf(await broker.inspect(invocationId)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Invocation ${invocationId} did not reach ${expected}.`);
}

async function waitForEventCount(
  broker: Broker,
  invocationId: string,
  category: string,
  count: number,
): Promise<readonly InvocationEvent[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const events = (await broker.events({ invocationId })).events;
    const matches = events.filter((event) => event.category === category);
    if (matches.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Invocation ${invocationId} did not record ${count} ${category} events.`);
}

class InteractiveAdapter implements Adapter {
  readonly id = "interactive";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [
      {
        routeId: "interactive:test",
        provider: "harness-relay",
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
    await context.emit({
      category: "output",
      content: [{ type: "text", text: response.decision }],
    });
    const identity: ObservedIdentity = {
      provider: { value: "harness-relay", evidence: "verified", source: "interactive-fixture" },
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
        provider: "harness-relay",
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
          {
            qualificationId: "native-v1",
            testedAt: "2026-08-27T00:00:00.000Z",
            claim: "Native payload fixture.",
          },
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
        provider: { value: "harness-relay", evidence: "verified", source: "native-fixture" },
        model: { value: "native-payload", evidence: "verified", source: "native-fixture" },
        harnessVersion: { value: "1.0.0", evidence: "verified", source: "native-fixture" },
        nativeSessionId: { evidence: "unverified" },
      },
    };
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const fixtureIdentity: ObservedIdentity = {
  provider: { value: "harness-relay", evidence: "verified", source: "dialogue-fixture" },
  model: { value: "dialogue", evidence: "verified", source: "dialogue-fixture" },
  harnessVersion: { value: "1.0.0", evidence: "verified", source: "dialogue-fixture" },
  nativeSessionId: { value: "dialogue-session", evidence: "reported", source: "dialogue-fixture" },
};

class ControlledDialogueAdapter implements Adapter {
  readonly id = "dialogue";
  readonly firstDeliveryStarted = deferred();
  readonly secondDeliveryStarted = deferred();
  readonly releaseFirstDelivery = deferred();
  readonly completeRun = deferred();
  readonly deliveryOrder: string[] = [];
  ignoreDeliveryCancellation = true;

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [
      {
        routeId: "dialogue:test",
        provider: "harness-relay",
        model: "dialogue",
        efforts: ["low", "medium", "high"],
        via: "dialogue",
        adapter: this.id,
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        capabilities: ["core.input.text", "steering"],
        interactionStrategies: ["orchestrator"],
        assurance: "none",
        runtimeIdentityEvidence: "verified",
        readiness: "ready",
        qualification: [
          {
            qualificationId: "dialogue-test-v1",
            testedAt: "2026-08-27T00:00:00.000Z",
            claim: "Deterministic fixture for ordered native input delivery tests.",
          },
        ],
        diagnostics: [],
      },
    ];
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        reject(new DOMException("The invocation was cancelled.", "AbortError"));
      };
      const onComplete = (): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        resolve({
          content: [{ type: "text", text: "dialogue complete" }],
          artifacts: [],
          effects: [],
          observedIdentity: fixtureIdentity,
        });
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.completeRun.promise.then(onComplete);
      if (context.signal.aborted) onAbort();
    });
  }

  async sendInput(context: AdapterSendInputContext): Promise<{ readonly boundary: "active-turn" }> {
    const value = context.content
      .map((part) => (part.type === "text" ? part.text : "[non-text]"))
      .join("");
    this.deliveryOrder.push(value);
    if (this.deliveryOrder.length === 1) {
      this.firstDeliveryStarted.resolve();
      if (this.ignoreDeliveryCancellation) {
        // Deliberately ignore cancellation so the broker must suppress a late ACK.
        await this.releaseFirstDelivery.promise;
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            context.signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Input delivery was cancelled.", "AbortError"));
          };
          context.signal.addEventListener("abort", onAbort, { once: true });
          if (context.signal.aborted) onAbort();
          this.releaseFirstDelivery.promise.then(() => {
            context.signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
    } else if (this.deliveryOrder.length === 2) {
      this.secondDeliveryStarted.resolve();
    }
    return { boundary: "active-turn" };
  }
}

class MutableContinuationAdapter implements Adapter {
  readonly id = "mutable-continuation";
  effortSupported = true;
  policySupported = true;
  failContinuation = false;
  pauseContinuation = false;

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [
      {
        routeId: "mutable-continuation:test",
        provider: "harness-relay",
        model: "mutable-continuation",
        efforts: this.effortSupported ? ["high"] : ["low"],
        via: this.id,
        adapter: this.id,
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        capabilities: ["core.input.text", "continuation"],
        interactionStrategies: ["orchestrator"],
        assurance: "none",
        runtimeIdentityEvidence: "verified",
        readiness: "ready",
        qualification: [
          {
            qualificationId: "mutable-continuation-v1",
            testedAt: "2026-08-27T00:00:00.000Z",
            claim: "Mutable route fixture for continuation re-resolution tests.",
          },
        ],
        diagnostics: [],
      },
    ];
  }

  resolvePolicy(): {
    readonly supported: boolean;
    readonly unsupported: readonly string[];
    readonly effectiveNativePolicy: Readonly<Record<string, never>>;
  } {
    return {
      supported: this.policySupported,
      unsupported: this.policySupported ? [] : ["commands"],
      effectiveNativePolicy: {},
    };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    if (context.continuationHandle !== undefined && this.pauseContinuation) {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          context.signal.removeEventListener("abort", abort);
          reject(new DOMException("The continued run was interrupted.", "AbortError"));
        };
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort();
      });
    }
    if (context.continuationHandle !== undefined && this.failContinuation) {
      throw new BridgeError({
        code: "harness_failed",
        message: "The continued native session did not settle.",
        retryable: false,
      });
    }
    return {
      content: [{ type: "text", text: "complete" }],
      artifacts: [],
      effects: [],
      observedIdentity: fixtureIdentity,
      continuationHandle: { reference: "retained-native-session" },
    };
  }
}

test("broker runs asynchronously, persists events, and deduplicates starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-broker-"));
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
    })) as { invocations: ReadonlyArray<{ invocationId: string; resolvedRouteId: string }> };
    assert.equal(listed.invocations[0]?.invocationId, started.invocationId);
    assert.equal(listed.invocations[0]?.resolvedRouteId, "fake:fake-echo");

    const active = (await broker.execute("invocation.list", {
      active: true,
      includeTombstones: false,
    })) as { invocations: readonly unknown[] };
    assert.equal(active.invocations.length, 0);

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

test("active input acceptance is idempotent and records only native delivery acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-send-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-slow"));
    await waitForState(broker, started.invocationId, "running");
    assert.ok(
      ((await broker.inspect(started.invocationId)).next as string[]).includes("invocation.send"),
    );
    const sendRequest = {
      invocationId: started.invocationId,
      input: [{ type: "text", text: "add one detail" }],
      idempotencyKey: "send-detail-1",
    };
    const accepted = (await broker.execute("invocation.send", sendRequest)) as {
      inputId: string;
      accepted: boolean;
      deduplicated: boolean;
      delivery: string;
    };
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.deduplicated, false);
    assert.equal(accepted.delivery, "pending");

    const duplicate = (await broker.execute("invocation.send", sendRequest)) as {
      inputId: string;
      deduplicated: boolean;
    };
    assert.equal(duplicate.inputId, accepted.inputId);
    assert.equal(duplicate.deduplicated, true);
    await assert.rejects(
      broker.execute("invocation.send", {
        ...sendRequest,
        input: [{ type: "text", text: "a different detail" }],
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
    );

    const events = await waitForEventCount(broker, started.invocationId, "input_delivered", 1);
    const acceptedEvent = events.find(
      (event) => event.category === "input_accepted" && event.data?.inputId === accepted.inputId,
    );
    const deliveredEvent = events.find(
      (event) => event.category === "input_delivered" && event.data?.inputId === accepted.inputId,
    );
    assert.ok(acceptedEvent);
    assert.ok(deliveredEvent);
    assert.ok(acceptedEvent.sequence < deliveredEvent.sequence);
    assert.equal(deliveredEvent.data?.evidence, "native_session_acknowledgement");
    assert.equal(deliveredEvent.data?.boundary, "next-supported-boundary");
    assert.equal(deliveredEvent.data?.modelConsumed, undefined);

    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.ok(
      ((await broker.inspect(started.invocationId)).next as string[]).includes(
        "invocation.continue",
      ),
    );
    assert.deepEqual((terminal.outcome as { content: readonly ContentPart[] }).content, [
      { type: "text", text: "echo this" },
      { type: "text", text: "add one detail" },
    ]);
    await assert.rejects(
      broker.execute("invocation.send", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "late" }],
        idempotencyKey: "send-late",
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_not_active",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("caller answers general delegate questions separately from permission decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-answer-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-question"));
    await waitForState(broker, started.invocationId, "waiting_for_input");
    const next = (await broker.inspect(started.invocationId)).next as string[];
    assert.ok(next.includes("invocation.answer"));
    assert.equal(next.includes("invocation.respond"), false);
    await assert.rejects(
      broker.execute("invocation.respond", {
        invocationId: started.invocationId,
        requestId: "fake-question-1",
        decision: "allow",
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_input_stale",
    );
    const response = (await broker.execute("invocation.answer", {
      invocationId: started.invocationId,
      requestId: "fake-question-1",
      answer: [{ type: "text", text: "inspect the source tree" }],
    })) as { accepted: boolean; state: string };
    assert.equal(response.accepted, true);
    assert.equal(response.state, "running");
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.deepEqual((terminal.outcome as { content: readonly ContentPart[] }).content, [
      { type: "text", text: "echo this" },
      { type: "text", text: "inspect the source tree" },
    ]);
    await assert.rejects(
      broker.execute("invocation.answer", {
        invocationId: started.invocationId,
        requestId: "fake-question-1",
        answer: [{ type: "text", text: "a second answer" }],
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invocation_not_active",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation creates an idempotent linked invocation with an immutable predecessor result", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-continue-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const original = await broker.start(request(root, "fake-echo"));
    const predecessor = await waitForTerminal(broker, original.invocationId);
    const predecessorOutcome = predecessor.outcome;
    const continuation = {
      invocationId: original.invocationId,
      input: [{ type: "text", text: "continue the same task" }],
      idempotencyKey: "follow-up-1",
    };
    const started = (await broker.execute("invocation.continue", continuation)) as {
      invocationId: string;
      deduplicated: boolean;
    };
    assert.notEqual(started.invocationId, original.invocationId);
    assert.equal(started.deduplicated, false);
    const duplicate = (await broker.execute("invocation.continue", continuation)) as {
      invocationId: string;
      deduplicated: boolean;
    };
    assert.equal(duplicate.invocationId, started.invocationId);
    assert.equal(duplicate.deduplicated, true);

    const child = await waitForTerminal(broker, started.invocationId);
    assert.equal((await broker.inspect(started.invocationId)).continuedFrom, original.invocationId);
    assert.deepEqual((child.outcome as { content: readonly ContentPart[] }).content, [
      { type: "text", text: "echo this" },
      { type: "text", text: "continue the same task" },
    ]);
    assert.deepEqual((await broker.result(original.invocationId)).outcome, predecessorOutcome);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed continuation drops the inherited handle and leaves the predecessor unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-continue-failed-"));
  const adapter = new MutableContinuationAdapter();
  adapter.failContinuation = true;
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([adapter]) });
  await broker.initialize();
  try {
    const original = await broker.start(
      request(root, "mutable-continuation", {
        selector: {
          provider: "harness-relay",
          model: "mutable-continuation",
          via: "mutable-continuation",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    const predecessor = await waitForTerminal(broker, original.invocationId);
    const predecessorOutcome = predecessor.outcome;
    const continued = (await broker.execute("invocation.continue", {
      invocationId: original.invocationId,
      input: [{ type: "text", text: "continue the task" }],
      idempotencyKey: "failed-continuation-1",
    })) as { invocationId: string };
    const failed = await waitForTerminal(broker, continued.invocationId);
    assert.equal(stateOf(failed), "failed");
    await assert.rejects(
      broker.execute("invocation.continue", {
        invocationId: continued.invocationId,
        input: [{ type: "text", text: "continue after the failure" }],
        idempotencyKey: "failed-continuation-2",
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    assert.deepEqual((await broker.result(original.invocationId)).outcome, predecessorOutcome);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation re-resolves route effort and policy before resuming a native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-continuation-route-"));
  const adapter = new MutableContinuationAdapter();
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([adapter]) });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "mutable-continuation", {
        selector: {
          provider: "harness-relay",
          model: "mutable-continuation",
          via: "mutable-continuation",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    await waitForTerminal(broker, started.invocationId);
    adapter.effortSupported = false;
    await assert.rejects(
      broker.execute("invocation.continue", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "do more" }],
        idempotencyKey: "route-changed-effort",
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    adapter.effortSupported = true;
    adapter.policySupported = false;
    await assert.rejects(
      broker.execute("invocation.continue", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "do more" }],
        idempotencyKey: "route-changed-policy",
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("active input delivery is FIFO for each invocation despite a delayed native ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-send-order-"));
  const adapter = new ControlledDialogueAdapter();
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([adapter]) });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "dialogue", {
        selector: {
          provider: "harness-relay",
          model: "dialogue",
          via: "dialogue",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    await sendInvocationInput(broker, started.invocationId, "first instruction", "ordered-send-1");
    await adapter.firstDeliveryStarted.promise;
    await sendInvocationInput(broker, started.invocationId, "later correction", "ordered-send-2");
    assert.deepEqual(adapter.deliveryOrder, ["first instruction"]);

    adapter.releaseFirstDelivery.resolve();
    await adapter.secondDeliveryStarted.promise;
    const events = await waitForEventCount(broker, started.invocationId, "input_delivered", 2);
    assert.deepEqual(adapter.deliveryOrder, ["first instruction", "later correction"]);
    const acceptedIds = events
      .filter((event) => event.category === "input_accepted")
      .map((event) => event.data?.inputId);
    const deliveredIds = events
      .filter((event) => event.category === "input_delivered")
      .map((event) => event.data?.inputId);
    assert.deepEqual(deliveredIds, acceptedIds);
    await broker.cancel(started.invocationId);
    await waitForTerminal(broker, started.invocationId);
  } finally {
    adapter.releaseFirstDelivery.resolve();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation expires queued inputs and suppresses a late delivery acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-send-cancel-"));
  const adapter = new ControlledDialogueAdapter();
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([adapter]) });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "dialogue", {
        selector: {
          provider: "harness-relay",
          model: "dialogue",
          via: "dialogue",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    await sendInvocationInput(broker, started.invocationId, "first instruction", "cancel-send-1");
    await adapter.firstDeliveryStarted.promise;
    await sendInvocationInput(broker, started.invocationId, "queued follow-up", "cancel-send-2");
    await broker.cancel(started.invocationId);
    await waitForTerminal(broker, started.invocationId);

    adapter.releaseFirstDelivery.resolve();
    await broker.close();
    const events = (await broker.events({ invocationId: started.invocationId })).events;
    assert.equal(events.filter((event) => event.category === "input_expired").length, 2);
    assert.equal(
      events.some((event) => event.category === "input_delivered"),
      false,
    );
  } finally {
    adapter.releaseFirstDelivery.resolve();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a finishing invocation never dispatches the next input while completion is settling", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-send-complete-race-"));
  const adapter = new ControlledDialogueAdapter();
  adapter.ignoreDeliveryCancellation = false;
  const broker = new Broker(paths(root), { registry: new AdapterRegistry([adapter]) });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "dialogue", {
        selector: {
          provider: "harness-relay",
          model: "dialogue",
          via: "dialogue",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    await sendInvocationInput(
      broker,
      started.invocationId,
      "first instruction",
      "completion-send-1",
    );
    await adapter.firstDeliveryStarted.promise;
    await sendInvocationInput(
      broker,
      started.invocationId,
      "queued follow-up",
      "completion-send-2",
    );

    adapter.completeRun.resolve();
    await waitForTerminal(broker, started.invocationId);
    assert.deepEqual(adapter.deliveryOrder, ["first instruction"]);
    const events = (await broker.events({ invocationId: started.invocationId })).events;
    assert.equal(events.filter((event) => event.category === "input_expired").length, 2);
    assert.equal(
      events.some((event) => event.category === "input_delivered"),
      false,
    );
  } finally {
    adapter.releaseFirstDelivery.resolve();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a route with no native active-input handler returns an explicit capability error", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-send-unsupported-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-echo"));
    await waitForState(broker, started.invocationId, "running");
    await assert.rejects(
      broker.execute("invocation.send", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "not supported" }],
        idempotencyKey: "unsupported-send",
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "unsupported_capability",
    );
    await broker.cancel(started.invocationId);
    await waitForTerminal(broker, started.invocationId);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("store persists invocation metadata and events in separate files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-store-layout-"));
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
    const eventLines = (await readFile(join(invocationDirectory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(
      eventLines.length,
      (await broker.events({ invocationId: started.invocationId })).events.length,
    );
    assert.ok(await readFile(join(invocationDirectory, "outcome.json"), "utf8"));
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("older invocation metadata without dialogue fields remains loadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-store-legacy-dialogue-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  let invocationId!: string;
  try {
    const started = await broker.start(request(root, "fake-echo"));
    invocationId = started.invocationId;
    await waitForTerminal(broker, invocationId);
  } finally {
    await broker.close();
  }

  const metadataPath = join(
    paths(root).stateDirectory,
    "invocations",
    encodeURIComponent(invocationId),
    "meta.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  delete metadata.continuationHandle;
  delete metadata.acceptedInputs;
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

  const restarted = new Broker(paths(root));
  await restarted.initialize();
  try {
    const inspected = await restarted.inspect(invocationId);
    assert.equal(stateOf(inspected), "succeeded");
    assert.deepEqual((inspected.outcome as { content: readonly ContentPart[] }).content, [
      { type: "text", text: "echo this" },
    ]);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("store appends activity events without rewriting stable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-store-writes-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(request(root, "fake-slow"));
    let running = await broker.inspect(started.invocationId);
    for (let attempt = 0; attempt < 100 && stateOf(running) !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      running = await broker.inspect(started.invocationId);
    }
    assert.equal(stateOf(running), "running");

    const metadataPath = join(
      paths(root).stateDirectory,
      "invocations",
      encodeURIComponent(started.invocationId),
      "meta.json",
    );
    const before = await stat(metadataPath);
    const initialEventCount = (running as { eventCount: number }).eventCount;
    let observed = running;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await broker.inspect(started.invocationId);
      if ((observed as { eventCount: number }).eventCount > initialEventCount) {
        break;
      }
    }
    assert.ok((observed as { eventCount: number }).eventCount > initialEventCount);
    const after = await stat(metadataPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker cancels active adapter work before producing a terminal outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-cancel-"));
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
  const root = await mkdtemp(join(tmpdir(), "harness-relay-shutdown-"));
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
    assert.equal(
      (terminal.outcome as { error?: { code?: string } }).error?.code,
      "broker_shutdown",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("private broker directories reject world-writable paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-private-dir-"));
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
    { model: "truncated", state: "failed", errorCode: "harness_failed" },
    { model: "final-no-newline", state: "succeeded" },
    { model: "failure", state: "failed", errorCode: "harness_failed" },
    { model: "malformed", state: "failed", errorCode: "output_unparseable" },
    { model: "malformed-after-output", state: "failed", errorCode: "output_unparseable" },
    { model: "timeout", state: "timed_out", timeoutMs: 100 },
    { model: "effects", state: "succeeded" },
  ] as const;
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `harness-relay-process-${scenario.model}-`));
    const broker = new Broker(paths(root));
    await broker.initialize();
    try {
      const started = await broker.start(
        request(root, scenario.model, {
          selector: {
            provider: "harness-relay",
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
        assert.equal(
          (terminal.outcome as { error?: { code?: string } }).error?.code,
          scenario.errorCode,
        );
      }
      if (scenario.model === "success") {
        assert.deepEqual((terminal.outcome as { content: unknown }).content, [
          { type: "text", text: "echo this" },
        ]);
      }
      if (scenario.model === "effects") {
        assert.ok(
          (terminal.outcome as { effects: ReadonlyArray<{ path: string }> }).effects.some(
            (effect) => effect.path.endsWith("fake-renamed.txt"),
          ),
        );
        const effectEvents = (
          await broker.events({ invocationId: started.invocationId })
        ).events.filter((event) => event.category === "effect");
        assert.ok(effectEvents.length > 0);
        assert.ok(effectEvents.every((event) => typeof event.data?.path === "string"));
      }
      if (scenario.model === "malformed-after-output") {
        const outcome = terminal.outcome as {
          content: ReadonlyArray<{ type: string; text?: string }>;
          observedIdentity: { model: { value?: string } };
        };
        assert.deepEqual(outcome.content, [{ type: "text", text: "echo this" }]);
        assert.equal(outcome.observedIdentity.model.value, "fake-echo");
      }
    } finally {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("broker turns an early harness exit while writing stdin into a failed invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-stdin-error-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "exit-before-read", {
        selector: { ...request(root, "exit-before-read").selector, via: "fake-process" },
        interactionStrategy: "deny",
        input: [{ type: "text", text: "x".repeat(300_000) }],
      }),
    );
    const terminal = await waitForTerminal(broker, started.invocationId);
    assert.equal(stateOf(terminal), "failed");
    const events = (await broker.events({ invocationId: started.invocationId })).events;
    assert.ok(
      events.some(
        (event) => event.category === "diagnostic" && event.data?.phase === "stream_error",
      ),
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker cancellation terminates a supervised fake harness process", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-process-cancel-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "cancel", {
        selector: {
          provider: "harness-relay",
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
  const root = await mkdtemp(join(tmpdir(), "harness-relay-input-"));
  const broker = new Broker(paths(root), {
    registry: new AdapterRegistry([new InteractiveAdapter()]),
  });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "interactive", {
        selector: {
          provider: "harness-relay",
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
    assert.deepEqual((terminal.outcome as { content: unknown }).content, [
      { type: "text", text: "allow" },
    ]);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function runNativePayload(
  root: string,
  diagnosticMode: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  const broker = new Broker(paths(root), {
    registry: new AdapterRegistry([new NativePayloadAdapter()]),
    diagnosticMode,
  });
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "native-payload", {
        selector: {
          provider: "harness-relay",
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
}

test("broker keeps native payloads bounded unless diagnostic mode is enabled", async () => {
  const regularRoot = await mkdtemp(join(tmpdir(), "harness-relay-native-regular-"));
  const diagnosticRoot = await mkdtemp(join(tmpdir(), "harness-relay-native-diagnostic-"));
  try {
    const regular = await runNativePayload(regularRoot, false);
    const diagnostic = await runNativePayload(diagnosticRoot, true);
    const regularEvent = (regular.outcome as { content: unknown }).content;
    assert.deepEqual(regularEvent, [{ type: "text", text: "done" }]);
    const regularEvents = await (async () => {
      const broker = new Broker(paths(regularRoot), { diagnosticMode: false });
      await broker.initialize();
      try {
        return await broker.events({
          invocationId: (regular as { invocationId: string }).invocationId,
        });
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
        return await broker.events({
          invocationId: (diagnostic as { invocationId: string }).invocationId,
        });
      } finally {
        await broker.close();
      }
    })();
    const diagnosticNative = diagnosticEvents.events.find(
      (event) => event.category === "output",
    )?.native;
    assert.equal(diagnosticNative?.secret, "do-not-persist");
  } finally {
    await rm(regularRoot, { recursive: true, force: true });
    await rm(diagnosticRoot, { recursive: true, force: true });
  }
});

test("broker distinguishes timeout from caller cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-timeout-"));
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
  const root = await mkdtemp(join(tmpdir(), "harness-relay-partial-result-"));
  const broker = new Broker(paths(root));
  await broker.initialize();
  try {
    const started = await broker.start(
      request(root, "slow", {
        selector: {
          provider: "harness-relay",
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
      content: ReadonlyArray<{ type: string; text?: string }>;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    assert.deepEqual(outcome.content, [{ type: "text", text: "echo this" }]);
    assert.deepEqual(
      outcome.usage && {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      },
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
  const root = await mkdtemp(join(tmpdir(), "harness-relay-policy-"));
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
  const root = await mkdtemp(join(tmpdir(), "harness-relay-concurrency-"));
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
  const liveRoot = await mkdtemp(join(tmpdir(), "harness-relay-live-"));
  const restartRoot = await mkdtemp(join(tmpdir(), "harness-relay-restart-"));
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
    await cp(paths(liveRoot).stateDirectory, paths(restartRoot).stateDirectory, {
      recursive: true,
    });
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

test("restart recovery clears an inherited child handle without changing its predecessor", async () => {
  const liveRoot = await mkdtemp(join(tmpdir(), "harness-relay-live-child-"));
  const restartRoot = await mkdtemp(join(tmpdir(), "harness-relay-restart-child-"));
  const adapter = new MutableContinuationAdapter();
  const liveBroker = new Broker(paths(liveRoot), { registry: new AdapterRegistry([adapter]) });
  await liveBroker.initialize();
  let originalId: string | undefined;
  let continuedId: string | undefined;
  let predecessorOutcome: unknown;
  try {
    const original = await liveBroker.start(
      request(liveRoot, "mutable-continuation", {
        selector: {
          provider: "harness-relay",
          model: "mutable-continuation",
          via: "mutable-continuation",
          effort: "high",
          requiredCapabilities: ["core.input.text"],
        },
      }),
    );
    originalId = original.invocationId;
    const predecessor = await waitForTerminal(liveBroker, originalId);
    predecessorOutcome = predecessor.outcome;
    adapter.pauseContinuation = true;
    const continued = (await liveBroker.execute("invocation.continue", {
      invocationId: originalId,
      input: [{ type: "text", text: "resume then restart" }],
      idempotencyKey: "restart-child-1",
    })) as { invocationId: string };
    continuedId = continued.invocationId;
    await waitForState(liveBroker, continued.invocationId, "running");
    await cp(paths(liveRoot).stateDirectory, paths(restartRoot).stateDirectory, {
      recursive: true,
    });
  } finally {
    await liveBroker.close();
  }

  assert.ok(originalId);
  assert.ok(continuedId);
  const restartedAdapter = new MutableContinuationAdapter();
  const restarted = new Broker(paths(restartRoot), {
    registry: new AdapterRegistry([restartedAdapter]),
  });
  await restarted.initialize();
  try {
    assert.equal(stateOf(await restarted.inspect(continuedId)), "interrupted");
    await assert.rejects(
      restarted.execute("invocation.continue", {
        invocationId: continuedId,
        input: [{ type: "text", text: "continue interrupted child" }],
        idempotencyKey: "restart-child-2",
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    assert.deepEqual((await restarted.result(originalId)).outcome, predecessorOutcome);
  } finally {
    await restarted.close();
    await rm(liveRoot, { recursive: true, force: true });
    await rm(restartRoot, { recursive: true, force: true });
  }
});

test("retention evicts completed records and persists tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-retention-"));
  const brokerOptions = { retention: { completedMs: 0, maxBytes: 1_073_741_824 } };
  const broker = new Broker(paths(root), brokerOptions);
  await broker.initialize();
  let invocationId: string;
  try {
    invocationId = (await broker.start(request(root, "fake-echo"))).invocationId;
    // Retention runs once the invocation completes; wait for the eviction
    // instead of assuming the fake harness finishes within a fixed delay.
    await waitForEviction(broker, invocationId);
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
