# ADR-0015: Use native harness integrations for the MVP

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

The TanStack AI compatibility spike proved that its Claude Code and Codex
harness adapters can use host authentication, stream normalized tool activity,
modify an in-place workspace, and continue native sessions.

The same spike found gaps that overlap with core agent-bridge requirements:

- no active-turn steering;
- no same-run orchestrator-mediated approval or input response;
- no terminal event after cancellation;
- persistent framework markers and adapter-internal file-event noise in the
  delegated workspace; and
- a Codex cancellation that left the delegated command running as an orphaned
  process.

The tested packages also expose only text modality for these harnesses and do
not represent Claude effort independently from the selected model.

## Decision

The MVP integrates each initial harness through its richest supported native
interface:

- Claude Code through the official Claude Agent SDK; and
- Codex through Codex app-server.

TanStack AI is not a required MVP runtime dependency and does not define the
bridge's public operations, event, content, persistence, or lifecycle contract.

Its event translators, session-provenance approach, journaling patterns,
detach-versus-cancel distinction, and harness/execution-location separation are
valid design references. A TanStack-backed adapter may be added later as an
optional implementation if its capabilities and process semantics satisfy the
same bridge adapter qualification suite.

## Consequences

- The bridge retains control over live input, approvals, process supervision,
  runtime identity, terminal outcomes, and workspace-effect filtering.
- Claude and Codex adapters have different native protocols behind one
  normalized bridge contract.
- The MVP accepts more adapter implementation work in exchange for access to
  capabilities hidden by TanStack's current `chat()` harness abstraction.
- AG-UI compatibility may be exposed as an extension or projection later but
  is not normative.
- Any future TanStack adapter must pass the same cancellation, continuation,
  interaction, effect, and provenance tests as a native adapter.

## Evidence

See the measured spike report in
[`spikes/tanstack-ai/RESULTS.md`](../../spikes/tanstack-ai/RESULTS.md).
