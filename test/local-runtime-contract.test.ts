import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type InvocationRecord, parseStartInvocationRequest } from "../src/contract.js";
import { BridgeError } from "../src/errors.js";
import { McpServer } from "../src/mcp.js";
import { OPERATION_DEFINITIONS } from "../src/operations.js";
import { InvocationStore } from "../src/store.js";

type SelectorSchema = {
  readonly properties: {
    readonly selector: { readonly properties: Readonly<Record<string, unknown>> };
  };
};

function request(directory: string) {
  return parseStartInvocationRequest({
    selector: { provider: "unknown", model: "fixture:local", via: "pi", runtimeId: "ollama-mac" },
    workingDirectory: directory,
    input: [{ type: "text", text: "Inspect the project." }],
    interactionStrategy: "unattended",
  });
}

test("runtime selection survives public schema, parser, and MCP dispatch", async () => {
  const published = JSON.parse(
    await readFile(join(process.cwd(), "schemas/invocation-request.schema.json"), "utf8"),
  ) as SelectorSchema;
  const operation = OPERATION_DEFINITIONS.find((entry) => entry.name === "invocation.start");
  assert.ok(operation);
  const expected = { type: "string", minLength: 1 };
  assert.deepEqual(published.properties.selector.properties.runtimeId, expected);
  assert.deepEqual(
    (operation.input as SelectorSchema).properties.selector.properties.runtimeId,
    expected,
  );
  const parsed = request(tmpdir());
  assert.equal(parsed.selector.runtimeId, "ollama-mac");
  assert.throws(
    () =>
      parseStartInvocationRequest({ ...parsed, selector: { ...parsed.selector, runtimeId: "" } }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_request",
  );

  const received: unknown[] = [];
  const server = new McpServer(async (name, params) => {
    assert.equal(name, "invocation.start");
    received.push(parseStartInvocationRequest(params));
    return { invocationId: "inv_local", state: "queued" };
  });
  const listed = await server.handle(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  );
  assert.ok(listed);
  const tools = JSON.parse(listed) as {
    result: { tools: ReadonlyArray<{ name: string; inputSchema: SelectorSchema }> };
  };
  const tool = tools.result.tools.find((entry) => entry.name === "harness_relay_invocation_start");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.selector.properties.runtimeId, expected);
  const response = await server.handle(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "harness_relay_invocation_start", arguments: parsed },
    }),
  );
  assert.ok(response);
  const result = JSON.parse(response) as { result: { isError?: boolean } };
  assert.notEqual(result.result.isError, true);
  assert.deepEqual(received, [parsed]);
});

test("persisted invocation restores exact local runtime identity and legacy routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-contract-"));
  try {
    const stateFile = join(root, "state.json");
    const parsed = request(root);
    const record: InvocationRecord = {
      schemaVersion: "1.0",
      invocationId: "inv_local",
      requestDigest: "fixture-digest",
      request: parsed,
      resolvedRoute: {
        routeId: "pi:ollama:ollama-mac:revision:fixture-local:snapshot",
        adapter: "pi",
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        provider: "unknown",
        model: "fixture:local",
        nativeModel: "fixture:local",
        via: "pi",
        runtimeId: "ollama-mac",
        runtimeRevision: "revision",
        inferenceServer: "ollama",
        modelDigest: "a".repeat(64),
        runtimeInstanceId: "fixture-instance",
        modelVendorEvidence: "unverified",
        capabilities: ["core.tools"],
        qualification: [],
      },
      policy: {
        requestedPolicy: parsed.requestedPolicy,
        effectiveNativePolicy: {},
        assurance: "none",
      },
      state: "queued",
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      eventCount: 0,
      events: [],
    };
    const legacy = {
      ...record,
      invocationId: "inv_legacy",
      resolvedRoute: {
        routeId: "fake:echo",
        adapter: "fake",
        harnessVersion: "1",
        authenticationMode: "none",
        provider: "harness-relay",
        model: "fake-echo",
        via: "fake",
        capabilities: [],
        qualification: [],
      },
    };
    await new InvocationStore(stateFile).save([record, legacy]);
    const restored = await new InvocationStore(stateFile).load();
    assert.equal(restored.invocations.length, 2);
    assert.deepEqual(
      restored.invocations.find((entry) => entry.invocationId === "inv_local"),
      record,
    );
    assert.deepEqual(
      restored.invocations.find((entry) => entry.invocationId === "inv_legacy"),
      legacy,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
