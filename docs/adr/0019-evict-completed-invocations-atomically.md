# ADR-0019: Evict completed invocations atomically

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Cursor-based event retrieval must remain unambiguous under bounded retention.
Removing an arbitrary prefix from an invocation's event stream would make a
valid cursor appear to return no events or make a partial history look complete.
Deleting all evidence of an invocation would also make an evicted ID
indistinguishable from an ID that never existed.

## Decision

Retention removes one completed invocation as an atomic unit: metadata, events,
outcome, and bridge-owned artifacts governed by the same lifetime are evicted
together. A retained invocation always has its event stream from sequence one.

The broker keeps a lightweight bounded tombstone containing the invocation ID,
terminal status, eviction time, and eviction reason. Inspection and event
retrieval return `invocation_evicted` while the tombstone remains. They never
return an empty event page that could be confused with a retained invocation
that emitted no new events.

Tombstones contain no prompts, returned content, native events, workspace data,
or secrets. Their own duration and count limits are configurable implementation
details exposed through `system.describe`.

## Consequences

- Callers can distinguish unknown, retained, and evicted invocations.
- Cursor handling does not need partial-history semantics in the first version.
- Storage accounting and explicit deletion operate at invocation granularity.
- Once a tombstone itself expires, the ID becomes indistinguishable from an ID
  that never existed; the broker reports `invocation_not_found` honestly.
