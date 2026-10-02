import type { RouteBilling } from "../contract.js";

import { UNKNOWN_BILLING } from "../route-guidance.js";

const REPORTED_SUBSCRIPTION: RouteBilling = { mode: "subscription", evidence: "reported" };
const REPORTED_METERED: RouteBilling = { mode: "metered", evidence: "reported" };

/**
 * Classifies `claude auth status` output. Only the claude.ai subscription
 * login was observed (Claude Code 2.1.282); every other shape stays unknown.
 */
export function claudeBillingFromAuthStatus(output: string): RouteBilling {
  let status: unknown;
  try {
    status = JSON.parse(output) as unknown;
  } catch {
    return UNKNOWN_BILLING;
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    return UNKNOWN_BILLING;
  }
  const source = status as Record<string, unknown>;
  return source.loggedIn === true &&
    source.authMethod === "claude.ai" &&
    typeof source.subscriptionType === "string" &&
    source.subscriptionType !== ""
    ? REPORTED_SUBSCRIPTION
    : UNKNOWN_BILLING;
}

/**
 * Classifies `codex login status` output. The ChatGPT login was observed on
 * Codex CLI 0.159.2; the API key wording is the one that version prints.
 */
export function codexBillingFromLoginStatus(output: string): RouteBilling {
  if (/^Logged in using ChatGPT\b/mu.test(output)) {
    return REPORTED_SUBSCRIPTION;
  }
  if (/^Logged in using an API key\b/mu.test(output)) {
    return REPORTED_METERED;
  }
  return UNKNOWN_BILLING;
}
