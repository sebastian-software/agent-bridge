import { SCHEMA_VERSION } from "./contract.js";

export type OperationAvailability = "implemented" | "planned";

export type OperationDefinition = {
  readonly name: string;
  readonly summary: string;
  readonly availability: OperationAvailability;
  readonly cli: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
};

export const OPERATIONS_VERSION = "1.0" as const;

export type SchemaDefinition = {
  readonly name: string;
  readonly version: typeof SCHEMA_VERSION;
  readonly path: string;
};

export const SCHEMA_DEFINITIONS: readonly SchemaDefinition[] = [
  {
    name: "invocation-request",
    version: SCHEMA_VERSION,
    path: "schemas/invocation-request.schema.json",
  },
  {
    name: "invocation-event",
    version: SCHEMA_VERSION,
    path: "schemas/invocation-event.schema.json",
  },
  {
    name: "invocation-outcome",
    version: SCHEMA_VERSION,
    path: "schemas/invocation-outcome.schema.json",
  },
  { name: "operations", version: SCHEMA_VERSION, path: "schemas/operations.schema.json" },
  {
    name: "connection-store",
    version: SCHEMA_VERSION,
    path: "schemas/connection-store.schema.json",
  },
] as const;

export const OPERATION_DEFINITIONS: readonly OperationDefinition[] = [
  {
    name: "system.describe",
    summary: "Describe protocol versions, operations, and broker settings.",
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
    input: {
      type: "object",
      additionalProperties: false,
      properties: { force: { type: "boolean" } },
    },
    output: { type: "object", required: ["accepted", "force", "activeInvocations"] },
  },
  {
    name: "system.status",
    summary: "Report broker readiness, process identity, and invocation counts.",
    availability: "implemented",
    cli: ["broker status --json"],
    input: { type: "object", additionalProperties: false },
    output: {
      type: "object",
      required: ["ready", "pid", "socketPath", "environmentVariableNames"],
    },
  },
  {
    name: "route.discover",
    summary: "List adapter-qualified routes and readiness, optionally for one named connection.",
    availability: "implemented",
    cli: ["routes [--connection <id>] --json"],
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        refresh: { type: "boolean" },
        connectionId: { type: "string", minLength: 1 },
      },
    },
    output: { type: "object", required: ["routes"] },
  },
  {
    name: "connection.discover",
    summary: "Refresh default and named routes with redacted registered-connection summaries.",
    availability: "implemented",
    cli: ["connections discover [--refresh] --json"],
    input: {
      type: "object",
      additionalProperties: false,
      properties: { refresh: { type: "boolean" } },
    },
    output: { type: "object", required: ["connections", "routes", "nextSteps"] },
  },
  {
    name: "connection.list",
    summary: "List registered native contexts without exposing their private references.",
    availability: "implemented",
    cli: ["connections list --json"],
    input: { type: "object", additionalProperties: false },
    output: { type: "object", required: ["connections"] },
  },
  {
    name: "connection.inspect",
    summary: "Refresh readiness evidence for one registered native context.",
    availability: "implemented",
    cli: ["connections inspect <id> --json"],
    input: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 } },
    },
    output: {
      type: "object",
      required: ["connection", "readiness", "userActionRequired", "routes", "nextSteps"],
    },
  },
  {
    name: "connection.register",
    summary:
      "Register an existing native context without copying credentials or changing defaults.",
    availability: "implemented",
    cli: [
      "connections register --id <id> --harness <id> --native-context <path> [--purpose <text>]",
    ],
    input: {
      type: "object",
      required: ["id", "harness", "nativeContextRef"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        harness: { type: "string", minLength: 1 },
        nativeContextRef: { type: "string", minLength: 1 },
        purpose: { type: "string", minLength: 1 },
      },
    },
    output: {
      type: "object",
      required: ["connection", "readiness", "userActionRequired", "routes", "nextSteps"],
    },
  },
  {
    name: "connection.prepare",
    summary:
      "Create a private native context and return structured instructions for user-owned login.",
    availability: "implemented",
    cli: ["connections prepare --id <id> --harness <id> [--purpose <text>]"],
    input: {
      type: "object",
      required: ["id", "harness"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        harness: { type: "string", minLength: 1 },
        purpose: { type: "string", minLength: 1 },
      },
    },
    output: {
      type: "object",
      required: ["connection", "readiness", "userActionRequired", "routes", "nextSteps", "setup"],
    },
  },
  {
    name: "connection.update",
    summary: "Update a registered context with optimistic revision checks.",
    availability: "implemented",
    cli: [
      "connections update <id> --revision <revision> [--native-context <path>] [--purpose <text>|--clear-purpose]",
    ],
    input: {
      type: "object",
      required: ["id", "expectedRevision"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        expectedRevision: { type: "string", minLength: 1 },
        nativeContextRef: { type: "string", minLength: 1 },
        purpose: { type: "string", minLength: 1 },
        clearPurpose: { type: "boolean" },
      },
    },
    output: {
      type: "object",
      required: ["connection", "readiness", "userActionRequired", "routes", "nextSteps"],
    },
  },
  {
    name: "connection.remove",
    summary: "Remove only a registration; preserve the native context and its credentials.",
    availability: "implemented",
    cli: ["connections remove <id> --revision <revision>"],
    input: {
      type: "object",
      required: ["id", "expectedRevision"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        expectedRevision: { type: "string", minLength: 1 },
      },
    },
    output: { type: "object", required: ["removed", "connection"] },
  },
  {
    name: "invocation.start",
    summary:
      "Resolve and asynchronously start one bounded invocation in an optional named connection.",
    availability: "implemented",
    cli: ["start --provider <id> --model <id> [--connection <id>] --text <text> --json"],
    input: {
      type: "object",
      required: ["selector", "input", "workingDirectory"],
      properties: {
        selector: {
          type: "object",
          required: ["provider", "model"],
          properties: {
            provider: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            effort: { type: "string", minLength: 1 },
            via: { type: "string", minLength: 1 },
            connectionId: { type: "string", minLength: 1 },
            requiredCapabilities: { type: "array", items: { type: "string", minLength: 1 } },
            minimumObservedEvidence: {
              enum: ["unverified", "inferred", "reported", "verified"],
            },
          },
          additionalProperties: false,
        },
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
    name: "invocation.list",
    summary: "List retained invocation summaries with optional correlation and state filters.",
    availability: "implemented",
    cli: ["list [--active] [--correlation <id>] [--json]"],
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        active: { type: "boolean" },
        state: {
          enum: [
            "queued",
            "running",
            "waiting_for_input",
            "cancelling",
            "cancelled",
            "failed",
            "interrupted",
            "succeeded",
            "timed_out",
          ],
        },
        callerCorrelationId: { type: "string", minLength: 1 },
        since: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        includeTombstones: { type: "boolean" },
      },
    },
    output: { type: "object", required: ["invocations", "tombstones"] },
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
    input: {
      type: "object",
      required: ["invocationId"],
      properties: { timeoutMs: { maximum: 30_000 } },
    },
    output: { type: "object", required: ["invocationId", "state", "waited"] },
  },
  {
    name: "invocation.events",
    summary: "Read ordered events after an opaque cursor, optionally with bounded long polling.",
    availability: "implemented",
    cli: ["events <invocation-id> [--after <cursor>] [--follow] --json"],
    input: {
      type: "object",
      required: ["invocationId"],
      properties: { waitMs: { maximum: 30_000 } },
    },
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
    summary: "Allow or deny a pending permission request in orchestrator mode.",
    availability: "implemented",
    cli: ["request invocation.respond --params <json> --json"],
    input: {
      type: "object",
      required: ["invocationId", "requestId", "decision"],
      properties: { decision: { enum: ["allow", "deny"] } },
    },
    output: { type: "object", required: ["invocationId", "requestId", "accepted"] },
  },
  {
    name: "invocation.answer",
    summary: "Answer a pending free-form delegate question.",
    availability: "implemented",
    cli: ["answer <invocation-id> --request-id <id> --text <text> [--json]"],
    input: {
      type: "object",
      required: ["invocationId", "requestId", "answer"],
      properties: {
        invocationId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 1 },
        answer: { type: "array", minItems: 1 },
      },
    },
    output: { type: "object", required: ["invocationId", "requestId", "accepted"] },
  },
  {
    name: "invocation.send",
    summary: "Steer an active invocation through a qualified native capability.",
    availability: "implemented",
    cli: ["send <invocation-id> --idempotency-key <key> --text <text> [--json]"],
    input: {
      type: "object",
      required: ["invocationId", "input", "idempotencyKey"],
      properties: {
        invocationId: { type: "string", minLength: 1 },
        input: { type: "array", minItems: 1 },
        idempotencyKey: { type: "string", minLength: 1 },
      },
    },
    output: {
      type: "object",
      required: ["invocationId", "inputId", "accepted", "deduplicated", "delivery"],
    },
  },
  {
    name: "invocation.continue",
    summary: "Create a linked invocation using a qualified native continuation.",
    availability: "implemented",
    cli: ["continue <invocation-id> --idempotency-key <key> --text <text> [--json]"],
    input: {
      type: "object",
      required: ["invocationId", "input", "idempotencyKey"],
      properties: {
        invocationId: { type: "string", minLength: 1 },
        input: { type: "array", minItems: 1 },
        idempotencyKey: { type: "string", minLength: 1 },
      },
    },
    output: { type: "object", required: ["invocationId", "state", "deduplicated", "next"] },
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
