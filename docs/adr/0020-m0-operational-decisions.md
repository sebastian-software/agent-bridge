# ADR-0020: Close the remaining M0 operational decisions

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The first implementation slice needs deterministic operational rules before
real harness adapters are added. The planning issues for cancellation,
environment handling, effort normalization, effect observation, and route
readiness each identified a failure mode where an adapter could otherwise
silently weaken a caller's request or report incomplete evidence as fact.

## Decision

### Cancellation and timeout (#21)

The broker sends `SIGINT` to the owned Unix process group first, waits two
seconds for a graceful flush, and then sends `SIGKILL` to the same group. The
adapter contract exposes process-group ownership so descendants are included.
Windows Job Objects are a later platform qualification. A caller cancellation
produces `cancelled`; a deadline produces `timed_out`; both retain any content
and effects observed before termination and synthesize a terminal lifecycle
event when the harness has not emitted one.

### Environment policy (#22)

Harness processes inherit the caller environment because native login, proxy,
configuration, and PATH are part of an installed harness. The bridge removes
bridge-internal variables and adapter-declared dangerous variables, then
applies request overrides only through an adapter-owned namespaced extension.
Only variable names and policy diagnostics may be recorded; values are never
placed in events, outcomes, or logs.

### Effort normalization (#17)

The portable ordinal is `low`, `medium`, `high`, and `max`. Each adapter owns a
qualified mapping table for its harness and model. An explicitly requested
level that the resolved route cannot honor fails route resolution with
`route_unavailable`; the bridge never silently substitutes another level. An
omitted level remains omitted in the requested and resolved identity.

### Effect observation and workspace concurrency (#19)

For Git workspaces the bridge snapshots tracked and untracked, non-ignored
paths using Git's NUL-delimited status output, with path metadata sufficient to
report created, deleted, modified, and conservatively detected renamed paths.
Ignored paths and files outside the working directory are out of scope. The
first release marks the observation incomplete when Git or filesystem reads
fail or a bounded snapshot limit is reached; it does not claim attribution or
rollback. A second in-place invocation in the same canonical directory is
rejected while the first is active. Non-Git fallback and configurable limits
are a later milestone.

### Route readiness (#24)

Discovery reports executable installation, resolved absolute path, qualified
version, and authentication status where a no-cost harness probe exists.
Models, effort levels, capabilities, and interaction strategies come from the
version-qualified adapter manifest, not an assumed model-list command.
`ready` means that the route passed those checks but remains provisional until
one invocation succeeds. Resolution requires exactly one matching route and
returns candidate diagnostics on ambiguity or absence; `via` is an explicit
disambiguator.

## Consequences

- Adapter implementations have a stable failure and evidence vocabulary.
- Native harness limitations remain visible instead of being silently degraded.
- Unix process groups, Git workspaces, and the caller environment are explicit
  qualification boundaries for the Developer Preview.
- Windows transport/process supervision and non-Git effect fallback remain
  separate milestones.
