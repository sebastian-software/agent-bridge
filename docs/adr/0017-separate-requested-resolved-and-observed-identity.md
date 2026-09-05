# ADR-0017: Separate requested, resolved, and observed identity

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

A caller selects a provider, model, effort, and optionally a harness. The
bridge translates that selector into adapter configuration, but a native
harness may resolve aliases, apply its own defaults, or omit the actual runtime
identity from its event stream.

Treating the caller's request or the bridge's command-line arguments as proof
of what actually ran would create false provenance. Conversely, refusing to
run whenever a harness cannot attest every value would make otherwise useful
delegation impossible.

## Decision

Every invocation records three separate identity views:

1. `requested`: the caller's original provider, model, effort, optional `via`,
   and required capabilities;
2. `resolved`: the selected adapter, executable path, qualified harness
   version, authentication mode, and concrete model and effort configuration
   supplied to the harness; and
3. `observed`: runtime identity evidence emitted by the harness or measured by
   the adapter, including native model identity, harness build, session/thread
   ID, and relevant authenticated context.

Each observed field carries an evidence status. The initial statuses are:

- `verified`: directly reported through a qualified native protocol or checked
  against an authoritative runtime response;
- `reported`: supplied by the harness but not independently verified;
- `inferred`: derived from bounded runtime evidence and labelled as such; and
- `unverified`: unavailable or insufficiently evidenced.

The bridge never copies requested or resolved values into `observed` as if they
were runtime evidence.

If an adapter cannot faithfully configure a requested model, effort, harness,
or required capability, route resolution fails before execution. There is no
silent approximation or fallback.

## Consequences

- Outcomes can be honest even when a harness exposes incomplete provenance.
- Callers may require a minimum evidence status as a routing constraint.
- Aliases such as `opus` remain visible in requested/resolved identity until a
  native event provides stronger concrete model evidence.
- Adapter qualification must document which identity fields and evidence
  statuses are available for each supported harness version.
- Authentication metadata must identify the mode or context without persisting
  secrets, tokens, or unnecessary personal account data.
