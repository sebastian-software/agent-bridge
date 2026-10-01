# Claude continuation qualification record

**Date:** 2026-10-01

**Status:** Qualified for Claude Code 2.1.282 with the default login

This record covers Relay's `continuation` capability for the Claude print
adapter. It does not cover active steering or general questions. Named Claude
connections advertise continuation through the same mechanism with their own
`CLAUDE_CONFIG_DIR`, but only the default login was exercised live.

## Configuration

| Item    | Value                                                                          |
| ------- | ------------------------------------------------------------------------------ |
| Relay   | Source build of `39e914b` (Codex continuation) plus this change                |
| Harness | Claude Code 2.1.282, default configuration directory and native login          |
| Route   | `haiku` through `claude-code`; the stream reported `claude-haiku-4-5-20251001` |
| Policy  | Interaction `deny` and `orchestrator`, default filesystem policy               |
| Machine | Apple M1 Ultra, macOS 27.0, Node.js 24.21.0                                    |
| Context | Isolated Relay config, state, and runtime directories                          |

Discovery reported the route as `ready` with `continuation` in its capabilities.

## Native evidence

Before the adapter change, `claude -p --resume <session-id> --fork-session` was
run twice by hand against one print-mode session. Both forks recalled a
codeword from the original turn, each reported a new session ID, and the SHA-1
digest of the original session file did not change.

## Relay evidence

With interaction `deny`:

1. A first invocation asked Claude to remember a codeword (4.3 s).
2. Two continuations of it answered `KESTREL-deny B1` and `KESTREL-deny B2`,
   each in a new native session (3.6 s and 3.5 s).
3. A continuation of the first branch reported marker `B1` and the codeword. It
   saw its own branch and not the second one.
4. The SHA-1 digest of the original session file was identical before the first
   continuation and after the last one.

With interaction `orchestrator`, where the prompt is sent as stream-json input,
a continuation answered `KESTREL-orchestrator B1` in a new session, and the
original session file was unchanged.

## Deterministic coverage

`test/claude-continuation.test.ts` uses a Claude Code stand-in that logs its
argv. It covers version gating of the capability, independent and nested forks
through the broker, `--resume <id> --fork-session` on every continuation, the
unsupported-capability error for older versions, and rejection of handles that
are not native session IDs.
