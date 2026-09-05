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

- Claude Code through its installed CLI's headless JSONL contract;
- Codex through its installed CLI's headless JSONL contract.

Both use the same selector, route, invocation, event, outcome, and effect
contracts. A deterministic fake harness remains the primary automated test
fixture.

The bridge does not encode Claude or Codex as the root. Either harness can call
the self-describing CLI and orchestrate invocations through the broker.

## Consequences

- The MVP proves Codex to Claude and Claude to Codex delegation.
- Adapter differences remain capability-gated; feature parity is not required
  when a native harness cannot support a capability.
- The delivery plan budgets separately for Claude and Codex JSONL event
  normalization and version qualification.
- Open-weight, OCR, vision, and other capability adapters follow the same SPI
  after the two initial adapters establish it.
