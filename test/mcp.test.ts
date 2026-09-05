import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "../src/mcp.js";

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
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    ),
  );
  assert.equal((initialized.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  const fallback = decoded(
    await server.handle(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "unsupported" } }),
    ),
  );
  assert.equal((fallback.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  const listed = decoded(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })));
  const tools = listed.result as {
    tools: readonly { name: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }[];
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
  assert.deepEqual(calls[0], { operation: "invocation.start", params: { workingDirectory: "/tmp" } });

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
  assert.equal(await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), undefined);
});
