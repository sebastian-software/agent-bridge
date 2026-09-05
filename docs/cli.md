# CLI reference

The CLI is a thin caller-owned interface over the local broker. Every command
supports `--json`; `request` also accepts JSON params from standard input when
`--params` is omitted.

| Command | Purpose |
| --- | --- |
| `describe` | Contract, operation, route, and retention metadata |
| `routes` | Qualified route discovery |
| `start` | Start one asynchronous invocation |
| `get` / `inspect` | Read invocation state and event cursor |
| `events` | Read events, or follow until terminal |
| `wait` | Wait up to 30 seconds for terminal state |
| `result` | Read the immutable terminal outcome |
| `cancel` | Request cancellation |
| `broker status` / `broker stop` | Inspect or stop the local broker |
| `request` | Send any operation with JSON params |

Stable process exit codes are: `0` success, `1` execution/internal failure,
`2` invalid request, `3` broker unavailable, `4` invocation unavailable or not
terminal, `5` route unavailable/ambiguous, and `6` invocation conflict.
