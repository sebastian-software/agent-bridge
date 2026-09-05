import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { parseVersion, satisfiesVersionRange } from "../src/adapters/discovery.js";
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

class InteractiveProcessAdapter extends ProcessAdapter {
  readonly id = "interactive-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(): CommandSpec {
    const script = [
      "process.stdin.setEncoding('utf8');",
      "let input = '';",
      "process.stdin.on('data', chunk => { input += chunk; if (input.includes('control_response')) {",
      "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'approved'}]}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'result',result:'approved'})+'\\n');",
      "process.exit(0); } });",
      "process.stdout.write(JSON.stringify({type:'control_request',request_id:'perm_1',request:{subtype:'can_use_tool',tool_name:'Write',message:'Allow Write?'}})+'\\n');",
    ].join(" ");
    return {
      executable: process.execPath,
      args: ["-e", script],
      stdin: "initial input\\n",
      keepStdinOpen: true,
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined {
    if (value.type === "control_request") {
      return {
        category: "input_required",
        inputRequest: {
          requestId: "perm_1",
          kind: "permission",
          prompt: "Allow Write?",
          toolName: "Write",
        },
        native: value,
      };
    }
    if (value.type === "assistant") {
      state.content.add("approved");
      return { category: "output", content: [{ type: "text", text: "approved" }], native: value };
    }
    if (value.type === "result") {
      state.content.setFinal("approved");
      return { category: "lifecycle", native: value };
    }
    return undefined;
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

  commandFor(context: AdapterRunContext): CommandSpec {
    return this.command(context);
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

test("process adapter completes a bidirectional permission exchange", async () => {
  const adapter = new InteractiveProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_interactive",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    awaitInput: async (requestId) => {
      assert.equal(requestId, "perm_1");
      return { decision: "allow" };
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "approved" }]);
  assert.equal(events.some((event) => event.category === "input_required"), true);
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

test("Claude maps native permission requests to an input request", () => {
  const adapter = new InspectableClaudeAdapter();
  const event = adapter.normalize({
    type: "control_request",
    request_id: "req_123",
    request: { subtype: "can_use_tool", tool_name: "Bash", message: "Run the command?" },
  }, nativeState());
  assert.equal(event?.category, "input_required");
  assert.deepEqual(event?.inputRequest, {
    requestId: "req_123",
    kind: "permission",
    prompt: "Run the command?",
    toolName: "Bash",
  });
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

test("version qualification accepts ranges instead of only a major number", () => {
  const qualified = parseVersion("codex-cli 0.149.1");
  const old = parseVersion("codex-cli 0.148.9");
  assert.ok(qualified !== undefined && satisfiesVersionRange(qualified, ">=0.149.0 <1.0.0"));
  assert.ok(old !== undefined && !satisfiesVersionRange(old, ">=0.149.0 <1.0.0"));
});

test("policy resolution rejects unsupported fields and records exact controls", () => {
  const claude = new ClaudeAdapter({ executable: process.execPath });
  const claudeRoute: RouteDescriptor = {
    routeId: "claude:test",
    provider: "anthropic",
    model: "haiku",
    efforts: ["low", "medium", "high", "max"],
    via: "claude-code",
    adapter: "claude",
    harnessVersion: "2.1.235",
    authenticationMode: "test",
    capabilities: [],
    interactionStrategies: ["deny"],
    assurance: "native",
    runtimeIdentityEvidence: "unverified",
    readiness: "ready",
    qualification: [],
    diagnostics: [],
  };
  const unsupported = claude.resolvePolicy({ ...request(process.cwd()), requestedPolicy: { minimumAssurance: "none", network: "deny" } }, claudeRoute);
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.unsupported.includes("requestedPolicy.network"));

  const codex = new InspectableCodexAdapter();
  const codexRequest = { ...request(process.cwd()), selector: { ...request(process.cwd()).selector, effort: "max" } };
  const command = codex.commandFor({
    invocationId: "inv_policy",
    request: codexRequest,
    route: { ...route("codex", process.execPath), effort: "max" },
    signal: new AbortController().signal,
    emit: async () => {},
  });
  assert.ok(command.args.includes("model_reasoning_effort=xhigh"));
  assert.equal(command.stdin, "hello");
});
