# ADR-0004: Resolve delegation routes ad hoc and model-first

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The orchestrator thinks in terms of a desired delegate such as "Anthropic Opus
5 with high effort," not in terms of pre-created bridge target objects. A
single model may nevertheless be reachable through more than one installed
harness, and different harnesses may expose different capabilities.

Persisted provider instances are useful for a multi-account GUI and durable
sessions, but they add unnecessary setup to a local one-shot delegation path.

## Decision

The delegation request selects provider, model, effort, and optional required
capabilities directly. The bridge discovers installed harness routes and
resolves the selector for each invocation.

The caller may optionally specify `via` to require a particular harness family.
If the selector has exactly one ready route, the bridge uses it. If there are
zero or multiple matching routes, resolution fails with diagnostics and a list
of candidates. It never silently changes the requested model, effort, or
harness.

The outcome records both the requested selector and the concrete resolved
route, including adapter, harness version, and the strongest available evidence
of the runtime model.

## Consequences

- No target-creation workflow is required before normal use.
- A discovery command or tool must expose available models, effort levels,
  capabilities, and the harness routes that provide them.
- Human-friendly aliases may exist in user configuration, but canonical model
  identifiers remain visible in requests and outcomes.
- Multiple accounts or installations can be added later as route candidates;
  ambiguity remains explicit unless the caller or user configuration resolves
  it.
- Adapter capability discovery and version qualification are part of routing,
  not orchestration.
