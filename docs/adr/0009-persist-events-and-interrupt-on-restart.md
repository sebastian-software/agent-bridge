# ADR-0009: Persist invocation history and interrupt active runs on restart

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Asynchronous delegation requires invocations to outlive the CLI process that
started them. Callers must also be able to reconnect and read ordered events or
terminal outcomes. Reattaching safely to arbitrary child-process trees after a
broker crash is substantially harder and cannot be inferred merely from a
persisted process ID.

## Decision

Invocation metadata, ordered events, effect observations, and terminal outcomes
are persisted from the first release. A broker restart reconciles every
non-terminal persisted invocation to the terminal state `interrupted` unless a
future adapter-specific recovery capability can prove that it safely resumed or
reattached.

The first release does not promise that an active harness process survives a
broker crash, upgrade, or host reboot. Startup performs bounded orphan cleanup
where ownership can be established safely.

## Consequences

- Event cursors remain useful across CLI disconnects and broker restarts.
- Terminal outcomes are immutable and readable until retention removes them.
- `interrupted` is distinct from `cancelled`, `failed`, and `timed_out`.
- Persisted PIDs alone are never trusted as proof of process identity after a
  restart.
- Store format, migrations, retention, orphan ownership markers, and startup
  reconciliation need tests before the Developer Preview.
