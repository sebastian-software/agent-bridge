import { ROUTE_TIERS, type RouteBilling, type RouteGuidance, type RouteTier } from "./contract.js";
import { BridgeError } from "./errors.js";

export type ModelGuidance = Omit<RouteGuidance, "source">;

export type UserGuidanceDefinition = {
  readonly tier: RouteTier;
  readonly strengths?: readonly string[];
  readonly asOf?: string;
};

export const UNKNOWN_BILLING: RouteBilling = { mode: "unknown", evidence: "unverified" };

export const LOCAL_BILLING: RouteBilling = { mode: "local", evidence: "inferred" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function isTier(value: unknown): value is RouteTier {
  return ROUTE_TIERS.some((tier) => tier === value);
}

export function parseUserGuidance(value: unknown, label: string): UserGuidanceDefinition {
  const invalid = (detail: string): BridgeError =>
    new BridgeError({
      code: "invalid_request",
      message: `Model catalog guidance for ${label} ${detail}`,
      retryable: false,
    });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!isTier(source.tier)) {
    throw invalid(`needs a tier: ${ROUTE_TIERS.join(", ")}.`);
  }
  const { strengths, asOf } = source;
  if (
    strengths !== undefined &&
    (!Array.isArray(strengths) ||
      !strengths.every((entry) => typeof entry === "string" && entry !== ""))
  ) {
    throw invalid("contains an invalid strengths list.");
  }
  if (asOf !== undefined && (typeof asOf !== "string" || !ISO_DATE.test(asOf))) {
    throw invalid("needs asOf as an ISO date (YYYY-MM-DD).");
  }
  return {
    tier: source.tier,
    ...(strengths === undefined ? {} : { strengths: strengths as readonly string[] }),
    ...(asOf === undefined ? {} : { asOf }),
  };
}

export function builtInGuidance(guidance: ModelGuidance): RouteGuidance {
  return { ...guidance, source: "built-in" };
}

export function userDeclaredGuidance(definition: UserGuidanceDefinition): RouteGuidance {
  return {
    tier: definition.tier,
    strengths: definition.strengths ?? [],
    source: "user-declared",
    ...(definition.asOf === undefined ? {} : { asOf: definition.asOf }),
  };
}
