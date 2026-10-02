import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Adapter, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import type { RouteDescriptor } from "../src/contract.js";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { BridgeError } from "../src/errors.js";
import { applyUserModelCatalog } from "../src/model-catalog.js";

class CountingAdapter implements Adapter {
  readonly id = "counting";
  calls = 0;

  async discover(): Promise<readonly RouteDescriptor[]> {
    this.calls += 1;
    return [
      {
        routeId: "counting:test",
        provider: "counting",
        model: "test",
        efforts: ["low"],
        via: "counting",
        adapter: this.id,
        harnessVersion: "1.0.0",
        authenticationMode: "none",
        capabilities: [],
        interactionStrategies: ["deny"],
        assurance: "none",
        runtimeIdentityEvidence: "verified",
        readiness: "ready",
        qualification: [],
        diagnostics: [],
      },
    ];
  }

  async run(_context: AdapterRunContext): Promise<AdapterRunResult> {
    throw new Error("Not used in discovery cache test.");
  }
}

test("user model catalog adds aliases and canonical native model mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-catalog-"));
  const catalogPath = join(root, "config.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      adapters: {
        fake: {
          aliases: { quick: "fake-echo" },
          models: {
            local: {
              nativeModel: "fake-echo",
              efforts: ["low"],
            },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const registry = new AdapterRegistry([new FakeAdapter()], { catalogPath });
    const routes = await registry.discover();
    const alias = routes.find((route) => route.model === "quick");
    const custom = routes.find((route) => route.model === "local");
    assert.equal(alias?.canonicalModel, "fake-echo");
    assert.equal(alias?.nativeModel, "fake-echo");
    assert.equal(alias?.qualification.at(-1)?.qualificationId, "user-declared:fake:quick");
    assert.equal(custom?.canonicalModel, "fake-echo");
    assert.equal(custom?.nativeModel, "fake-echo");
    assert.deepEqual(custom?.efforts, ["low"]);

    const resolved = await registry.resolve({
      selector: {
        provider: "harness-relay",
        model: "quick",
        via: "fake",
        requiredCapabilities: [],
      },
      input: [{ type: "text", text: "hello" }],
      workingDirectory: root,
      interactionStrategy: "deny",
      requestedPolicy: { minimumAssurance: "none" },
    });
    assert.equal(resolved.route.model, "quick");
    assert.equal(resolved.route.canonicalModel, "fake-echo");
    assert.equal(resolved.route.nativeModel, "fake-echo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter route discovery is cached and can be refreshed", async () => {
  const adapter = new CountingAdapter();
  const registry = new AdapterRegistry([adapter]);
  const first = await registry.discover();
  const second = await registry.discover();
  assert.equal(adapter.calls, 1);
  assert.equal(first[0]?.discoveredAt, second[0]?.discoveredAt);
  await registry.discover({ refresh: true });
  assert.equal(adapter.calls, 2);
});

test("user aliases preserve a native harness alias separately from its canonical hint", async () => {
  const routes = await new ClaudeAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "2.1.235 (Claude Code)",
      checkAuthentication: async () => true,
    },
  }).discover();
  const mapped = applyUserModelCatalog(routes, {
    adapters: { claude: { aliases: { quick: "opus" } } },
  });
  const quick = mapped.find((route) => route.adapter === "claude" && route.model === "quick");
  assert.equal(quick?.canonicalModel, "claude-opus-5-5");
  assert.equal(quick?.nativeModel, "opus");
});

test("user catalog declares and replaces route guidance without touching resolution fields", async () => {
  const routes = await new ClaudeAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "2.1.282 (Claude Code)",
      checkAuthentication: async () => true,
    },
  }).discover();
  const mapped = applyUserModelCatalog(routes, {
    adapters: {
      claude: {
        aliases: { quick: "opus" },
        models: {
          preview: { nativeModel: "claude-preview", guidance: { tier: "frontier" } },
          plain: { nativeModel: "claude-plain" },
        },
        guidance: { "claude-sonnet-5-5": { tier: "fast", strengths: ["speed"] } },
      },
    },
  });
  const byModel = (model: string): RouteDescriptor | undefined =>
    mapped.find((route) => route.model === model);

  // An alias names the same model, so the built-in assessment carries over.
  assert.equal(byModel("quick")?.guidance?.tier, "strong");
  assert.equal(byModel("quick")?.guidance?.source, "built-in");
  // A user-declared model is a different model: only its own declaration counts.
  assert.deepEqual(byModel("preview")?.guidance, {
    tier: "frontier",
    strengths: [],
    source: "user-declared",
  });
  assert.equal(byModel("plain")?.guidance, undefined);
  // A declaration keyed by model replaces the built-in assessment.
  assert.deepEqual(byModel("claude-sonnet-5-5")?.guidance, {
    tier: "fast",
    strengths: ["speed"],
    source: "user-declared",
  });
  assert.equal(byModel("claude-fable-5-1")?.guidance?.source, "built-in");

  const sonnet = routes.find((route) => route.model === "claude-sonnet-5-5");
  const { guidance: _before, ...original } = sonnet ?? {};
  const { guidance: _after, ...replaced } = byModel("claude-sonnet-5-5") ?? {};
  assert.deepEqual(replaced, original);
});

test("user catalog rejects malformed guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-catalog-"));
  const catalogPath = join(root, "config.json");
  try {
    for (const adapter of [
      { guidance: [] },
      { guidance: { opus: { tier: "best" } } },
      { models: { preview: { nativeModel: "claude-preview", guidance: { tier: "best" } } } },
    ]) {
      await writeFile(catalogPath, JSON.stringify({ adapters: { claude: adapter } }), "utf8");
      await assert.rejects(
        new AdapterRegistry([new FakeAdapter()], { catalogPath }).discover(),
        (error) => error instanceof BridgeError && error.code === "invalid_request",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model aliases preserve readiness and identity evidence per connection", async () => {
  const [template] = await new FakeAdapter().discover();
  assert.ok(template);
  const routes: RouteDescriptor[] = [
    {
      ...template,
      routeId: "fake:source",
      model: "source",
      runtimeIdentityEvidence: "reported",
      readiness: "ready",
      authenticationMode: "default-login",
      qualification: [
        {
          qualificationId: "default-context",
          testedAt: "2026-09-28T00:00:00.000Z",
          claim: "Default fixture.",
        },
      ],
    },
    {
      ...template,
      routeId: "fake:source:connection:alpha@revision-alpha",
      model: "source",
      connectionId: "alpha",
      connectionRevision: "revision-alpha",
      runtimeIdentityEvidence: "unverified",
      readiness: "unavailable",
      authenticationMode: "alpha-context",
      qualification: [
        {
          qualificationId: "alpha-context",
          testedAt: "2026-09-28T00:00:00.000Z",
          claim: "Alpha fixture.",
        },
      ],
    },
    {
      ...template,
      routeId: "fake:source:connection:beta@revision-beta",
      model: "source",
      connectionId: "beta",
      connectionRevision: "revision-beta",
      runtimeIdentityEvidence: "verified",
      readiness: "ready",
      authenticationMode: "beta-context",
      qualification: [
        {
          qualificationId: "beta-context",
          testedAt: "2026-09-28T00:00:00.000Z",
          claim: "Beta fixture.",
        },
      ],
    },
  ];

  const aliases = applyUserModelCatalog(routes, {
    adapters: { fake: { aliases: { quick: "source" } } },
  }).filter((route) => route.model === "quick");

  assert.equal(aliases.length, 3);
  const byConnection = new Map(aliases.map((route) => [route.connectionId, route]));
  const defaultAlias = byConnection.get(undefined);
  const alphaAlias = byConnection.get("alpha");
  const betaAlias = byConnection.get("beta");
  assert.equal(defaultAlias?.routeId, "fake:quick");
  assert.equal(alphaAlias?.routeId, "fake:quick:connection:alpha@revision-alpha");
  assert.equal(betaAlias?.routeId, "fake:quick:connection:beta@revision-beta");
  assert.deepEqual(
    [defaultAlias, alphaAlias, betaAlias].map((route) => ({
      readiness: route?.readiness,
      identity: route?.runtimeIdentityEvidence,
      authenticationMode: route?.authenticationMode,
      qualificationId: route?.qualification[0]?.qualificationId,
    })),
    [
      {
        readiness: "ready",
        identity: "reported",
        authenticationMode: "default-login",
        qualificationId: "default-context",
      },
      {
        readiness: "unavailable",
        identity: "unverified",
        authenticationMode: "alpha-context",
        qualificationId: "alpha-context",
      },
      {
        readiness: "ready",
        identity: "verified",
        authenticationMode: "beta-context",
        qualificationId: "beta-context",
      },
    ],
  );
});

test("resolver refresh bypasses its default-route discovery cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-route-refresh-"));
  const adapter = new CountingAdapter();
  try {
    const registry = new AdapterRegistry([adapter], {
      catalogPath: join(root, "models.json"),
      connectionsPath: join(root, "connections.json"),
    });
    const request = {
      selector: { provider: "counting", model: "test", via: "counting", requiredCapabilities: [] },
      input: [{ type: "text" as const, text: "refresh route" }],
      workingDirectory: root,
      interactionStrategy: "deny" as const,
      requestedPolicy: { minimumAssurance: "none" as const },
    };

    await registry.resolve(request);
    await registry.resolve(request);
    assert.equal(adapter.calls, 1);
    await registry.resolve(request, { refresh: true });
    assert.equal(adapter.calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
