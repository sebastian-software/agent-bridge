import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AdapterEvent, AdapterRunContext } from "../src/adapters/types.js";
import type { AdapterConnectionContext } from "../src/connections.js";

import { GrokAdapter } from "../src/adapters/grok.js";
import { BridgeError } from "../src/errors.js";

const fixtureProgram = String.raw`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const scenario = readFileSync(join(cwd, "scenario"), "utf8").trim();
const invocation = {
  args: process.argv.slice(2),
  grokHome: process.env.GROK_HOME ?? null,
  apiKeyPresent: process.env.XAI_API_KEY !== undefined,
  modelOverridePresent: process.env.GROK_DEFAULT_MODEL !== undefined,
};
writeFileSync(join(cwd, "invocation.json"), JSON.stringify(invocation));
const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { close: true } },
    }});
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fixture-session" } });
    if (scenario === "pause-input" || scenario === "close-input") {
      writeFileSync(join(cwd, "input-state"), scenario);
      if (scenario === "pause-input") {
        process.stdin.pause();
      } else {
        process.stdin.destroy();
        setTimeout(() => process.exit(0), 25);
      }
      if (scenario === "pause-input") {
        setInterval(() => {}, 1000);
      }
    }
  } else if (message.method === "session/prompt") {
    if (scenario === "hang-with-child") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(join(cwd, "descendant.pid"), String(child.pid));
      continue;
    }
    if (scenario === "unterminated-output") {
      process.stdout.write("x".repeat(1024 * 1024 + 1));
      setInterval(() => {}, 1000);
      continue;
    }
    if (scenario === "reverse-request") {
      send({ jsonrpc: "2.0", id: 99, method: "fs/read_text_file", params: { path: "/tmp/ignored" } });
      continue;
    }
    if (scenario === "native-auth-error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: 401, message: "sign in required" } });
      continue;
    }
    if (scenario === "text-limit") {
      for (let index = 0; index < 3; index += 1) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "fixture-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(700 * 1024) } },
        }});
        await pause(30);
      }
      continue;
    }
    if (scenario === "notification-flood") {
      for (let index = 0; index < 140; index += 1) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "fixture-session",
          update: { sessionUpdate: "agent_thought_chunk" },
        }});
      }
      continue;
    }
    const sessionId = scenario === "cross-session" ? "foreign-session" : "fixture-session";
    const text = scenario === "named-context" ? process.env.GROK_HOME : "fixture answer";
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    }});
    if (scenario !== "cross-session") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId,
        update: { sessionUpdate: "usage_update", cost: { currency: "USD", amount: 0.02 } },
      }});
      send({ jsonrpc: "2.0", id: message.id, result: {
        stopReason: scenario === "missing-terminal" ? undefined : "end_turn",
      }});
    }
  } else if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/cancel") {
    // The parent process-group supervisor owns termination.
  }
}
`;

type Fixture = { readonly root: string; readonly executable: string };

async function createFixture(scenario: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-grok-test-"));
  const executable = join(root, "grok-fixture");
  await writeFile(executable, fixtureProgram, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(join(root, "scenario"), scenario);
  return { root, executable };
}

async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function createContext(
  root: string,
  executable: string,
  options: {
    readonly signal?: AbortSignal;
    readonly terminationGraceMs?: number;
    readonly promptText?: string;
    readonly emitDelayMs?: number;
  } = {},
): {
  readonly context: AdapterRunContext;
  readonly events: AdapterEvent[];
  readonly partials: unknown[];
} {
  const events: AdapterEvent[] = [];
  const partials: unknown[] = [];
  const context: AdapterRunContext = {
    invocationId: "inv_grok_fixture",
    request: {
      selector: {
        provider: "xai",
        model: "grok-4.6",
        via: "grok-build",
        effort: "high",
        requiredCapabilities: ["core.input.text", "core.output.text"],
      },
      input: [{ type: "text", text: options.promptText ?? "Return a fixture answer." }],
      workingDirectory: root,
      interactionStrategy: "deny",
      requestedPolicy: {
        minimumAssurance: "none",
        filesystem: "inherit",
        commands: "inherit",
        network: "inherit",
      },
    },
    route: {
      routeId: "grok:grok-4.6",
      executable,
      nativeModel: "grok-4.6",
      adapter: "grok",
      harnessVersion: "1.0.44",
      authenticationMode: "grok-native-acp",
      provider: "xai",
      model: "grok-4.6",
      effort: "high",
      via: "grok-build",
      capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
      qualification: [],
    },
    signal: options.signal ?? new AbortController().signal,
    async emit(event) {
      if (options.emitDelayMs !== undefined) {
        await delay(options.emitDelayMs);
      }
      events.push(event);
    },
    reportPartial(result) {
      partials.push(result);
    },
    ...(options.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: options.terminationGraceMs }),
  };
  return { context, events, partials };
}

function adapterFor(fixture: Fixture): GrokAdapter {
  return new GrokAdapter({
    executable: fixture.executable,
    probe: {
      findExecutable: async () => fixture.executable,
      readVersion: async () => "Grok Build 1.0.44 (fixture)",
    },
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await delay(10);
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function assertPidExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await delay(20);
  }
  assert.fail(`Descendant process ${pid} survived Grok cancellation.`);
}

test("Grok discovery keeps unqualified authentication unavailable without model-list probes", async () => {
  const fixture = await createFixture("success");
  try {
    const adapter = adapterFor(fixture);
    const routes = await adapter.discover();
    assert.ok(routes.length > 0);
    assert.ok(routes.every((route) => route.readiness === "unavailable"));
    assert.ok(routes.every((route) => route.assurance === "none"));
    assert.ok(routes.every((route) => route.policySupport === undefined));
    assert.ok(routes.every((route) => route.qualification.length === 0));
    assert.ok(
      routes.every((route) => route.diagnostics.some((item) => /read-only probe/i.test(item))),
    );

    const policy = adapter.resolvePolicy(
      {
        ...createContext(fixture.root, fixture.executable).context.request,
        requestedPolicy: {
          minimumAssurance: "none",
          filesystem: "read-only",
          network: "inherit",
        },
      },
      routes[0]!,
    );
    assert.equal(policy.supported, false);
    assert.ok(policy.unsupported.includes("requestedPolicy.filesystem"));
  } finally {
    await removeFixture(fixture.root);
  }
});

test("Grok ACP normalizes text and usage with explicit model, effort, no-leader, and no filesystem tools", async () => {
  const fixture = await createFixture("success");
  try {
    const adapter = adapterFor(fixture);
    const { context, events, partials } = createContext(fixture.root, fixture.executable);
    const result = await adapter.run(context);

    assert.deepEqual(result.content, [{ type: "text", text: "fixture answer" }]);
    assert.equal(result.usage?.costUsd, 0.02);
    assert.equal(result.observedIdentity.model.evidence, "unverified");
    assert.equal(result.observedIdentity.nativeSessionId.value, "fixture-session");
    assert.ok(events.some((event) => event.category === "output"));
    assert.ok(events.some((event) => event.category === "usage"));
    assert.ok(partials.length > 0);

    const invocation = JSON.parse(
      await readFile(join(fixture.root, "invocation.json"), "utf8"),
    ) as {
      readonly args: readonly string[];
    };
    assert.deepEqual(invocation.args, [
      "--no-auto-update",
      "--model",
      "grok-4.6",
      "--effort",
      "high",
      "--permission-mode",
      "dontAsk",
      "--no-subagents",
      "agent",
      "--no-leader",
      "stdio",
    ]);
    const started = events.find((event) => event.data?.phase === "process_started");
    assert.deepEqual(started?.data?.clientCapabilities, {
      filesystemRead: false,
      filesystemWrite: false,
      terminal: false,
    });
  } finally {
    await removeFixture(fixture.root);
  }
});

test("Grok named context removes inherited auth overrides and redacts events, partials, final results, and errors", async () => {
  const fixture = await createFixture("named-context");
  const nativeHome = join(fixture.root, "account-context");
  await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  const originalApiKey = process.env.XAI_API_KEY;
  const originalModel = process.env.GROK_DEFAULT_MODEL;
  process.env.XAI_API_KEY = "fixture-inherited-api-key";
  process.env.GROK_DEFAULT_MODEL = "fixture-inherited-model";
  try {
    const adapter = adapterFor(fixture);
    const connection: AdapterConnectionContext = {
      id: "analysis",
      harness: "grok",
      nativeContextRef: nativeHome,
      revision: "revision-1",
    };
    const { context, events, partials } = createContext(fixture.root, fixture.executable);
    const result = await adapter.runConnection({ ...context, connection });

    assert.equal(result.content[0]?.type, "text");
    assert.match(JSON.stringify(result), /\[redacted native context\]/);
    assert.equal(JSON.stringify(result).includes(nativeHome), false);
    assert.equal(JSON.stringify(events).includes(nativeHome), false);
    assert.equal(JSON.stringify(partials).includes(nativeHome), false);
    assert.ok(events.some((event) => JSON.stringify(event).includes("XAI_API_KEY")));

    const failingContext = createContext(fixture.root, fixture.executable).context;
    const failingAdapterContext = {
      ...failingContext,
      connection,
      async emit() {
        throw new Error(`fixture error mentions ${nativeHome}`);
      },
    };
    await assert.rejects(adapter.runConnection(failingAdapterContext), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[redacted native context\]/);
      assert.equal(error.message.includes(nativeHome), false);
      return true;
    });

    const invocation = JSON.parse(
      await readFile(join(fixture.root, "invocation.json"), "utf8"),
    ) as {
      readonly grokHome: null | string;
      readonly apiKeyPresent: boolean;
      readonly modelOverridePresent: boolean;
    };
    assert.equal(invocation.grokHome, nativeHome);
    assert.equal(invocation.apiKeyPresent, false);
    assert.equal(invocation.modelOverridePresent, false);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = originalApiKey;
    }
    if (originalModel === undefined) {
      delete process.env.GROK_DEFAULT_MODEL;
    } else {
      process.env.GROK_DEFAULT_MODEL = originalModel;
    }
    await removeFixture(fixture.root);
  }
});

test("Grok rejects cross-session notifications, native reverse requests, and auth failures", async (t) => {
  for (const scenario of ["cross-session", "reverse-request", "native-auth-error"]) {
    await t.test(scenario, async () => {
      const fixture = await createFixture(scenario);
      try {
        const adapter = adapterFor(fixture);
        const { context } = createContext(fixture.root, fixture.executable);
        await assert.rejects(adapter.run(context), (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(
            error.code,
            scenario === "reverse-request"
              ? "unsupported_capability"
              : scenario === "native-auth-error"
                ? "route_unavailable"
                : "output_unparseable",
          );
          return true;
        });
      } finally {
        await removeFixture(fixture.root);
      }
    });
  }
});

test("Grok fails incomplete turns and bounds lines, cumulative text, and queued notifications", async (t) => {
  for (const scenario of [
    "missing-terminal",
    "unterminated-output",
    "text-limit",
    "notification-flood",
  ]) {
    await t.test(scenario, async () => {
      const fixture = await createFixture(scenario);
      try {
        const adapter = adapterFor(fixture);
        const options: { readonly emitDelayMs?: number } =
          scenario === "notification-flood" ? { emitDelayMs: 20 } : {};
        const { context, partials } = createContext(fixture.root, fixture.executable, options);
        await assert.rejects(adapter.run(context));
        if (scenario === "missing-terminal") {
          assert.ok(
            partials.some((partial) => JSON.stringify(partial).includes("fixture answer")),
            "incomplete completion should retain observed partial output",
          );
        }
      } finally {
        await removeFixture(fixture.root);
      }
    });
  }
});

test("Grok cancellation reaps descendants that ignore SIGINT", async () => {
  const fixture = await createFixture("hang-with-child");
  const controller = new AbortController();
  try {
    const adapter = adapterFor(fixture);
    const { context } = createContext(fixture.root, fixture.executable, {
      signal: controller.signal,
      terminationGraceMs: 100,
    });
    const invocation = adapter.run(context);
    await waitForFile(join(fixture.root, "descendant.pid"));
    const descendantPid = Number(await readFile(join(fixture.root, "descendant.pid"), "utf8"));
    controller.abort();
    await assert.rejects(
      invocation,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await assertPidExited(descendantPid);
  } finally {
    await removeFixture(fixture.root);
  }
});

test("Grok settles a backpressured prompt when stdin is cancelled or closed", async (t) => {
  for (const scenario of ["pause-input", "close-input"]) {
    await t.test(scenario, async () => {
      const fixture = await createFixture(scenario);
      const controller = new AbortController();
      try {
        const adapter = adapterFor(fixture);
        const { context } = createContext(fixture.root, fixture.executable, {
          signal: controller.signal,
          terminationGraceMs: 100,
          promptText: "x".repeat(8 * 1024 * 1024),
        });
        const startedAt = Date.now();
        const invocation = adapter.run(context);
        const rejected =
          scenario === "pause-input"
            ? assert.rejects(
                invocation,
                (error: unknown) => error instanceof Error && error.name === "AbortError",
              )
            : assert.rejects(invocation);
        await waitForFile(join(fixture.root, "input-state"));
        if (scenario === "pause-input") {
          controller.abort();
        }
        await rejected;
        assert.ok(Date.now() - startedAt < 3000, "backpressured write should settle promptly");
      } finally {
        controller.abort();
        await removeFixture(fixture.root);
      }
    });
  }
});
