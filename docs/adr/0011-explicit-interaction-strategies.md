# ADR-0011: Make delegate interaction handling explicit

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Delegate harnesses may request permission to run a command, modify a file, use
a tool, or obtain structured user input. Broker-owned harnesses have no visible
interactive terminal. Waiting for stdin would hang the invocation, while
implicit approval would create surprising authority.

## Decision

Every invocation selects one of three interaction strategies:

- `orchestrator`: the default. Native approval and input requests become
  ordered `input_required` events. The caller answers through
  `invocation.respond`.
- `deny`: the adapter rejects every interactive request. The delegate may
  continue with reduced capability or reach a terminal failure.
- `unattended`: explicitly selected by the caller. The adapter uses a qualified
  native non-interactive mode and records the requested and effective behavior
  in events and the outcome.

The broker never displays a hidden prompt and never converts one strategy into
another silently.

## Consequences

- `invocation.respond` is distinct from free-form `invocation.send`.
- Each open request has a stable request ID, type, prompt, allowed response
  shape, and lifecycle.
- Orchestrator disconnect does not imply approval. Requests remain pending until
  their deadline, cancellation, or an explicit response.
- Adapters must publish which interaction strategies they support for their
  qualified harness version.
- `unattended` is a declared execution choice, not a claim that the bridge can
  sandbox or fully observe every delegate effect.
