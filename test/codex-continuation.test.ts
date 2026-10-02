import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandSpec } from "../src/adapters/process.js";
import type { AdapterRunContext } from "../src/adapters/types.js";
import type { ContentPart, StartInvocationRequest } from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { CodexAdapter } from "../src/adapters/codex.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import { BridgeError } from "../src/errors.js";

const ORIGINAL_THREAD = "0190a000-0000-7000-8000-000000000001";

class InspectableCodexAdapter extends CodexAdapter {
  commandFor(context: AdapterRunContext): CommandSpec {
    return this.command(context);
  }
}

type Fixture = {
  readonly root: string;
  readonly workspace: string;
  readonly executable: string;
  readonly calls: () => Promise<ReadonlyArray<readonly string[]>>;
};

/** A Codex stand-in that logs its argv and answers with the session it ran in. */
async function codexFixture(prefix: string, version: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const executable = join(root, "codex-fixture");
  const script = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { randomUUID } = require('node:crypto');",
    "const args = process.argv.slice(2);",
    `if (args[0] === '--version') { console.log('codex-cli ${version}'); process.exit(0); }`,
    "if (args[0] === 'login') { process.exit(0); }",
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const forked = args[1] === 'fork' ? args[args.length - 2] : undefined;",
    `  const thread = forked === undefined ? '${ORIGINAL_THREAD}' : randomUUID();`,
    "  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));",
    "  const text = (forked === undefined ? 'new' : 'fork of ' + forked) + ': ' + input;",
    "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));",
    "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
    "});",
  ].join("\n");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o700);
  return {
    root,
    workspace,
    executable,
    async calls() {
      let log: string;
      try {
        log = await readFile(join(root, "calls.jsonl"), "utf8");
      } catch {
        return [];
      }
      return log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

function paths(root: string): BrokerPaths {
  return {
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    socketPath: join(root, "run", "broker.sock"),
    stateFile: join(root, "state", "state.json"),
  };
}

function codexRequest(
  workspace: string,
  overrides?: Partial<StartInvocationRequest>,
): StartInvocationRequest {
  return {
    selector: { provider: "openai", model: "gpt-6.1-sol", via: "codex", requiredCapabilities: [] },
    input: [{ type: "text", text: "first task" }],
    workingDirectory: workspace,
    interactionStrategy: "deny",
    requestedPolicy: { minimumAssurance: "none", filesystem: "read-only" },
    ...overrides,
  };
}

async function terminal(broker: Broker, invocationId: string): Promise<Record<string, unknown>> {
  const inspected = await broker.wait(invocationId, 15_000);
  if (inspected.waited !== true) {
    assert.fail(`Invocation ${invocationId} did not become terminal.`);
  }
  return inspected;
}

function text(outcome: unknown): string {
  const content = (outcome as { content: readonly ContentPart[] }).content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function continueWith(
  broker: Broker,
  invocationId: string,
  prompt: string,
  idempotencyKey: string,
): Promise<string> {
  const started = (await broker.execute("invocation.continue", {
    invocationId,
    input: [{ type: "text", text: prompt }],
    idempotencyKey,
  })) as { invocationId: string };
  return started.invocationId;
}

test("Codex advertises continuation only for versions with a qualified exec fork", async () => {
  for (const [version, expected] of [
    ["0.159.2", true],
    ["0.160.0", true],
    ["0.159.1", false],
    ["0.149.0", false],
  ] as const) {
    const codex = new CodexAdapter({
      executable: process.execPath,
      probe: {
        readVersion: async () => `codex-cli ${version}`,
        checkAuthentication: async () => true,
      },
    });
    const routes = await codex.discover();
    assert.ok(routes.length > 0);
    for (const route of routes) {
      assert.equal(route.capabilities.includes("continuation"), expected, version);
    }
  }
});

test("Codex continuation forks the retained session into independent linked invocations", async () => {
  const fixture = await codexFixture("harness-relay-codex-fork-", "0.159.2");
  const broker = new Broker(paths(fixture.root), {
    registry: new AdapterRegistry([new CodexAdapter({ executable: fixture.executable })]),
  });
  await broker.initialize();
  try {
    const original = await broker.start(codexRequest(fixture.workspace));
    const predecessor = await terminal(broker, original.invocationId);
    assert.equal(predecessor.state, "succeeded");
    const predecessorOutcome = (await broker.result(original.invocationId)).outcome;

    const first = await continueWith(broker, original.invocationId, "branch one", "fork-1");
    const firstOutcome = (await terminal(broker, first)).outcome;
    const second = await continueWith(broker, original.invocationId, "branch two", "fork-2");
    const secondOutcome = (await terminal(broker, second)).outcome;
    const nested = await continueWith(broker, first, "nested", "fork-3");
    const nestedOutcome = (await terminal(broker, nested)).outcome;

    assert.equal(text(firstOutcome), `fork of ${ORIGINAL_THREAD}: branch one`);
    assert.equal(text(secondOutcome), `fork of ${ORIGINAL_THREAD}: branch two`);
    const firstThread = (
      firstOutcome as { observedIdentity: { nativeSessionId: { value: string } } }
    ).observedIdentity.nativeSessionId.value;
    assert.notEqual(firstThread, ORIGINAL_THREAD);
    assert.equal(text(nestedOutcome), `fork of ${firstThread}: nested`);
    assert.equal((await broker.inspect(first)).continuedFrom, original.invocationId);
    assert.deepEqual((await broker.result(original.invocationId)).outcome, predecessorOutcome);

    const calls = await fixture.calls();
    assert.equal(calls.length, 4);
    const [start, ...forks] = calls;
    assert.ok(start !== undefined);
    assert.equal(start.includes("--ephemeral"), false, "a continuable run keeps its session");
    assert.deepEqual(start.slice(0, 2), ["exec", "--json"]);
    assert.equal(start[start.indexOf("--sandbox") + 1], "read-only");
    for (const call of forks) {
      assert.deepEqual(call.slice(0, 3), ["exec", "fork", "--json"]);
      assert.equal(call.at(-1), "-");
      assert.ok(call.includes('sandbox_mode="read-only"'));
      assert.ok(call.includes('approval_policy="never"'));
      for (const unsupported of ["--sandbox", "--cd", "--add-dir", "--ephemeral"]) {
        assert.equal(call.includes(unsupported), false, unsupported);
      }
    }
    assert.deepEqual(
      forks.map((call) => call.at(-2)),
      [ORIGINAL_THREAD, ORIGINAL_THREAD, firstThread],
    );
  } finally {
    await broker.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex runs stay ephemeral and refuse continuation without a qualified fork", async () => {
  const fixture = await codexFixture("harness-relay-codex-nofork-", "0.158.0");
  const broker = new Broker(paths(fixture.root), {
    registry: new AdapterRegistry([new CodexAdapter({ executable: fixture.executable })]),
  });
  await broker.initialize();
  try {
    const original = await broker.start(codexRequest(fixture.workspace));
    await terminal(broker, original.invocationId);
    await assert.rejects(
      continueWith(broker, original.invocationId, "follow up", "nofork-1"),
      (error: unknown) => error instanceof BridgeError && error.code === "unsupported_capability",
    );
    const [start] = await fixture.calls();
    assert.ok(start?.includes("--ephemeral"));
  } finally {
    await broker.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex runs with additional directories keep no continuation handle", async () => {
  const fixture = await codexFixture("harness-relay-codex-adddir-", "0.159.2");
  const extra = join(fixture.root, "extra");
  await mkdir(extra);
  const broker = new Broker(paths(fixture.root), {
    registry: new AdapterRegistry([new CodexAdapter({ executable: fixture.executable })]),
  });
  await broker.initialize();
  try {
    const original = await broker.start(
      codexRequest(fixture.workspace, {
        requestedPolicy: {
          minimumAssurance: "none",
          filesystem: "workspace-write",
          additionalDirectories: [extra],
        },
      }),
    );
    assert.equal((await terminal(broker, original.invocationId)).state, "succeeded");
    await assert.rejects(
      continueWith(broker, original.invocationId, "follow up", "adddir-1"),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    const [start] = await fixture.calls();
    assert.ok(start?.includes("--ephemeral"));
    assert.equal(start?.[start.indexOf("--add-dir") + 1], extra);
  } finally {
    await broker.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function referenceContext(reference: string): AdapterRunContext {
  return {
    invocationId: "inv_codex_reference",
    request: codexRequest("/tmp"),
    route: {
      routeId: "codex:gpt-6.1-sol",
      executable: process.execPath,
      adapter: "codex",
      harnessVersion: "0.159.2",
      authenticationMode: "codex-native",
      provider: "openai",
      model: "gpt-6.1-sol",
      via: "codex",
      capabilities: ["core.input.text", "continuation"],
      qualification: [],
    },
    continuationHandle: { reference },
    signal: new AbortController().signal,
    async emit() {},
  };
}

test("Codex rejects a continuation reference that is not a native thread ID", () => {
  const codex = new InspectableCodexAdapter();
  for (const reference of ["--dangerously-bypass-approvals-and-sandbox", "last", ""]) {
    assert.throws(
      () => codex.commandFor(referenceContext(reference)),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
  }
  const command = codex.commandFor(referenceContext(ORIGINAL_THREAD));
  assert.deepEqual(command.args.slice(-2), [ORIGINAL_THREAD, "-"]);
});
