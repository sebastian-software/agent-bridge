# ADR-0008: Support Claude Code and Codex in the first MVP

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

The motivating use case is not tied to one permanent orchestrator. Codex should
be able to delegate to an Anthropic model, and a Claude or Opus-led workflow
should likewise be able to delegate to Codex. Implementing only one delegate
adapter would prove process invocation but not the host-neutral product claim.

## Decision

The first MVP contains two real delegate adapters:

- Claude Code through the official Claude Agent SDK and the user's installed
  Claude Code executable;
- Codex through its installed app-server and version-matched generated schema.

Both use the same selector, route, invocation, event, outcome, and effect
contracts. A deterministic fake harness remains the primary automated test
fixture.

The bridge does not encode Claude or Codex as the root. Either harness can call
the self-describing CLI and orchestrate invocations through the broker.

## Consequences

- The MVP proves Codex to Claude and Claude to Codex delegation.
- Adapter differences remain capability-gated; feature parity is not required
  when a native harness cannot support a capability.
- The delivery plan must budget separately for Claude SDK event normalization
  and Codex app-server protocol/version qualification.
- Open-weight, OCR, vision, and other capability adapters follow the same SPI
  after the two initial adapters establish it.
