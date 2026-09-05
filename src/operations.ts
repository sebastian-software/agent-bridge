import { SCHEMA_VERSION } from "./contract.js";

export type OperationAvailability = "implemented" | "planned";

export interface OperationDefinition {
  readonly name: string;
  readonly summary: string;
  readonly availability: OperationAvailability;
  readonly cli: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
}

export const OPERATIONS_VERSION = "1.0" as const;

export interface SchemaDefinition {
  readonly name: string;
  readonly version: typeof SCHEMA_VERSION;
  readonly path: string;
}

export const SCHEMA_DEFINITIONS: readonly SchemaDefinition[] = [
  { name: "invocation-request", version: SCHEMA_VERSION, path: "schemas/invocation-request.schema.json" },
  { name: "invocation-event", version: SCHEMA_VERSION, path: "schemas/invocation-event.schema.json" },
  { name: "invocation-outcome", version: SCHEMA_VERSION, path: "schemas/invocation-outcome.schema.json" },
  { name: "operations", version: SCHEMA_VERSION, path: "schemas/operations.schema.json" },
] as const;

export const OPERATION_DEFINITIONS: readonly OperationDefinition[] = [
  {
    name: "system.describe",
    summary: "Describe protocol versions, operations, routes, and broker settings.",
    availability: "implemented",
    cli: ["describe --json"],
    input: { type: "object", additionalProperties: false },
    output: { type: "object", required: ["schemaVersion", "operationsVersion", "operations"] },
  },
  {
    name: "system.shutdown",
    summary: "Gracefully stop the user-owned local broker.",
    availability: "implemented",
    cli: ["broker stop --json"],
    input: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } },
    output: { type: "object", required: ["accepted", "force", "activeInvocations"] },
  },
  {
    name: "system.status",
    summary: "Report broker readiness, process identity, and invocation counts.",
    availability: "implemented",
    cli: ["broker status --json"],
    input: { type: "object", additionalProperties: false },
    output: { type: "object", required: ["ready", "pid", "socketPath"] },
  },
  {
    name: "route.discover",
    summary: "List adapter-qualified routes and their readiness evidence.",
    availability: "implemented",
    cli: ["routes --json"],
    input: { type: "object", additionalProperties: false, properties: { refresh: { type: "boolean" } } },
    output: { type: "object", required: ["routes"] },
  },
  {
    name: "invocation.start",
    summary: "Resolve and asynchronously start one bounded invocation.",
    availability: "implemented",
    cli: ["start --provider <id> --model <id> --text <text> --json"],
    input: {
      type: "object",
      required: ["selector", "input", "workingDirectory"],
      properties: {
        selector: { type: "object" },
        input: { type: "array", minItems: 1 },
        workingDirectory: { type: "string" },
        interactionStrategy: { enum: ["orchestrator", "deny", "unattended"] },
        requestedPolicy: { type: "object" },
        timeoutMs: { type: "integer", minimum: 1 },
        callerCorrelationId: { type: "string" },
        idempotencyKey: { type: "string" },
      },
    },
    output: { type: "object", required: ["invocationId", "state", "deduplicated", "next"] },
  },
  {
    name: "invocation.inspect",
    summary: "Inspect current state and the immutable outcome when terminal.",
    availability: "implemented",
    cli: ["inspect <invocation-id> --json"],
    input: { type: "object", required: ["invocationId"] },
    output: { type: "object", required: ["invocationId", "state", "eventCount"] },
  },
  {
    name: "invocation.get",
    summary: "Alias for inspecting one invocation by stable ID.",
    availability: "implemented",
    cli: ["get <invocation-id> --json"],
    input: { type: "object", required: ["invocationId"] },
    output: { type: "object", required: ["invocationId", "state", "eventCount"] },
  },
  {
    name: "invocation.result",
    summary: "Return the immutable terminal result for one invocation.",
    availability: "implemented",
    cli: ["result <invocation-id> --json"],
    input: { type: "object", required: ["invocationId"] },
    output: { type: "object", required: ["invocationId", "state", "outcome"] },
  },
  {
    name: "invocation.wait",
    summary: "Wait for terminal state with a bounded long poll.",
    availability: "implemented",
    cli: ["wait <invocation-id> [--timeout-ms <milliseconds>] --json"],
    input: { type: "object", required: ["invocationId"], properties: { timeoutMs: { maximum: 30000 } } },
    output: { type: "object", required: ["invocationId", "state", "waited"] },
  },
  {
    name: "invocation.events",
    summary: "Read ordered events after an opaque cursor, optionally with bounded long polling.",
    availability: "implemented",
    cli: ["events <invocation-id> [--after <cursor>] [--follow] --json"],
    input: { type: "object", required: ["invocationId"], properties: { waitMs: { maximum: 30000 } } },
    output: { type: "object", required: ["invocationId", "state", "events", "terminal"] },
  },
  {
    name: "invocation.cancel",
    summary: "Request cancellation of an active invocation.",
    availability: "implemented",
    cli: ["cancel <invocation-id> --json"],
    input: { type: "object", required: ["invocationId"] },
    output: { type: "object", required: ["invocationId", "state", "accepted"] },
  },
  {
    name: "invocation.respond",
    summary: "Answer a pending Claude permission request in orchestrator mode.",
    availability: "implemented",
    cli: ["request invocation.respond --params <json> --json"],
    input: { type: "object", required: ["invocationId", "requestId", "decision"], properties: { decision: { enum: ["allow", "deny"] } } },
    output: { type: "object", required: ["invocationId", "requestId", "accepted"] },
  },
  {
    name: "invocation.send",
    summary: "Steer an active invocation through a qualified native capability.",
    availability: "planned",
    cli: [],
    input: { type: "object" },
    output: { type: "object" },
  },
  {
    name: "invocation.continue",
    summary: "Create a linked invocation using a qualified native continuation.",
    availability: "planned",
    cli: [],
    input: { type: "object" },
    output: { type: "object" },
  },
  {
    name: "invocation.delete",
    summary: "Delete one completed invocation and create a retention tombstone.",
    availability: "planned",
    cli: [],
    input: { type: "object" },
    output: { type: "object" },
  },
] as const;

export function describeContract(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: SCHEMA_VERSION,
    operationsVersion: OPERATIONS_VERSION,
    schemas: SCHEMA_DEFINITIONS,
    operations: OPERATION_DEFINITIONS,
  };
}
