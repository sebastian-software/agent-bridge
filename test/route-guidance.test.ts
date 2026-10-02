import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeBillingFromAuthStatus,
  codexBillingFromLoginStatus,
} from "../src/adapters/billing.js";
import { BridgeError } from "../src/errors.js";
import {
  builtInGuidance,
  parseUserGuidance,
  UNKNOWN_BILLING,
  userDeclaredGuidance,
} from "../src/route-guidance.js";

test("user guidance needs a known tier and keeps optional fields", () => {
  assert.deepEqual(parseUserGuidance({ tier: "fast" }, "pi/qwen3"), { tier: "fast" });
  assert.deepEqual(
    parseUserGuidance(
      { tier: "frontier", strengths: ["computer-use"], asOf: "2026-10-02" },
      "codex/gpt-6-astra",
    ),
    { tier: "frontier", strengths: ["computer-use"], asOf: "2026-10-02" },
  );
  for (const invalid of [
    undefined,
    [],
    {},
    { tier: "best" },
    { tier: "fast", strengths: "speed" },
    { tier: "fast", strengths: [""] },
    { tier: "fast", asOf: "October 2026" },
  ]) {
    assert.throws(
      () => parseUserGuidance(invalid, "codex/example"),
      (error) => error instanceof BridgeError && error.message.includes("codex/example"),
    );
  }
});

test("route guidance records where the assessment comes from", () => {
  assert.deepEqual(builtInGuidance({ tier: "strong", strengths: [], asOf: "2026-10-02" }), {
    tier: "strong",
    strengths: [],
    asOf: "2026-10-02",
    source: "built-in",
  });
  assert.deepEqual(userDeclaredGuidance({ tier: "fast" }), {
    tier: "fast",
    strengths: [],
    source: "user-declared",
  });
});

test("Claude billing is reported only for the observed subscription login", () => {
  assert.deepEqual(
    claudeBillingFromAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    ),
    { mode: "subscription", evidence: "reported" },
  );
  for (const output of [
    "not json",
    "[]",
    JSON.stringify({ loggedIn: false, authMethod: "claude.ai", subscriptionType: "max" }),
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    JSON.stringify({ loggedIn: true, authMethod: "other", subscriptionType: "max" }),
  ]) {
    assert.deepEqual(claudeBillingFromAuthStatus(output), UNKNOWN_BILLING);
  }
});

test("Codex billing follows the login status wording", () => {
  assert.deepEqual(codexBillingFromLoginStatus("Logged in using ChatGPT\n"), {
    mode: "subscription",
    evidence: "reported",
  });
  assert.deepEqual(codexBillingFromLoginStatus("Logged in using an API key - sk-***\n"), {
    mode: "metered",
    evidence: "reported",
  });
  for (const output of ["", "Not logged in", "Logged in using workload identity"]) {
    assert.deepEqual(codexBillingFromLoginStatus(output), UNKNOWN_BILLING);
  }
});
