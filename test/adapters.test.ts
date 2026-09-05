import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ContentAccumulator, ProcessAdapter, type CommandSpec } from "../src/adapters/process.js";
import type { JsonValue, ObservedIdentity, ResolvedRoute, RouteDescriptor } from "../src/contract.js";
import type { AdapterEvent, AdapterRunContext } from "../src/adapters/types.js";

const route = (adapter: string, executable: string): ResolvedRoute => ({
  routeId: `${adapter}:test`,
  executable,
  adapter,
  harnessVersion: "1.0.0",
  authenticationMode: "test",
  provider: "test",
  model: "test-model",
  via: adapter,
  capabilities: ["core.input.text"],
  qualification: [],
});

const request = (workingDirectory: string): AdapterRunContext["request"] => ({
  selector: { provider: "test", model: "test-model", requiredCapabilities: [] },
  input: [{ type: "text", text: "hello" }],
  workingDirectory,
  interactionStrategy: "deny",
  requestedPolicy: { minimumAssurance: "none" },
});

class TestProcessAdapter extends ProcessAdapter {
  readonly id = "test-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(context: AdapterRunContext): CommandSpec {
    return {
      executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}}))"],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: { add(text: string): void } },
  ): AdapterEvent {
    const text = typeof value.message === "object" && value.message !== null
      && "content" in value.message && Array.isArray(value.message.content)
      && typeof value.message.content[0] === "object" && value.message.content[0] !== null
      && "text" in value.message.content[0] && typeof value.message.content[0].text === "string"
      ? value.message.content[0].text
      : "";
    state.content.add(text);
    return { category: "output", content: [{ type: "text", text }], native: value };
  }
}

class StdinProcessAdapter extends ProcessAdapter {
  readonly id = "stdin-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(): CommandSpec {
    return {
      executable: process.execPath,
      args: ["-e", "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:s}]},env:process.env.TEST_DENIED ?? null})))"],
      stdin: "prompt from stdin",
      env: { TEST_DENIED: "must-not-leak" },
      envDenyList: ["TEST_DENIED"],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: { add(text: string): void } },
  ): AdapterEvent {
    const message = value.message as { content?: readonly { text?: unknown }[] };
    const text = typeof message.content?.[0]?.text === "string" ? message.content[0].text : "";
    state.content.add(text);
    return { category: "output", content: [{ type: "text", text }], native: value };
  }
}

class InspectableClaudeAdapter extends ClaudeAdapter {
  normalize(value: Record<string, JsonValue>, state: { identity: ObservedIdentity; content: ContentAccumulator }): AdapterEvent | undefined {
    return this.normalizeNative(value, state);
  }
}

class InspectableCodexAdapter extends CodexAdapter {
  normalize(value: Record<string, JsonValue>, state: { identity: ObservedIdentity; content: ContentAccumulator }): AdapterEvent | undefined {
    return this.normalizeNative(value, state);
  }
}

function nativeState(): { identity: ObservedIdentity; content: ContentAccumulator } {
  return {
    identity: {
      provider: { evidence: "unverified" },
      model: { evidence: "unverified" },
      harnessVersion: { evidence: "unverified" },
      nativeSessionId: { evidence: "unverified" },
    },
    content: new ContentAccumulator(),
  };
}

test("route discovery reports qualified and authenticated command routes", async () => {
  const claude = new ClaudeAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "2.1.235 (Claude Code)",
      checkAuthentication: async () => true,
    },
  });
  const routes = await claude.discover();
  assert.equal(routes.length, 3);
  assert.ok(routes.every((candidate) => candidate.readiness === "ready"));
  assert.ok(routes.every((candidate) => candidate.executable === process.execPath));
  assert.ok(routes.every((candidate) => candidate.qualification.length === 1));
});

test("route discovery fails closed for an unqualified harness version", async () => {
  const codex = new CodexAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "1.0.0",
      checkAuthentication: async () => true,
    },
  });
  const routes = await codex.discover();
  assert.ok(routes.every((candidate) => candidate.readiness === "unqualified"));
});

test("process adapter normalizes JSONL output and preserves the absolute executable", async () => {
  const adapter = new TestProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_test",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.equal(events.at(-1)?.category, "output");
});

test("process adapter sends prompt on stdin and filters denied environment variables", async () => {
  const adapter = new StdinProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_stdin",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "prompt from stdin" }]);
  const started = events[0];
  assert.equal(started?.data?.phase, "process_started");
  assert.equal(JSON.stringify(started?.native).includes("prompt from stdin"), false);
  assert.equal(events.at(-1)?.native?.env, null);
});

test("Claude keeps the final result once and captures reported usage", () => {
  const adapter = new InspectableClaudeAdapter();
  const state = nativeState();
  const assistant = adapter.normalize({ type: "assistant", message: { content: [{ type: "text", text: "pong" }] } }, state);
  const result = adapter.normalize({ type: "result", result: "pong", usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.01 }, state);
  assert.equal(assistant?.category, "output");
  assert.equal(result?.category, "usage");
  assert.deepEqual(state.content.parts, [{ type: "text", text: "pong" }]);
  assert.equal(result?.usage?.inputTokens, 3);
});

test("Codex excludes reasoning from answer content and reports file effects", () => {
  const adapter = new InspectableCodexAdapter();
  const state = nativeState();
  const reasoning = adapter.normalize({ type: "item.completed", item: { type: "reasoning", text: "private thought" } }, state);
  const effect = adapter.normalize({ type: "item.completed", item: { type: "file_change", path: "src/app.ts", kind: "modify" } }, state);
  const answer = adapter.normalize({ type: "item.completed", item: { type: "agent_message", text: "answer" } }, state);
  assert.equal(reasoning?.category, "activity");
  assert.equal(reasoning?.data?.phase, "reasoning");
  assert.equal(effect?.effects?.[0]?.evidence, "harness-reported");
  assert.deepEqual(state.content.parts, [{ type: "text", text: "answer" }]);
  assert.equal(answer?.content?.[0]?.type, "text");
});
