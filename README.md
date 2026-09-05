# agent-bridge

`agent-bridge` is a local, model-first delegation gateway. It lets an
orchestrating agent delegate one bounded invocation to an installed harness,
observe progress, and regain control with a normalized outcome. It is not a
workflow orchestrator, sandbox, source-control manager, or credential store.

## Install

The package requires Node.js 22 or newer and currently supports macOS and
Linux. Windows support is not claimed yet.

```sh
pnpm add --global @sebastian-software/agent-bridge
# or
npx @sebastian-software/agent-bridge routes
```

## First delegation

Discover qualified local routes before starting work:

```sh
agent-bridge routes
agent-bridge run --provider anthropic --model opus --interaction deny \
  "Summarize the repository changes in this working directory."
```

Use `--cwd` to select an absolute working directory. `deny` rejects native
permission requests, while `unattended` opts into the harness's qualified
non-interactive mode. `orchestrator` turns supported native requests into
`input_required` events for `invocation.respond`; the Codex route currently
supports `deny` and `unattended`, while the Claude route supports all three.

The deterministic fake routes are useful for local tests:

```sh
agent-bridge run --provider agent-bridge --model fake-echo --via fake \
  --cwd "$PWD" "hello from a fixture"
```

## How it works

The first client autostarts one user-owned broker. The broker supervises the
selected harness process, persists ordered events, and records a terminal
outcome. The default socket is `$XDG_RUNTIME_DIR/agent-bridge/broker.sock`
when that variable is set; clients continue to read the legacy
`$XDG_RUNTIME_DIR/broker.sock` for one release. Otherwise a private
platform-temporary directory is used;
state lives in `~/.local/state/agent-bridge`. Override
them with `AGENT_BRIDGE_RUNTIME_DIR`, `AGENT_BRIDGE_STATE_DIR`, or
`AGENT_BRIDGE_SOCKET_PATH`.

An outcome separates returned `content`, `artifacts`, observed workspace
`effects`, effect-observation completeness, usage, runtime identity evidence,
policy evidence, and terminal status. Effects are lightweight observations;
they are not isolation, attribution proof, rollback, or a commit.

## Integrating from an agent

For a shell or generic JSON client, use the same stable sequence:

```sh
agent-bridge describe --json
agent-bridge start --provider agent-bridge --model fake-echo --via fake \
  --cwd "$PWD" --text "hello" --json
agent-bridge events <invocation-id> --follow --json
agent-bridge result <invocation-id> --json
```

Typed TypeScript callers can use `createClient()` from the package entry point.
The detailed contract, state machine, cursors, errors, retention, and privacy
rules are in [`docs/contract.md`](docs/contract.md). CLI flags and examples
are in [`docs/cli.md`](docs/cli.md).

## MCP

Register the stdio server with Claude Code or Codex as described in
[`docs/mcp.md`](docs/mcp.md). The recommended MCP flow is
`describe` → `start` → `events` → `result`.

## Development and contributing

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, Biome linting, TypeScript validation, tests,
coverage, the package dry-run, and the existing newline gate. Architecture and
terminology live in [`CONTEXT.md`](CONTEXT.md) and the
[`docs/adr/`](docs/adr/) decision records. Work is tracked in GitHub issues;
see the `epic` label for grouped work.
