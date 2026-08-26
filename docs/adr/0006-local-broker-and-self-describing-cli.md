# ADR-0006: Use a local broker with a self-describing CLI

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Asynchronous invocations must continue after the command that starts them has
returned. They also need one owner for process handles, ordered events,
follow-up input, cancellation, and terminal outcomes.

MCP client support for asynchronous tasks and live output differs between host
harnesses. A CLI works anywhere the orchestrator can execute a local process,
but duplicating the CLI protocol in a separate Agent Skill would couple every
host integration to bridge implementation details.

## Decision

A long-lived local broker owns invocation state and harness processes. CLI
commands communicate with it through a local IPC transport, using Unix domain
sockets on Unix-like systems and an equivalent local transport on Windows.

The CLI is the universal integration surface and is self-describing. The bridge
exposes machine-readable operation schemas, capabilities, version information,
and response affordances. A host-specific skill is not required to know or
duplicate command syntax.

An optional MCP server projects the same broker operations into MCP tools. It
does not own a second run store, scheduler, or adapter implementation.

## Consequences

- The only unavoidable bootstrap knowledge is that the `agent-bridge`
  executable exists. The orchestrator can query the rest from the executable.
- The bridge needs a stable machine-readable discovery operation such as
  `agent-bridge describe --json`.
- Responses should expose stable identifiers and possible next operations so a
  caller does not need hidden workflow instructions.
- Human-friendly subcommands and a machine-oriented request form must share the
  same versioned schemas.
- Broker startup, single-instance locking, compatibility negotiation, local IPC
  permissions, state retention, and crash recovery become product concerns.
- MCP remains useful for automatic tool discovery but is not required for core
  execution or streaming.
