import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  Adapter,
  AdapterConnectionRunContext,
  AdapterRunContext,
  AdapterRunResult,
} from "../src/adapters/types.js";
import type { AdapterConnectionContext, HarnessConnection } from "../src/connections.js";
import type {
  ConnectionDiscoverResult,
  ConnectionInspection,
  ConnectionPrepareResult,
  ObservedIdentity,
  RouteDescriptor,
  StartInvocationRequest,
} from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import { createClient } from "../src/client.js";
import {
  createHarnessConnection,
  loadUserConnections,
  loadUserConnectionsSnapshot,
  mutateUserConnections,
  summarizeConnection,
  updateHarnessConnection,
  writeUserConnections,
} from "../src/connections.js";
import { BridgeError } from "../src/errors.js";
import { BrokerServer } from "../src/ipc.js";
import { McpServer } from "../src/mcp.js";

// The legacy-record test below starts a fake route through the default
// registry, which registers the fixtures only when this switch is set.
process.env.HARNESS_RELAY_FAKE_ROUTES = "1";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

type McpToolCallResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly text?: string }>;
};

async function callMcpTool(
  server: McpServer,
  requestId: number,
  name: string,
  args: unknown = {},
): Promise<McpToolCallResult> {
  const response = await server.handle(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  assert.ok(response);
  const envelope = JSON.parse(response) as { readonly result?: McpToolCallResult };
  assert.ok(envelope.result);
  return envelope.result;
}

function mcpErrorCode(result: McpToolCallResult): string | undefined {
  const message = result.content?.find((entry) => entry.text !== undefined)?.text;
  if (message === undefined) {
    return undefined;
  }
  const payload = JSON.parse(message) as { readonly error?: { readonly code?: unknown } };
  return typeof payload.error?.code === "string" ? payload.error.code : undefined;
}

function brokerPaths(root: string): BrokerPaths {
  return {
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    socketPath: join(root, "run", "broker.sock"),
    stateFile: join(root, "state", "state.json"),
  };
}

function request(root: string, connectionId?: string): StartInvocationRequest {
  return {
    selector: {
      provider: "connection-fixture",
      model: "fixture-model",
      via: "connection-fixture",
      ...(connectionId === undefined ? {} : { connectionId }),
      requiredCapabilities: ["core.input.text"],
    },
    input: [{ type: "text", text: "use the selected context" }],
    workingDirectory: root,
    interactionStrategy: "deny",
    requestedPolicy: { minimumAssurance: "none" },
  };
}

function descriptor(adapter: string, continuation = false): RouteDescriptor {
  return {
    routeId: `${adapter}:fixture-model`,
    provider: "connection-fixture",
    model: "fixture-model",
    efforts: ["low", "high"],
    via: "connection-fixture",
    adapter,
    harnessVersion: "1.0.0",
    authenticationMode: "fixture",
    capabilities: [
      "core.input.text",
      "core.output.text",
      ...(continuation ? ["continuation"] : []),
    ],
    interactionStrategies: ["deny"],
    assurance: "native",
    runtimeIdentityEvidence: "unverified",
    readiness: "ready",
    qualification: [
      {
        qualificationId: "connection-fixture-v1",
        testedAt: "2026-09-28T00:00:00.000Z",
        claim: "Deterministic native-context routing fixture.",
      },
    ],
    diagnostics: [],
  };
}

const fixtureIdentity: ObservedIdentity = {
  provider: { value: "connection-fixture", evidence: "reported" },
  model: { value: "fixture-model", evidence: "reported" },
  harnessVersion: { value: "1.0.0", evidence: "reported" },
  nativeSessionId: { evidence: "unverified" },
};

function fixtureResult(): AdapterRunResult {
  return {
    content: [{ type: "text", text: "done" }],
    artifacts: [],
    effects: [],
    observedIdentity: fixtureIdentity,
  };
}

class ConnectionFixtureAdapter implements Adapter {
  readonly id = "connection-fixture";
  readonly discoveredReferences: string[] = [];
  readonly seenConnections: AdapterConnectionContext[] = [];
  readonly seenContinuationHandles: Array<string | undefined> = [];
  seenConnection: AdapterConnectionContext | undefined;
  readonly discoveryStarted = deferred();
  readonly discoveryGate = deferred();
  readonly runStarted = deferred();
  readonly runGate = deferred();
  readonly #waitForDiscovery: boolean;
  readonly #continuationCapable: boolean;

  constructor(waitForDiscovery = false, continuationCapable = false) {
    this.#waitForDiscovery = waitForDiscovery;
    this.#continuationCapable = continuationCapable;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [descriptor(this.id)];
  }

  async discoverConnection(
    connection: AdapterConnectionContext,
  ): Promise<readonly RouteDescriptor[]> {
    this.discoveredReferences.push(connection.nativeContextRef);
    this.discoveryStarted.resolve();
    if (this.#waitForDiscovery) {
      await this.discoveryGate.promise;
    }
    return [
      {
        ...descriptor(this.id, this.#continuationCapable),
        diagnostics: [connection.nativeContextRef],
      },
    ];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    return fixtureResult();
  }

  async runConnection(context: AdapterConnectionRunContext): Promise<AdapterRunResult> {
    this.seenConnection = context.connection;
    this.seenConnections.push(context.connection);
    this.seenContinuationHandles.push(context.continuationHandle?.reference);
    this.runStarted.resolve();
    await this.runGate.promise;
    return {
      ...fixtureResult(),
      ...(this.#continuationCapable
        ? { continuationHandle: { reference: "fixture-native-session" } }
        : {}),
    };
  }

  releaseDiscovery(): void {
    this.discoveryGate.resolve();
  }

  releaseRun(): void {
    this.runGate.resolve();
  }
}

class AmbiguousRouteFixtureAdapter implements Adapter {
  readonly id: string;
  runCalls = 0;

  constructor(id: string) {
    this.id = id;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [{ ...descriptor(this.id), routeId: `${this.id}:fixture-model` }];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    this.runCalls += 1;
    return fixtureResult();
  }
}

class DiscoveryOnlyAdapter implements Adapter {
  readonly id = "connection-fixture";
  discoveryCalls = 0;

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [descriptor(this.id)];
  }

  async discoverConnection(): Promise<readonly RouteDescriptor[]> {
    this.discoveryCalls += 1;
    return [descriptor(this.id)];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    return fixtureResult();
  }
}

class NativeContextFixtureAdapter implements Adapter {
  readonly id = "codex";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [descriptor(this.id)];
  }

  async discoverConnection(
    connection: AdapterConnectionContext,
  ): Promise<readonly RouteDescriptor[]> {
    return [{ ...descriptor(this.id), diagnostics: [connection.nativeContextRef] }];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    return fixtureResult();
  }

  async runConnection(_context: AdapterConnectionRunContext): Promise<AdapterRunResult> {
    return fixtureResult();
  }
}

async function waitForTerminal(
  broker: Broker,
  invocationId: string,
): Promise<Readonly<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const inspected = await broker.inspect(invocationId);
    if (
      ["cancelled", "failed", "interrupted", "succeeded", "timed_out"].includes(
        String(inspected.state),
      )
    ) {
      return inspected;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Invocation did not become terminal.");
}

async function makeConnection(
  path: string,
  nativeContextRef = "/private/native/context",
): Promise<HarnessConnection> {
  const connection = createHarnessConnection({
    id: "analysis",
    harness: "connection-fixture",
    nativeContextRef,
    purpose: "analysis",
  });
  await replaceConnections([connection], path);
  return connection;
}

async function replaceConnections(
  connections: readonly HarnessConnection[],
  path: string,
): Promise<void> {
  const snapshot = await loadUserConnectionsSnapshot(path);
  await writeUserConnections(connections, { path, expectedRevision: snapshot.revision });
}

async function spawnConnectionWriter(path: string, id: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist/src/connections.js")).href;
  const source = [
    `const { createHarnessConnection, mutateUserConnections } = await import(${JSON.stringify(moduleUrl)});`,
    "const [path, id] = process.argv.slice(1);",
    'const connection = createHarnessConnection({ id, harness: "connection-fixture", nativeContextRef: "/private/" + id });',
    "await mutateUserConnections(async (current) => {",
    "  await new Promise((resolve) => setTimeout(resolve, 200));",
    "  return { connections: [...current, connection], result: id };",
    "}, path);",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, path, id], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Connection writer exited with ${String(code)}: ${stderr}`));
      }
    });
  });
}

async function spawnAbandonedConnectionLock(path: string): Promise<number> {
  const source = [
    'const fs = require("node:fs");',
    "const lock = process.argv[1];",
    'fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "abandoned" }), { flag: "wx", mode: 0o600 });',
    "process.stdout.write(String(process.pid));",
  ].join("\n");
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const pid = Number(stdout);
      if (code === 0 && Number.isSafeInteger(pid)) {
        resolve(pid);
      } else {
        reject(new Error(`Abandoned lock writer exited with ${String(code)}: ${stderr}`));
      }
    });
  });
}

test("connection storage validates before atomically replacing the user file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-store-"));
  const path = join(root, "connections.json");
  try {
    const connection = await makeConnection(path);
    assert.deepEqual(await loadUserConnections(path), [connection]);
    const snapshot = await loadUserConnectionsSnapshot(path);
    const before = await readFile(path, "utf8");

    await assert.rejects(
      writeUserConnections([connection, connection], {
        path,
        expectedRevision: snapshot.revision,
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_request",
    );
    assert.equal(await readFile(path, "utf8"), before);

    const updated = updateHarnessConnection(connection, {
      id: connection.id,
      harness: connection.harness,
      nativeContextRef: "/private/native/context-updated",
      purpose: "implementation",
    });
    assert.notEqual(updated.revision, connection.revision);
    await writeUserConnections([updated], { path, expectedRevision: snapshot.revision });
    assert.deepEqual(await loadUserConnections(path), [updated]);
    assert.deepEqual(summarizeConnection(updated), {
      id: updated.id,
      harness: updated.harness,
      revision: updated.revision,
      purpose: updated.purpose,
    });
    assert.ok(!JSON.stringify(summarizeConnection(updated)).includes(updated.nativeContextRef));
    assert.ok(
      !JSON.stringify(
        summarizeConnection({ ...updated, purpose: updated.nativeContextRef }),
      ).includes(updated.nativeContextRef),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct connection writes reject stale snapshots instead of replacing newer registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-cas-"));
  const path = join(root, "connections.json");
  try {
    const stale = await loadUserConnectionsSnapshot(path);
    const first = createHarnessConnection({
      id: "first",
      harness: "connection-fixture",
      nativeContextRef: "/private/first",
    });
    const second = createHarnessConnection({
      id: "second",
      harness: "connection-fixture",
      nativeContextRef: "/private/second",
    });
    const latest = await writeUserConnections([first], {
      path,
      expectedRevision: stale.revision,
    });
    await assert.rejects(
      writeUserConnections([second], { path, expectedRevision: stale.revision }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "connection_conflict" && error.retryable,
    );
    assert.deepEqual((await loadUserConnectionsSnapshot(path)).connections, [first]);
    assert.notEqual(latest.revision, stale.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent child-process mutations preserve both registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-processes-"));
  const path = join(root, "connections.json");
  try {
    await Promise.all([
      spawnConnectionWriter(path, "writer-one"),
      spawnConnectionWriter(path, "writer-two"),
    ]);
    const connections = await loadUserConnections(path);
    assert.deepEqual(connections.map(({ id }) => id).sort(), ["writer-one", "writer-two"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abandoned writer lock fails within the bound and preserves existing registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-abandoned-lock-"));
  const path = join(root, "connections.json");
  try {
    await replaceConnections(
      [
        createHarnessConnection({
          id: "preserved",
          harness: "connection-fixture",
          nativeContextRef: "/private/preserved",
        }),
      ],
      path,
    );
    const before = await readFile(path, "utf8");
    const pid = await spawnAbandonedConnectionLock(`${path}.lock`);
    const startedAt = Date.now();
    await assert.rejects(
      mutateUserConnections((current) => ({ connections: [], result: current.length }), path),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "connection_conflict" &&
        error.retryable &&
        error.message.includes(String(pid)),
    );
    assert.ok(Date.now() - startedAt < 7500, "lock wait exceeded the documented bound");
    assert.equal(await readFile(path, "utf8"), before);
    assert.ok((await readFile(`${path}.lock`, "utf8")).includes(String(pid)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical registration mutations are idempotent and keep their snapshot revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-idempotent-"));
  const path = join(root, "connections.json");
  const connection = createHarnessConnection({
    id: "repeatable",
    harness: "connection-fixture",
    nativeContextRef: "/private/repeatable",
  });
  try {
    const registerIfMissing = async () =>
      mutateUserConnections(
        (current) => ({
          connections: current.some(({ id }) => id === connection.id)
            ? current
            : [...current, connection],
          result: connection,
        }),
        path,
      );
    const first = await registerIfMissing();
    const second = await registerIfMissing();
    assert.equal(second.snapshot.revision, first.snapshot.revision);
    assert.deepEqual(second.snapshot.connections, [connection]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker, typed client, and MCP share safe connection management semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-operations-"));
  const configDirectory = join(root, "config");
  const connectionsPath = join(configDirectory, "connections.json");
  const contextOne = join(root, "native-one");
  const contextTwo = join(root, "native-two");
  const mcpContext = join(root, "native-mcp");
  const mcpSentinel = join(mcpContext, "context.marker");
  await mkdir(contextOne, { mode: 0o700 });
  await mkdir(contextTwo, { mode: 0o700 });
  await mkdir(mcpContext, { mode: 0o700 });
  await writeFile(mcpSentinel, "preserve this user-owned context\n");
  const adapter = new NativeContextFixtureAdapter();
  const brokerPathsValue = {
    ...brokerPaths(root),
    socketPath: join(tmpdir(), `hrc-${randomUUID()}.sock`),
  };
  const broker = new Broker(brokerPathsValue, {
    registry: new AdapterRegistry([adapter], {
      catalogPath: join(configDirectory, "catalog.json"),
      connectionsPath,
    }),
  });
  await broker.initialize();
  const brokerServer = new BrokerServer(
    broker,
    brokerPathsValue.socketPath,
    brokerPathsValue.runtimeDirectory,
  );
  await brokerServer.start();
  const client = createClient({ socketPath: brokerPathsValue.socketPath, autostart: false });
  const mcp = new McpServer(async (operation, params) => broker.execute(operation, params));
  try {
    const discovery = await client.discoverConnections({ refresh: true });
    assert.deepEqual(discovery.connections, []);
    assert.ok(discovery.routes.some((route) => route.connectionId === undefined));
    assert.ok(!JSON.stringify(discovery).includes(contextOne));

    await assert.rejects(
      client.prepareConnection({ id: "../escape", harness: "codex" }),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_request",
    );
    await assert.rejects(
      lstat(join(configDirectory, "native-contexts")),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
    );

    const registered = await client.registerConnection({
      id: "analysis",
      harness: "codex",
      nativeContextRef: contextOne,
      purpose: "analysis",
    });
    assert.equal(registered.readiness, "ready");
    assert.ok(!JSON.stringify(registered).includes(contextOne));
    const repeated = await client.registerConnection({
      id: "analysis",
      harness: "codex",
      nativeContextRef: contextOne,
      purpose: "analysis",
    });
    assert.equal(repeated.connection.revision, registered.connection.revision);

    const list = await client.connections();
    assert.deepEqual(
      list.connections.map(({ id }) => id),
      ["analysis"],
    );
    assert.ok(!JSON.stringify(list).includes(contextOne));
    const inspection = await client.inspectConnection("analysis");
    assert.equal(inspection.readiness, "ready");
    assert.equal(inspection.userActionRequired, false);
    assert.ok(!JSON.stringify(inspection).includes(contextOne));

    await assert.rejects(
      client.registerConnection({
        id: "duplicate",
        harness: "codex",
        nativeContextRef: contextOne,
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "connection_conflict",
    );
    const second = await client.registerConnection({
      id: "implementation",
      harness: "codex",
      nativeContextRef: contextTwo,
      purpose: "implementation",
    });
    await assert.rejects(
      client.updateConnection({
        id: "implementation",
        expectedRevision: second.connection.revision,
        nativeContextRef: contextOne,
      }),
      (error: unknown) => error instanceof BridgeError && error.code === "connection_conflict",
    );

    const updated = await client.updateConnection({
      id: "analysis",
      expectedRevision: registered.connection.revision,
      purpose: "review",
    });
    assert.equal(updated.connection.purpose, "review");
    assert.notEqual(updated.connection.revision, registered.connection.revision);
    await assert.rejects(
      client.removeConnection({ id: "analysis", expectedRevision: registered.connection.revision }),
      (error: unknown) => error instanceof BridgeError && error.code === "connection_conflict",
    );

    const listed = JSON.parse(
      (await mcp.handle(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      )) ?? "null",
    ) as { result?: { tools?: ReadonlyArray<{ name: string }> } };
    const tools = listed.result?.tools ?? [];
    for (const name of [
      "harness_relay_connection_discover",
      "harness_relay_connection_list",
      "harness_relay_connection_inspect",
      "harness_relay_connection_register",
      "harness_relay_connection_prepare",
      "harness_relay_connection_update",
      "harness_relay_connection_remove",
    ]) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `Missing MCP tool ${name}`,
      );
    }
    const invalidMcpRegistration = await callMcpTool(mcp, 2, "harness_relay_connection_register", {
      id: "../escape",
      harness: "codex",
      nativeContextRef: mcpContext,
    });
    assert.equal(mcpErrorCode(invalidMcpRegistration), "invalid_request");

    const mcpRegistration = await callMcpTool(mcp, 3, "harness_relay_connection_register", {
      id: "mcp-analysis",
      harness: "codex",
      nativeContextRef: mcpContext,
      purpose: "mcp setup",
    });
    assert.equal(mcpRegistration.isError, undefined);
    const mcpRegistrationResult = mcpRegistration.structuredContent as {
      readonly connection: {
        readonly id: string;
        readonly revision: string;
        readonly purpose?: string;
      };
      readonly readiness: string;
    };
    assert.equal(mcpRegistrationResult.connection.id, "mcp-analysis");
    assert.equal(mcpRegistrationResult.readiness, "ready");
    assert.ok(!JSON.stringify(mcpRegistration.structuredContent).includes(mcpContext));

    const mcpInspection = await callMcpTool(mcp, 4, "harness_relay_connection_inspect", {
      id: mcpRegistrationResult.connection.id,
    });
    assert.equal(mcpInspection.isError, undefined);
    const mcpInspectionResult = mcpInspection.structuredContent as ConnectionInspection;
    assert.equal(mcpInspectionResult.connection.id, "mcp-analysis");
    assert.equal(mcpInspectionResult.readiness, "ready");

    const mcpDuplicate = await callMcpTool(mcp, 5, "harness_relay_connection_register", {
      id: "mcp-duplicate",
      harness: "codex",
      nativeContextRef: mcpContext,
    });
    assert.equal(mcpErrorCode(mcpDuplicate), "connection_conflict");

    const mcpUpdate = await callMcpTool(mcp, 6, "harness_relay_connection_update", {
      id: mcpRegistrationResult.connection.id,
      expectedRevision: mcpRegistrationResult.connection.revision,
      purpose: "mcp review",
    });
    assert.equal(mcpUpdate.isError, undefined);
    const mcpUpdateResult = mcpUpdate.structuredContent as {
      readonly connection: {
        readonly id: string;
        readonly revision: string;
        readonly purpose?: string;
      };
    };
    assert.equal(mcpUpdateResult.connection.purpose, "mcp review");
    assert.notEqual(mcpUpdateResult.connection.revision, mcpRegistrationResult.connection.revision);

    const staleMcpUpdate = await callMcpTool(mcp, 7, "harness_relay_connection_update", {
      id: mcpRegistrationResult.connection.id,
      expectedRevision: mcpRegistrationResult.connection.revision,
      purpose: "stale MCP update",
    });
    assert.equal(mcpErrorCode(staleMcpUpdate), "connection_conflict");

    const mcpDiscovery = await callMcpTool(mcp, 8, "harness_relay_connection_discover", {
      refresh: true,
    });
    assert.equal(mcpDiscovery.isError, undefined);
    const mcpDiscoveryResult = mcpDiscovery.structuredContent as ConnectionDiscoverResult;
    assert.ok(mcpDiscoveryResult.routes.some((route) => route.connectionId === undefined));
    assert.ok(mcpDiscoveryResult.routes.some((route) => route.connectionId === "mcp-analysis"));
    assert.ok(!JSON.stringify(mcpDiscovery.structuredContent).includes(mcpContext));

    const defaultStart = await callMcpTool(mcp, 9, "harness_relay_invocation_start", request(root));
    assert.equal(defaultStart.isError, undefined);
    const defaultStartResult = defaultStart.structuredContent as { readonly invocationId: string };
    const defaultInspection = await callMcpTool(mcp, 10, "harness_relay_invocation_inspect", {
      invocationId: defaultStartResult.invocationId,
    });
    const defaultInspectionResult = defaultInspection.structuredContent as {
      readonly resolved: { readonly connectionId?: string };
    };
    assert.equal(defaultInspectionResult.resolved.connectionId, undefined);

    const mcpRemove = await callMcpTool(mcp, 11, "harness_relay_connection_remove", {
      id: mcpUpdateResult.connection.id,
      expectedRevision: mcpUpdateResult.connection.revision,
    });
    assert.equal(mcpRemove.isError, undefined);
    assert.equal((mcpRemove.structuredContent as { readonly removed: boolean }).removed, true);
    await lstat(mcpContext);
    assert.equal(await readFile(mcpSentinel, "utf8"), "preserve this user-owned context\n");
    const mcpList = await callMcpTool(mcp, 12, "harness_relay_connection_list");
    const mcpListResult = mcpList.structuredContent as {
      readonly connections: ReadonlyArray<{ readonly id: string }>;
    };
    assert.ok(!mcpListResult.connections.some(({ id }) => id === "mcp-analysis"));

    const mcpPrepared = await callMcpTool(mcp, 13, "harness_relay_connection_prepare", {
      id: "prepared",
      harness: "codex",
      purpose: "analysis",
    });
    assert.equal(mcpPrepared.isError, undefined);
    const prepared = mcpPrepared.structuredContent as ConnectionPrepareResult;
    assert.ok(prepared);
    assert.equal(prepared.setup.login.executable, "codex");
    assert.deepEqual(prepared.setup.login.args, ["login"]);
    assert.equal(prepared.setup.login.env.CODEX_HOME, prepared.setup.contextPath);
    assert.ok(!JSON.stringify(prepared.connection).includes(prepared.setup.contextPath));
    const repeatedPrepare = await client.prepareConnection({
      id: "prepared",
      harness: "codex",
      purpose: "analysis",
    });
    assert.equal(repeatedPrepare.connection.revision, prepared.connection.revision);
    assert.equal(repeatedPrepare.setup.contextPath, prepared.setup.contextPath);

    const refreshed = await client.discoverConnections({ refresh: true });
    assert.ok(refreshed.routes.some((route) => route.connectionId === undefined));
    assert.ok(refreshed.routes.some((route) => route.connectionId === "prepared"));
    assert.ok(!JSON.stringify(refreshed).includes(prepared.setup.contextPath));

    const removed = await client.removeConnection({
      id: updated.connection.id,
      expectedRevision: updated.connection.revision,
    });
    assert.equal(removed.removed, true);
    await lstat(contextOne);
    await lstat(contextTwo);
    const afterRemove = await client.connections();
    assert.deepEqual(afterRemove.connections.map(({ id }) => id).sort(), [
      "implementation",
      "prepared",
    ]);
  } finally {
    await brokerServer.stop();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("connection routing keeps the default context and exposes no native reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-routing-"));
  const connectionsPath = join(root, "connections.json");
  const adapter = new ConnectionFixtureAdapter();
  try {
    const connection = await makeConnection(connectionsPath);
    const registry = new AdapterRegistry([adapter], {
      catalogPath: join(root, "models.json"),
      connectionsPath,
    });

    const routes = await registry.discover({ refresh: true });
    const named = routes.find((route) => route.connectionId === connection.id);
    assert.ok(named);
    assert.equal(named.connectionRevision, connection.revision);
    assert.equal(named.connectionPurpose, connection.purpose);
    assert.notEqual(named.routeId, descriptor(adapter.id).routeId);
    assert.ok(!JSON.stringify(named).includes(connection.nativeContextRef));
    assert.deepEqual(named.diagnostics, ["[redacted native context]"]);

    const scopedRoutes = await registry.discover({ connectionId: connection.id });
    assert.ok(scopedRoutes.length > 0);
    assert.ok(scopedRoutes.every((route) => route.connectionId === connection.id));

    const defaultRoute = await registry.resolve(request(root));
    assert.equal(defaultRoute.route.connectionId, undefined);
    assert.equal(defaultRoute.connectionContext, undefined);

    const selected = await registry.resolve(request(root, connection.id));
    assert.equal(selected.route.connectionId, connection.id);
    assert.equal(selected.route.connectionRevision, connection.revision);
    assert.equal(selected.connectionContext?.nativeContextRef, connection.nativeContextRef);
    assert.ok(!JSON.stringify(selected.route).includes(connection.nativeContextRef));

    await assert.rejects(registry.resolve(request(root, "missing")), (error: unknown) => {
      if (!(error instanceof BridgeError) || error.code !== "route_unavailable") {
        return false;
      }
      const details = JSON.stringify(error.details);
      return details.includes(connection.id) && !details.includes(connection.nativeContextRef);
    });
    await replaceConnections([], connectionsPath);
    await assert.rejects(
      registry.resolve(request(root, connection.id)),
      (error: unknown) => error instanceof BridgeError && error.code === "route_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous route resolution returns candidates without running an adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-ambiguous-"));
  const first = new AmbiguousRouteFixtureAdapter("fixture-first");
  const second = new AmbiguousRouteFixtureAdapter("fixture-second");
  const broker = new Broker(brokerPaths(root), {
    registry: new AdapterRegistry([first, second], {
      catalogPath: join(root, "models.json"),
      connectionsPath: join(root, "connections.json"),
    }),
  });
  await broker.initialize();
  try {
    let rejection: unknown;
    try {
      await broker.start(request(root));
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof BridgeError);
    assert.equal(rejection.code, "route_ambiguous");
    const candidates = rejection.details?.candidates;
    assert.ok(Array.isArray(candidates));
    const routeIds = candidates.flatMap((candidate: unknown) => {
      if (typeof candidate !== "object" || candidate === null || !("routeId" in candidate)) {
        return [];
      }
      return typeof candidate.routeId === "string" ? [candidate.routeId] : [];
    });
    const sortedRouteIds = [...routeIds].sort();
    assert.deepEqual(sortedRouteIds, [
      "fixture-first:fixture-model",
      "fixture-second:fixture-model",
    ]);
    assert.equal(first.runCalls, 0);
    assert.equal(second.runCalls, 0);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a discovery-only adapter cannot expose a named connection as a ready route", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-fail-closed-"));
  const connectionsPath = join(root, "connections.json");
  const adapter = new DiscoveryOnlyAdapter();
  try {
    const connection = await makeConnection(connectionsPath);
    const registry = new AdapterRegistry([adapter], {
      catalogPath: join(root, "models.json"),
      connectionsPath,
    });

    const defaultRoutes = await registry.discover({ refresh: true });
    assert.ok(defaultRoutes.every((route) => route.connectionId === undefined));
    assert.equal(adapter.discoveryCalls, 0);
    await assert.rejects(
      registry.discover({ connectionId: connection.id }),
      (error: unknown) => error instanceof BridgeError && error.code === "route_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invocation keeps its resolved connection snapshot after registration changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-snapshot-"));
  const connectionsPath = join(root, "connections.json");
  const adapter = new ConnectionFixtureAdapter(true);
  const connection = await makeConnection(connectionsPath);
  const broker = new Broker(brokerPaths(root), {
    registry: new AdapterRegistry([adapter], {
      catalogPath: join(root, "models.json"),
      connectionsPath,
    }),
  });
  await broker.initialize();
  try {
    const starting = broker.start(request(root, connection.id));
    await adapter.discoveryStarted.promise;

    const updated = updateHarnessConnection(connection, {
      id: connection.id,
      harness: connection.harness,
      nativeContextRef: "/private/native/context-replaced",
      purpose: "implementation",
    });
    await replaceConnections([updated], connectionsPath);
    adapter.releaseDiscovery();
    const started = await starting;
    await adapter.runStarted.promise;

    const metadataPath = join(
      root,
      "state",
      "invocations",
      encodeURIComponent(started.invocationId),
      "meta.json",
    );
    const metadata = await readFile(metadataPath, "utf8");
    assert.ok(!metadata.includes(connection.nativeContextRef));
    await replaceConnections([], connectionsPath);

    adapter.releaseRun();
    const terminal = await waitForTerminal(broker, started.invocationId);
    const resolved = terminal.resolved as Record<string, unknown>;
    assert.equal(terminal.state, "succeeded");
    assert.equal(resolved.connectionId, connection.id);
    assert.equal(resolved.connectionRevision, connection.revision);
    assert.equal(adapter.seenConnection?.nativeContextRef, connection.nativeContextRef);
    assert.equal(adapter.seenConnection?.revision, connection.revision);
    assert.ok(!JSON.stringify(terminal).includes(connection.nativeContextRef));
  } finally {
    adapter.releaseDiscovery();
    adapter.releaseRun();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation reuses only the original connection revision and rejects replacement or removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-continuation-"));
  const connectionsPath = join(root, "connections.json");
  const original = await makeConnection(connectionsPath);
  const adapter = new ConnectionFixtureAdapter(false, true);
  adapter.releaseRun();
  const broker = new Broker(brokerPaths(root), {
    registry: new AdapterRegistry([adapter], {
      catalogPath: join(root, "models.json"),
      connectionsPath,
    }),
  });
  await broker.initialize();
  try {
    const started = await broker.start(request(root, original.id));
    const predecessor = await waitForTerminal(broker, started.invocationId);
    const predecessorRoute = predecessor.resolved as Record<string, unknown>;
    assert.equal(predecessorRoute.connectionId, original.id);
    assert.equal(predecessorRoute.connectionRevision, original.revision);

    const continuation = await broker.execute("invocation.continue", {
      invocationId: started.invocationId,
      input: [{ type: "text", text: "continue in the same native context" }],
      idempotencyKey: "connection-continuation-1",
    });
    const continuedId = (continuation as { invocationId: string }).invocationId;
    const continued = await waitForTerminal(broker, continuedId);
    const continuedRoute = continued.resolved as Record<string, unknown>;
    assert.equal(continuedRoute.connectionId, original.id);
    assert.equal(continuedRoute.connectionRevision, original.revision);
    assert.deepEqual(adapter.seenContinuationHandles, [undefined, "fixture-native-session"]);
    assert.deepEqual(
      adapter.seenConnections.map(({ nativeContextRef, revision }) => ({
        nativeContextRef,
        revision,
      })),
      [
        { nativeContextRef: original.nativeContextRef, revision: original.revision },
        { nativeContextRef: original.nativeContextRef, revision: original.revision },
      ],
    );
    assert.ok(!JSON.stringify([predecessor, continued]).includes(original.nativeContextRef));

    const replacement = updateHarnessConnection(original, {
      id: original.id,
      harness: original.harness,
      nativeContextRef: "/private/native/context-replacement",
      purpose: "implementation",
    });
    await replaceConnections([replacement], connectionsPath);
    await assert.rejects(
      broker.execute("invocation.continue", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "must not use a replacement login" }],
        idempotencyKey: "connection-continuation-replaced",
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    await replaceConnections([], connectionsPath);
    await assert.rejects(
      broker.execute("invocation.continue", {
        invocationId: started.invocationId,
        input: [{ type: "text", text: "must not use a removed login" }],
        idempotencyKey: "connection-continuation-removed",
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    assert.equal(adapter.seenConnections.length, 2);
    assert.ok(!JSON.stringify(adapter.seenConnections).includes(replacement.nativeContextRef));
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stored invocations without connection fields remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-legacy-"));
  const broker = new Broker(brokerPaths(root));
  await broker.initialize();
  let invocationId: string | undefined;
  try {
    const started = await broker.start({
      selector: {
        provider: "harness-relay",
        model: "fake-echo",
        via: "fake",
        requiredCapabilities: ["core.input.text"],
      },
      input: [{ type: "text", text: "legacy route" }],
      workingDirectory: root,
      interactionStrategy: "orchestrator",
      requestedPolicy: { minimumAssurance: "none" },
    });
    invocationId = started.invocationId;
    await waitForTerminal(broker, invocationId);
  } finally {
    await broker.close();
  }

  try {
    assert.ok(invocationId);
    const metadataPath = join(
      root,
      "state",
      "invocations",
      encodeURIComponent(invocationId),
      "meta.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      resolvedRoute: Record<string, unknown>;
    };
    delete metadata.resolvedRoute.connectionId;
    delete metadata.resolvedRoute.connectionRevision;
    await writeFile(metadataPath, JSON.stringify(metadata));

    const reloaded = new Broker(brokerPaths(root));
    await reloaded.initialize();
    try {
      const inspected = await reloaded.inspect(invocationId);
      const resolved = inspected.resolved as Record<string, unknown>;
      assert.equal(resolved.connectionId, undefined);
      assert.equal(resolved.connectionRevision, undefined);
    } finally {
      await reloaded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
