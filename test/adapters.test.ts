import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ProcessAdapter, type CommandSpec } from "../src/adapters/process.js";
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
  assert.equal(events[0]?.category, "output");
});
