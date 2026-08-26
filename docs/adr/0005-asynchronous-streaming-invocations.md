# ADR-0005: Make invocations asynchronous and observable

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

A delegated harness can run for minutes, emit useful intermediate output, and
receive follow-up direction. Blocking the orchestrator until completion would
prevent it from coordinating other work and make concurrent delegation
unnecessarily difficult.

Harnesses expose streaming information in different forms, including JSONL,
SDK event streams, JSON-RPC notifications, and ACP session updates. The bridge
needs one lifecycle independent of those transports.

## Decision

Starting a delegation creates an asynchronous invocation and immediately
returns an invocation handle. The bridge supervises the delegate in the
background and records an ordered stream of normalized invocation events.

The orchestrator can inspect current state, consume events after a cursor,
cancel the invocation, and retrieve its terminal outcome. Live delivery may use
native MCP facilities when both peers support them, but the core contract must
also support explicit event retrieval so correctness does not depend on push
delivery.

A long-lived local broker owns the invocation after the start operation returns.
CLI and optional MCP transports expose the same stored state and event cursors.

The terminal outcome is immutable. Streaming events are observations and do
not transfer workflow ownership from the orchestrator to the bridge.

## Consequences

- The core needs at least start, inspect/get-events, cancel, and terminal-result
  operations even if a transport offers a combined convenience call.
- Every event carries an invocation ID and monotonic cursor or sequence.
- Reconnect and duplicate delivery are handled through cursors rather than
  assuming exactly-once streaming.
- Harness-native events may be normalized progressively while preserving raw
  provenance for diagnostics.
- Resource cleanup and timeout continue after the start call has returned.
- Stream retention, follow-up semantics, crash durability, and the exact MCP
  mapping require separate decisions.
