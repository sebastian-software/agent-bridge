# ADR-0014: Spike TanStack AI before committing to adapter internals

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

TanStack AI RC includes dedicated Claude Code and Codex harness adapters, host
authentication, normalized streaming events, native session continuation, run
journaling, and workspace-effect events. These capabilities overlap heavily
with the proposed agent-bridge adapter layer.

TanStack AI does not expose agent-bridge's local broker, self-describing
operations contract, model-first routing, active-turn steering, or
orchestrator-mediated interaction semantics. Its harness packages are also
still versioned independently below 1.0.

## Decision

Before choosing direct SDK/app-server adapters or TanStack AI as a production
dependency, implement a bounded compatibility spike for both Claude Code and
Codex. The spike uses host login and an in-place disposable workspace, and
compares:

- stream and native-event fidelity;
- session/thread continuation;
- cancellation and process cleanup;
- workspace-effect reporting; and
- explicit behavior for steering and approval requests.

The public agent-bridge operations contract remains independent of TanStack AI.
Passing the spike may justify using its harness adapters internally or exposing
an optional TanStack-backed adapter. It does not make AG-UI, `chat()`, or the
TanStack persistence model the bridge's normative external contract.

## Consequences

- The MVP plan gains a short evidence-gathering step before adapter
  implementation.
- Direct Claude SDK and Codex app-server integration remains the fallback and
  the likely path for capabilities the spike cannot provide.
- Tested dependency and harness versions, commands, raw samples, and observed
  limitations must be recorded so the decision can be revisited as the RC
  evolves.

## Result

The 2026-08-27 run is documented in
[`spikes/tanstack-ai/RESULTS.md`](../../spikes/tanstack-ai/RESULTS.md). It proved
basic execution and continuation for both harnesses, while finding blocking
gaps in active steering, approvals, workspace transparency, and Codex process
teardown. The resulting production-dependency recommendation remains subject
to a separate decision.
