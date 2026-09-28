import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Adapter,
  AdapterConnectionRunContext,
  AdapterRunContext,
  AdapterRunResult,
} from "../src/adapters/types.js";
import type { AdapterConnectionContext, HarnessConnection } from "../src/connections.js";
import type { ObservedIdentity, RouteDescriptor, StartInvocationRequest } from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import {
  createHarnessConnection,
  loadUserConnections,
  summarizeConnection,
  updateHarnessConnection,
  writeUserConnections,
} from "../src/connections.js";
import { BridgeError } from "../src/errors.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
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

function descriptor(adapter: string): RouteDescriptor {
  return {
    routeId: `${adapter}:fixture-model`,
    provider: "connection-fixture",
    model: "fixture-model",
    efforts: ["low", "high"],
    via: "connection-fixture",
    adapter,
    harnessVersion: "1.0.0",
    authenticationMode: "fixture",
    capabilities: ["core.input.text", "core.output.text"],
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
  seenConnection: AdapterConnectionContext | undefined;
  readonly discoveryStarted = deferred();
  readonly discoveryGate = deferred();
  readonly runStarted = deferred();
  readonly runGate = deferred();
  readonly #waitForDiscovery: boolean;

  constructor(waitForDiscovery = false) {
    this.#waitForDiscovery = waitForDiscovery;
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
    return [{ ...descriptor(this.id), diagnostics: [connection.nativeContextRef] }];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    return fixtureResult();
  }

  async runConnection(context: AdapterConnectionRunContext): Promise<AdapterRunResult> {
    this.seenConnection = context.connection;
    this.runStarted.resolve();
    await this.runGate.promise;
    return fixtureResult();
  }

  releaseDiscovery(): void {
    this.discoveryGate.resolve();
  }

  releaseRun(): void {
    this.runGate.resolve();
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
  await writeUserConnections([connection], path);
  return connection;
}

test("connection storage validates before atomically replacing the user file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-connections-store-"));
  const path = join(root, "connections.json");
  try {
    const connection = await makeConnection(path);
    assert.deepEqual(await loadUserConnections(path), [connection]);
    const before = await readFile(path, "utf8");

    await assert.rejects(
      writeUserConnections([connection, connection], path),
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
    await writeUserConnections([updated], path);
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
    assert.deepEqual(named.diagnostics, ["[redacted]"]);

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
    await writeUserConnections([], connectionsPath);
    await assert.rejects(
      registry.resolve(request(root, connection.id)),
      (error: unknown) => error instanceof BridgeError && error.code === "route_unavailable",
    );
  } finally {
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
    await writeUserConnections([updated], connectionsPath);
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
    await writeUserConnections([], connectionsPath);

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
