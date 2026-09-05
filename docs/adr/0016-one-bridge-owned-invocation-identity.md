# ADR-0016: Use one bridge-owned invocation identity

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

The orchestrator owns tasks, workflows, retry policies, and result composition.
Introducing bridge-owned task and attempt entities would duplicate that model,
blur ownership, and force callers to translate between two workflow identity
hierarchies.

The bridge still needs to identify one concrete execution, deduplicate a
repeated start request, correlate executions with caller state, and link a new
continuation to its predecessor.

## Decision

`invocationId` is the only bridge-owned execution identity. It identifies
exactly one execution attempt and is never reused for a retry, restart, or
continuation.

The operations contract additionally supports:

- `callerCorrelationId`: optional opaque caller metadata for a caller-owned
  task, workflow, trace, or other grouping;
- `idempotencyKey`: optional caller-provided key for deduplicating equivalent
  `invocation.start` requests; and
- `continuedFrom`: the prior `invocationId` when a new invocation continues a
  native delegate session or thread.

The bridge does not define its own `taskId` or `attemptId` entities.

## Consequences

- Retries create new invocation IDs and remain distinguishable execution
  attempts.
- Repeating a start request with the same valid idempotency key returns the
  existing invocation instead of starting another process.
- An idempotency key must be scoped and bound to a canonical request digest;
  reuse with a materially different request fails explicitly.
- Caller correlation is searchable metadata but has no lifecycle or uniqueness
  semantics inside the bridge.
- Continuation lineage is explicit without making the bridge responsible for a
  task graph or conversation workflow.
