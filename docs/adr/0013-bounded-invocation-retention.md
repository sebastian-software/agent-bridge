# ADR-0013: Bound local invocation retention

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

The broker persists events and outcomes so a caller can disconnect, reconnect,
or inspect a completed invocation after a broker restart. Unbounded event logs,
tool output, and native payloads would eventually consume arbitrary local disk
space, especially for long-running coding harnesses and multimodal results.

## Decision

The default local retention policy is:

- active invocation records are never evicted;
- completed invocation records are retained for seven days;
- retained completed records share a configurable one-GiB storage cap;
- when the cap is exceeded, the oldest completed records are evicted first;
- callers may remove a completed invocation explicitly with
  `invocation.delete`;
- normalized events and terminal outcomes are persisted by default; and
- complete native raw event payloads are persisted only when diagnostic mode is
  explicitly enabled.

The broker must expose its effective retention settings and report when an
invocation or requested cursor has been evicted. It must not return an empty
stream that could be mistaken for an invocation that emitted no events.

## Consequences

- Persistence remains useful without becoming an unbounded audit archive.
- Diagnostic mode has an explicit storage and potentially sensitive-data cost.
- Cursor and inspection operations need a distinct `evicted` result.
- Referenced artifacts may require their own lifetime rules; the broker must not
  imply that an external path or resource is retained merely because its
  metadata appears in an outcome.
- Future configurable policies must preserve the invariant that active records
  are not removed.
