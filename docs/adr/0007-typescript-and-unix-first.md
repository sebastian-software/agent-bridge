# ADR-0007: Implement the first release in TypeScript for macOS and Linux

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

The first release needs asynchronous streaming, live follow-up input, local IPC,
process supervision, JSON contracts, and native integrations with Claude Code
and Codex. Anthropic's official Agent SDK supports TypeScript and exposes a
streaming input model suitable for a long-lived delegate. Codex exposes an
official TypeScript SDK and a schema-generating app-server protocol.

Rust would provide stronger low-level process control and single-binary
distribution, but it lacks equally direct supported SDK integrations for the
first two harnesses. Windows also requires a separate process-tree strategy
based on Job Objects rather than Unix process groups.

## Decision

The initial implementation uses TypeScript on a supported Node.js LTS release.
The Developer Preview supports macOS and Linux. Windows support is added only
after the end-to-end architecture has been proven and can be qualified with a
native process-tree and IPC implementation.

The operations and adapter boundaries remain versioned JSON contracts. This
keeps open a later Rust supervisor or other language-specific worker without
changing the caller-facing protocol.

## Consequences

- The Claude adapter can use the official Agent SDK directly.
- The Codex adapter can consume generated TypeScript or JSON schemas from the
  installed app-server version.
- Distribution initially requires Node.js rather than promising a standalone
  native executable.
- Unix sockets and Unix process-group behavior are part of the first
  qualification matrix.
- Windows Named Pipes, Job Objects, packaging, and tests form a later platform
  slice rather than partially supported behavior.
