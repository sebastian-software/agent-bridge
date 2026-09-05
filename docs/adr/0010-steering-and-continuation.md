# ADR-0010: Separate active steering from terminal continuation

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

An orchestrator may refine a delegate's work while it is still running or ask a
follow-up after seeing its terminal result. Treating both cases as the same
operation would either mutate an immutable outcome or hide whether the native
harness preserved conversation context.

Claude supports streaming input to an active query and resumable sessions.
Codex app-server exposes turn steering and resumable threads. Other adapters
may support only one or neither capability.

## Decision

`invocation.send` delivers additional input to an active invocation through the
adapter's native steering or queued-input capability. Acceptance is recorded as
an invocation event; it does not create a second invocation.

After an invocation reaches a terminal state, its outcome is immutable.
`invocation.continue` creates a new invocation with a new identity, links it to
the predecessor through `continuedFrom`, and reuses the native delegate session
or thread when the resolved route proves continuation support.

Adapters report unsupported steering or continuation explicitly. The bridge
does not emulate either by silently starting a context-free request.

## Consequences

- Active steering and post-completion continuation have separate operations and
  capability flags.
- Each invocation has at most one immutable terminal outcome.
- Continuation forms a caller-visible chain without turning the bridge into a
  workflow orchestrator.
- Continuation handles are opaque, route-bound, non-secret references and may
  expire according to retention or native harness policy.
- Idempotency is required for both send and continue requests.
