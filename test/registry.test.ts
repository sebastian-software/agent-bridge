import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterRegistry,
  FAKE_ROUTES_ENVIRONMENT_VARIABLE,
  fakeRoutesEnabled,
} from "../src/adapters/registry.js";
import { BridgeError } from "../src/errors.js";

async function withFakeRoutesSwitch<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.HARNESS_RELAY_FAKE_ROUTES;
  if (value === undefined) {
    delete process.env.HARNESS_RELAY_FAKE_ROUTES;
  } else {
    process.env.HARNESS_RELAY_FAKE_ROUTES = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_RELAY_FAKE_ROUTES;
    } else {
      process.env.HARNESS_RELAY_FAKE_ROUTES = previous;
    }
  }
}

function isRouteUnavailable(error: unknown): boolean {
  return error instanceof BridgeError && error.code === "route_unavailable";
}

test("the fake-routes switch requires an explicit opt-in value", () => {
  assert.equal(FAKE_ROUTES_ENVIRONMENT_VARIABLE, "HARNESS_RELAY_FAKE_ROUTES");
  assert.equal(fakeRoutesEnabled({}), false);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "" }), false);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "0" }), false);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "false" }), false);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "yes" }), false);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "1" }), true);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: " 1 " }), true);
  assert.equal(fakeRoutesEnabled({ HARNESS_RELAY_FAKE_ROUTES: "true" }), true);
});

test("the default registry leaves the fake fixtures out unless the switch is set", async () => {
  await withFakeRoutesSwitch(undefined, async () => {
    const registry = new AdapterRegistry();
    try {
      assert.equal(registry.adapter("claude").id, "claude");
      assert.equal(registry.adapter("codex").id, "codex");
      assert.throws(() => registry.adapter("fake"), isRouteUnavailable);
      assert.throws(() => registry.adapter("fake-process"), isRouteUnavailable);
    } finally {
      await registry.dispose();
    }
  });

  await withFakeRoutesSwitch("1", async () => {
    const registry = new AdapterRegistry();
    try {
      assert.equal(registry.adapter("fake").id, "fake");
      assert.equal(registry.adapter("fake-process").id, "fake-process");
      assert.equal(registry.adapter("claude").id, "claude");
    } finally {
      await registry.dispose();
    }
  });
});

test("an explicit adapter list is not affected by the fake-routes switch", async () => {
  await withFakeRoutesSwitch("1", async () => {
    const registry = new AdapterRegistry([]);
    try {
      assert.throws(() => registry.adapter("fake"), isRouteUnavailable);
    } finally {
      await registry.dispose();
    }
  });
});
