# CLI reference

The CLI is a caller-owned interface over the local broker. Add `--json` for
stable machine-readable output; human mode is intended for terminals. Any
command that needs a broker starts the user-owned daemon automatically.

## Commands

| Command                                  | Purpose                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `describe`                               | Contract, operation, broker, and retention metadata                                        |
| `routes [--connection <id>] [--refresh]` | Qualified route discovery across default and named connections; optional connection filter |
| `connections discover`                   | Refresh default/named routes and list redacted registrations                               |
| `connections list`                       | List connection IDs, harnesses, purpose labels, and revisions                              |
| `connections inspect <id>`               | Refresh readiness evidence for one registration                                            |
| `connections register`                   | Register an existing native context                                                        |
| `connections prepare`                    | Create a private native context and return structured user-login instructions              |
| `connections update <id>`                | Update a registration with an expected revision                                            |
| `connections remove <id>`                | Remove a registration without deleting native files                                        |
| `start`                                  | Start one asynchronous invocation and print its ID                                         |
| `run`                                    | Start, follow, and return one invocation result                                            |
| `list`                                   | List retained invocation summaries                                                         |
| `get` / `inspect <id>`                   | Read invocation state and event cursor                                                     |
| `events <id>`                            | Read events once, or follow until terminal                                                 |
| `wait <id>`                              | Poll once for up to 30 seconds, or use `--until-terminal`                                  |
| `result <id>`                            | Read the immutable terminal outcome                                                        |
| `cancel <id>`                            | Request cancellation                                                                       |
| `answer <id>`                            | Answer a pending free-form delegate question                                               |
| `send <id>`                              | Send additional input to a qualified active session                                        |
| `continue <id>`                          | Start a linked invocation from a retained native session                                   |
| `broker status` / `stop` / `restart`     | Inspect or control the broker                                                              |
| `broker logs`                            | Read or follow the broker log                                                              |
| `request <operation>`                    | Send any operation with JSON params                                                        |
| `mcp serve`                              | Serve the MCP projection over stdio                                                        |

## Starting an invocation

The provider and model are required. Omit `--connection` to keep the harness's normal native login; a supplied connection ID selects exactly that registered context and never falls back. Prompt input can be supplied in one of
these ways: a positional argument (especially for `run`), `--text <text>`,
`--prompt-file <path>`, `--prompt-file -` for stdin, or `--input-json <path|->`
for a complete content-part array. `--cwd` defaults to the current directory.

```sh
harness-relay start --provider harness-relay --model fake-echo --via fake \
  --cwd "$PWD" --text "hello" --json
harness-relay run --provider anthropic --model opus --interaction deny \
  "Summarize this workspace"
```

Other start options are `--effort`, `--via`, `--connection`, `--runtime`, repeatable `--capability`,
`--timeout-ms`, `--interaction`, `--minimum-assurance`,
`--filesystem`, `--commands`, `--network`, repeatable `--add-dir`,
`--evidence`, `--idempotency-key`, and `--correlation-id`.

`run` writes progress to stderr in human mode, or one event per stdout line in
JSON mode, followed by the complete outcome. It exits zero only for
`succeeded`; SIGINT requests cancellation before returning. The equivalent
programmatic convenience is `createClient().run(request)`.

## Selecting a local model

Configure user-global `localRuntimes` in `config.json`, then run
`harness-relay routes --refresh --json`. A local route uses `--via pi` and
`--runtime <profile-id>`; copy its exact `--provider` and `--model` values from
discovery. A model vendor may be `unknown`; the inference server is not the
provider. The runtime selector disambiguates servers exposing the same model.
No match or multiple matches produce an explicit error without fallback.

Ollama models with reported local tool support can execute through the embedded
Pi worker. LM Studio currently provides discovery and diagnostics; its local
execution remains unqualified. See [local model setup](local-models.md) for
configuration, prerequisites, policy limits, and a complete command.

## Managing native connections

Use the same operations from the CLI, MCP, or typed client. Omit
`--connection` on `start`/`run` to preserve the native default login. A
connection label and route readiness do not establish which account is
authenticated.

```sh
harness-relay connections discover --refresh --json
harness-relay connections list --json
harness-relay connections register --id analysis --harness codex \
  --native-context "$HOME/.codex" --purpose analysis --json
harness-relay connections inspect analysis --json
harness-relay start --provider openai --model gpt-5.5 --via codex \
  --connection analysis --cwd "$PWD" --text "Review this change" --json
```

To prepare a separate context, run:

```sh
harness-relay connections prepare --id implementation --harness codex --json
```

(or use `claude` or `grok`). The explicit prepare
response contains `setup.contextPath` and a structured native login instruction
with `executable`, `args`, and `env`. Relay creates the empty private
directory, but does not launch authentication; run the native login yourself
with the returned environment, then inspect the connection. The setup response
is the only routine connection view that includes this private path. Do not
paste credentials into Relay. For Grok Build, the returned instruction runs
`grok login` with `GROK_HOME` set to that context.

Updates and removals require the revision returned by list/inspect. A stale
revision returns `connection_conflict`; list again before retrying. Removal
deletes only the registration, leaving native context files and credentials in
place. Store writes serialize across processes with a bounded lock wait; if a
writer exits while holding a lock, Relay reports the owner PID and does not
guess whether it is safe to remove the lock.

`answer <id> --request-id <request> --text <answer>` responds to a general
delegate question. Permission requests remain allow/deny-only through
`invocation.respond` (or `request invocation.respond`). `send <id>` queues
active-session input and requires `--idempotency-key`; its response distinguishes
broker acceptance from native-session delivery. `continue <id>` also requires
an idempotency key and starts a new invocation linked to the terminal one. Use
`--input-json` or `--prompt-file` when the content is not plain text.

## Reading progress

```sh
harness-relay events <invocation-id> --follow
harness-relay wait <invocation-id> --until-terminal --json
harness-relay result <invocation-id> --fail-on-error
```

`events` prints one concise category/summary line in human mode. JSON mode
preserves the event envelope and cursors. `wait` keeps each IPC long poll
bounded to 30 seconds even when `--until-terminal` is used. `result` prints
text content in human mode and the full outcome with `--json`.

## Listing

```sh
harness-relay list
harness-relay list --active --correlation build-42 --json
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
