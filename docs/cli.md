# CLI reference

The CLI is a caller-owned interface over the local broker. Add `--json` for
stable machine-readable output; human mode is intended for terminals. Any
command that needs a broker starts the user-owned daemon automatically.

## Commands

| Command                              | Purpose                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `describe`                           | Contract, operation, broker, and retention metadata       |
| `routes [--refresh]`                 | Qualified route discovery                                 |
| `start`                              | Start one asynchronous invocation and print its ID        |
| `run`                                | Start, follow, and return one invocation result           |
| `list`                               | List retained invocation summaries                        |
| `get` / `inspect <id>`               | Read invocation state and event cursor                    |
| `events <id>`                        | Read events once, or follow until terminal                |
| `wait <id>`                          | Poll once for up to 30 seconds, or use `--until-terminal` |
| `result <id>`                        | Read the immutable terminal outcome                       |
| `cancel <id>`                        | Request cancellation                                      |
| `broker status` / `stop` / `restart` | Inspect or control the broker                             |
| `broker logs`                        | Read or follow the broker log                             |
| `request <operation>`                | Send any operation with JSON params                       |
| `mcp serve`                          | Serve the MCP projection over stdio                       |

## Starting an invocation

The provider and model are required. Prompt input can be supplied in one of
these ways: a positional argument (especially for `run`), `--text <text>`,
`--prompt-file <path>`, `--prompt-file -` for stdin, or `--input-json <path|->`
for a complete content-part array. `--cwd` defaults to the current directory.

```sh
agent-bridge start --provider agent-bridge --model fake-echo --via fake \
  --cwd "$PWD" --text "hello" --json
agent-bridge run --provider anthropic --model opus --interaction deny \
  "Summarize this workspace"
```

Other start options are `--effort`, `--via`, repeatable `--capability`,
`--timeout-ms`, `--interaction`, `--minimum-assurance`,
`--filesystem`, `--commands`, `--network`, repeatable `--add-dir`,
`--evidence`, `--idempotency-key`, and `--correlation-id`.

`run` writes progress to stderr in human mode, or one event per stdout line in
JSON mode, followed by the complete outcome. It exits zero only for
`succeeded`; SIGINT requests cancellation before returning. The equivalent
programmatic convenience is `createClient().run(request)`.

## Reading progress

```sh
agent-bridge events <invocation-id> --follow
agent-bridge wait <invocation-id> --until-terminal --json
agent-bridge result <invocation-id> --fail-on-error
```

`events` prints one concise category/summary line in human mode. JSON mode
preserves the event envelope and cursors. `wait` keeps each IPC long poll
bounded to 30 seconds even when `--until-terminal` is used. `result` prints
text content in human mode and the full outcome with `--json`.

## Listing

```sh
agent-bridge list
agent-bridge list --active --correlation build-42 --json
```

The list operation can also filter by `state`, `since`, and `limit` through the
generic `request` command. `--active` is applied by the broker and returns only
non-terminal invocations. Tombstones are included only when explicitly
requested as `includeTombstones: true`.

## Broker and diagnostics

`broker status` never autostarts a daemon. `broker stop` refuses to interrupt
active work unless `--force` is supplied. `broker logs --follow` follows the
bounded rotating log. `--json` is available on broker operations and
`describe`; `--version` and `version` print the package version.

The broker environment is fixed when the daemon starts. Use `broker restart`
after changing shell exports such as `PATH`, proxy settings, or harness
configuration. `broker status --json` reports only the environment variable
names, never their values.

Stable process exit codes are: `0` success, `1` execution/internal failure,
`2` invalid request, `3` broker unavailable, `4` invocation unavailable or not
terminal, `5` route unavailable/ambiguous, and `6` invocation conflict.
