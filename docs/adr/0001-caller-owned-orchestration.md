# ADR-0001: Keep workflow orchestration caller-owned

- **Status:** Accepted
- **Date:** 2026-08-24
- **Amended:** 2026-09-05

## Context

The initial RFC describes both a caller-owned delegated operation and a
standalone bridge-owned team workflow. Combining both models makes ownership of
the task graph, aggregation, cancellation, quorum, and final verdict ambiguous.

The intended public tool should offer specific bridge functions while the
invoking human, CI job, IDE, or agent host controls the surrounding workflow.

## Decision

The caller is the sole root for the initial architecture. The bridge executes
one bounded task at a time and returns a structured result. The caller controls
task ordering, parallelism, synthesis, and the final verdict.

The initial bridge contract does not expose bridge-owned multi-review
orchestration or an approval verdict. A future bridge-owned workflow would be a
separate capability with its own lifecycle and ownership contract.

## Consequences

- `Run` means one supervised execution attempt, not a task graph.
- `Task` and `Run` need distinct identities; retries create new attempts or
  runs without changing workflow ownership.
- MCP and CLI are peer transports over the same bounded operations.
- Review aggregation is caller-owned in the initial version.
- `aggregate_reviews` and bridge-generated `approve` or `request changes`
  verdicts are outside the initial contract.
- Cancellation of a run does not imply cancellation of the caller's workflow.

## Open follow-up decisions

- Exact task, run, and attempt state machines.
- Whether a future standalone workflow mode is desirable at all.

## Amendments

- 2026-09-05: Status raised from Proposed to Accepted. `CONTEXT.md` already
  lists the caller-only root as a resolved invariant and ADR-0002 depends on
  this decision. The question whether a normalization helper belongs in the
  bridge is answered by ADR-0002: outcome normalization is core, review
  aggregation is not.
