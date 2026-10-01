import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandSpec } from "../src/adapters/process.js";
import type { AdapterRunContext } from "../src/adapters/types.js";
import type { ContentPart, StartInvocationRequest } from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import { BridgeError } from "../src/errors.js";

const ORIGINAL_SESSION = "0b6c2c1e-1d2a-4f3b-9c4d-000000000001";

class InspectableClaudeAdapter extends ClaudeAdapter {
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

/** A Claude Code stand-in that logs its argv and answers with the session it resumed. */
async function claudeFixture(prefix: string, version: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const executable = join(root, "claude-fixture");
  const script = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { randomUUID } = require('node:crypto');",
    "const args = process.argv.slice(2);",
    `if (args[0] === '--version') { console.log('${version} (Claude Code)'); process.exit(0); }`,
    "if (args[0] === 'auth') { process.exit(0); }",
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const resumeAt = args.indexOf('--resume');",
    "  const resumed = resumeAt === -1 ? undefined : args[resumeAt + 1];",
    "  const forked = args.includes('--fork-session');",
    `  const session = resumed === undefined ? '${ORIGINAL_SESSION}' : forked ? randomUUID() : resumed;`,
    "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'claude-haiku-4-5-20251001' }));",
    "  const text = (resumed === undefined ? 'new' : 'fork of ' + resumed) + ': ' + input;",
    "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session }));",
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

function claudeRequest(workspace: string): StartInvocationRequest {
  return {
    selector: {
      provider: "anthropic",
      model: "haiku",
      via: "claude-code",
      requiredCapabilities: [],
    },
    input: [{ type: "text", text: "first task" }],
    workingDirectory: workspace,
    interactionStrategy: "deny",
    requestedPolicy: { minimumAssurance: "none" },
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

function sessionOf(outcome: unknown): string | undefined {
  return (outcome as { observedIdentity: { nativeSessionId: { value?: string } } }).observedIdentity
    .nativeSessionId.value;
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

test("Claude advertises continuation only for versions with a qualified session fork", async () => {
  for (const [version, expected] of [
    ["2.1.282", true],
    ["2.2.0", true],
    ["2.1.281", false],
    ["2.1.235", false],
  ] as const) {
    const claude = new ClaudeAdapter({
      executable: process.execPath,
      probe: {
        readVersion: async () => `${version} (Claude Code)`,
        checkAuthentication: async () => true,
      },
    });
    const routes = await claude.discover();
    assert.ok(routes.length > 0);
    for (const route of routes) {
      assert.equal(route.capabilities.includes("continuation"), expected, version);
    }
  }
});

test("Claude continuation resumes a forked session as independent linked invocations", async () => {
  const fixture = await claudeFixture("harness-relay-claude-fork-", "2.1.282");
  const broker = new Broker(paths(fixture.root), {
    registry: new AdapterRegistry([new ClaudeAdapter({ executable: fixture.executable })]),
  });
  await broker.initialize();
  try {
    const original = await broker.start(claudeRequest(fixture.workspace));
    assert.equal((await terminal(broker, original.invocationId)).state, "succeeded");
    const predecessorOutcome = (await broker.result(original.invocationId)).outcome;

    const first = await continueWith(broker, original.invocationId, "branch one", "fork-1");
    const firstOutcome = (await terminal(broker, first)).outcome;
    const second = await continueWith(broker, original.invocationId, "branch two", "fork-2");
    const secondOutcome = (await terminal(broker, second)).outcome;
    const nested = await continueWith(broker, first, "nested", "fork-3");
    const nestedOutcome = (await terminal(broker, nested)).outcome;

    assert.equal(text(firstOutcome), `fork of ${ORIGINAL_SESSION}: branch one`);
    assert.equal(text(secondOutcome), `fork of ${ORIGINAL_SESSION}: branch two`);
    const firstSession = sessionOf(firstOutcome);
    assert.ok(firstSession !== undefined && firstSession !== ORIGINAL_SESSION);
    assert.notEqual(sessionOf(secondOutcome), firstSession);
    assert.equal(text(nestedOutcome), `fork of ${firstSession}: nested`);
    assert.equal((await broker.inspect(nested)).continuedFrom, first);
    assert.deepEqual((await broker.result(original.invocationId)).outcome, predecessorOutcome);

    const calls = await fixture.calls();
    assert.equal(calls.length, 4);
    const [start, ...continuations] = calls;
    assert.equal(start?.includes("--resume"), false);
    assert.equal(start?.includes("--no-session-persistence"), false);
    for (const call of continuations) {
      assert.deepEqual(call.slice(-1), ["--fork-session"]);
      assert.equal(call[call.indexOf("--permission-mode") + 1], "dontAsk");
    }
    assert.deepEqual(
      continuations.map((call) => call[call.indexOf("--resume") + 1]),
      [ORIGINAL_SESSION, ORIGINAL_SESSION, firstSession],
    );
  } finally {
    await broker.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude refuses continuation on versions without a qualified session fork", async () => {
  const fixture = await claudeFixture("harness-relay-claude-nofork-", "2.1.235");
  const broker = new Broker(paths(fixture.root), {
    registry: new AdapterRegistry([new ClaudeAdapter({ executable: fixture.executable })]),
  });
  await broker.initialize();
  try {
    const original = await broker.start(claudeRequest(fixture.workspace));
    await terminal(broker, original.invocationId);
    await assert.rejects(
      continueWith(broker, original.invocationId, "follow up", "nofork-1"),
      (error: unknown) => error instanceof BridgeError && error.code === "unsupported_capability",
    );
  } finally {
    await broker.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function referenceContext(reference: string): AdapterRunContext {
  return {
    invocationId: "inv_claude_reference",
    request: claudeRequest("/tmp"),
    route: {
      routeId: "claude:haiku",
      executable: process.execPath,
      adapter: "claude",
      harnessVersion: "2.1.282",
      authenticationMode: "claude-native",
      provider: "anthropic",
      model: "haiku",
      via: "claude-code",
      capabilities: ["core.input.text", "continuation"],
      qualification: [],
    },
    continuationHandle: { reference },
    signal: new AbortController().signal,
    async emit() {},
  };
}

test("Claude rejects a continuation reference that is not a native session ID", () => {
  const claude = new InspectableClaudeAdapter();
  for (const reference of ["--dangerously-skip-permissions", "latest", ""]) {
    assert.throws(
      () => claude.commandFor(referenceContext(reference)),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
  }
  const command = claude.commandFor(referenceContext(ORIGINAL_SESSION));
  assert.deepEqual(command.args.slice(-3), ["--resume", ORIGINAL_SESSION, "--fork-session"]);
});
