import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { McpServer } from "../src/mcp.js";

const execFile = promisify(execFileCallback);
const cliPath = join(process.cwd(), "dist", "src", "cli.js");

function decoded(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    assert.fail("Expected an MCP response.");
  }
  return JSON.parse(value) as Record<string, unknown>;
}

test("MCP initialize and tools/list expose the bridge contract", async () => {
  const server = new McpServer(async () => ({ ok: true }));
  const initialized = decoded(
    await server.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    ),
  );
  assert.equal((initialized.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  const fallback = decoded(
    await server.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "unsupported" },
      }),
    ),
  );
  assert.equal((fallback.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  const listed = decoded(
    await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
  );
  const tools = listed.result as {
    tools: ReadonlyArray<{
      name: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
  };
  assert.ok(tools.tools.some((tool) => tool.name === "agent_bridge_invocation_start"));
  assert.ok(tools.tools.some((tool) => tool.name === "agent_bridge_invocation_events"));
  assert.equal(
    tools.tools.some((tool) => tool.name === "agent_bridge_invocation_send"),
    false,
  );
  const startTool = tools.tools.find((tool) => tool.name === "agent_bridge_invocation_start");
  assert.ok(startTool?.inputSchema?.properties);
  assert.ok(startTool?.outputSchema);
});

test("MCP tools/call returns structured broker results and errors", async () => {
  const calls: Array<{ operation: string; params: unknown }> = [];
  const server = new McpServer(async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "invocation.start") {
      return { invocationId: "inv_test", state: "queued" };
    }
    throw new Error("expected failure");
  });
  const success = decoded(
    await server.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "ok",
        method: "tools/call",
        params: {
          name: "agent_bridge_invocation_start",
          arguments: { workingDirectory: "/tmp" },
        },
      }),
    ),
  );
  const successResult = success.result as { structuredContent: { invocationId: string } };
  assert.equal(successResult.structuredContent.invocationId, "inv_test");
  assert.deepEqual(calls[0], {
    operation: "invocation.start",
    params: { workingDirectory: "/tmp" },
  });

  const failure = decoded(
    await server.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "error",
        method: "tools/call",
        params: {
          name: "agent_bridge_invocation_events",
          arguments: {},
        },
      }),
    ),
  );
  assert.equal((failure.result as { isError: boolean }).isError, true);
});

test("MCP notifications do not produce stdout responses", async () => {
  const server = new McpServer(async () => ({}));
  assert.equal(
    await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
    undefined,
  );
});

test("MCP serves the broker contract to the official stdio client", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-mcp-integration-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  Object.assign(env, {
    AGENT_BRIDGE_RUNTIME_DIR: join(root, "run"),
    AGENT_BRIDGE_STATE_DIR: join(root, "state"),
    AGENT_BRIDGE_SOCKET_PATH: join(root, "run", "broker.sock"),
    AGENT_BRIDGE_FAKE_HARNESS_PATH: join(process.cwd(), "scripts", "fake-harness.mjs"),
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "serve"],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-bridge-integration-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const requiredTools = [
      "agent_bridge_system_describe",
      "agent_bridge_invocation_start",
      "agent_bridge_invocation_events",
      "agent_bridge_invocation_result",
    ];
    for (const name of requiredTools) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool?.outputSchema, `Expected ${name} to publish an output schema.`);
      assert.equal(tool.outputSchema.type, "object");
    }

    const described = await client.callTool({
      name: "agent_bridge_system_describe",
      arguments: {},
    });
    assert.ok(described.structuredContent);

    const started = await client.callTool({
      name: "agent_bridge_invocation_start",
      arguments: {
        selector: {
          provider: "agent-bridge",
          model: "fake-echo",
          via: "fake",
          requiredCapabilities: ["core.input.text"],
        },
        input: [{ type: "text", text: "MCP integration" }],
        workingDirectory: root,
        interactionStrategy: "orchestrator",
        requestedPolicy: { minimumAssurance: "none" },
      },
    });
    const startedContent = started.structuredContent as { invocationId?: unknown };
    assert.equal(typeof startedContent.invocationId, "string");
    const invocationId = startedContent.invocationId;

    const events = await client.callTool({
      name: "agent_bridge_invocation_events",
      arguments: { invocationId },
    });
    assert.ok(events.structuredContent);

    const waited = await client.callTool({
      name: "agent_bridge_invocation_wait",
      arguments: { invocationId, timeoutMs: 30_000 },
    });
    assert.ok(waited.structuredContent);

    const result = await client.callTool({
      name: "agent_bridge_invocation_result",
      arguments: { invocationId },
    });
    assert.ok(result.structuredContent);
  } finally {
    await client.close().catch(() => {});
    await execFile(process.execPath, [cliPath, "broker", "stop", "--force"], { env }).catch(
      () => {},
    );
    await rm(root, { recursive: true, force: true });
  }
});
