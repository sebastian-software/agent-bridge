# Codex continuation qualification record

**Date:** 2026-10-01

**Status:** Qualified for Codex CLI 0.159.2 with the default login

This record covers Relay's `continuation` capability for the Codex exec
adapter. It does not cover active steering, general questions, or named Codex
connections, which still require Codex CLI 0.155.1 and therefore do not
advertise continuation.

## Configuration

| Item    | Value                                                                 |
| ------- | --------------------------------------------------------------------- |
| Relay   | Source build of `main` at `ee5f2b8` plus this change, Node.js 24.21.0 |
| Harness | Codex CLI 0.159.2, default `CODEX_HOME` and native login              |
| Route   | `gpt-5.5` through `codex`, effort `low`                               |
| Policy  | Interaction `deny`, filesystem `read-only`                            |
| Machine | Apple M1 Ultra, macOS 27.0                                            |
| Context | Isolated Relay config, state, and runtime directories                 |

Discovery reported the route as `ready` with `continuation` in its capabilities.

## Native evidence

Before the adapter change, `codex exec fork <thread-id>` was run twice by hand
against one non-ephemeral `codex exec` session. Both forks recalled a codeword
from the original turn, each received a new thread ID, and the original session
file kept the same line count and SHA-1 digest.

## Relay evidence

1. A first invocation asked Codex to remember a codeword and reported native
   thread `01a0f734-4fa6-…` (6.6 s).
2. Two continuations of that invocation, each with its own idempotency key,
   answered `HERON-77 B1` and `HERON-77 B2`. Each ran in a new native thread
   (5.7 s and 5.9 s).
3. A continuation of the first branch answered `B1, HERON-77`. It saw its own
   branch and not the second one, and recorded `continuedFrom` for the first
   branch (8.6 s).
4. The SHA-1 digest of the original session file was identical before the
   first continuation and after the last one.

Reported input tokens grew from 20519 to 48263 for each branch and to 76046 for
the nested continuation, consistent with retained context. Codex's JSONL output
does not report the runtime model, so model identity remains `unverified`.

## Deterministic coverage

`test/codex-continuation.test.ts` uses a Codex stand-in that logs its argv. It
covers version gating of the capability, independent and nested forks through
the broker, the `exec fork` argument shape without `--sandbox`, `--cd`,
`--add-dir`, or `--ephemeral`, ephemeral runs for unqualified versions and for
additional directories, and rejection of handles that are not native thread IDs.
