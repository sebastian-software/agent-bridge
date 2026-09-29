# MCP server

`harness-relay mcp serve` exposes the implemented bridge operations over MCP
stdio. The server is local and starts the user-owned broker on demand.

## Claude Code

```sh
claude mcp add harness-relay -- harness-relay mcp serve
```

## Codex

Add a stdio server entry to `~/.codex/config.toml`:

```toml
[mcp_servers.harness_relay]
command = "harness-relay"
args = ["mcp", "serve"]
```

## Recommended tool flow

1. Call `harness_relay_system_describe` to inspect the contract and operations.
2. Call `harness_relay_connection_discover` or
   `harness_relay_connection_list` to inspect routes and redacted registrations.
   `harness_relay_connection_inspect` refreshes readiness for one registration;
   readiness does not prove account identity.
3. If needed, call `harness_relay_connection_register` for a native context the
   user already configured, or `harness_relay_connection_prepare` to create an
   empty private context and receive structured `executable`, `args`, and `env`
   login instructions. Relay never launches native authentication or copies
   credentials. Only the explicit prepare result includes the new context path.
4. Call `harness_relay_invocation_start` with an absolute working directory,
   the smallest required policy, and optional `selector.connectionId`. Omitting
   the connection selector preserves the harness's normal native login. For
   local models, use `selector.via: "pi"` and `selector.runtimeId` with the exact
   provider/model values returned by discovery.
5. Follow progress with `harness_relay_invocation_events` using the returned
   cursors. Answer pending permission requests with
   `harness_relay_invocation_respond`; answer general delegate questions with
   `harness_relay_invocation_answer`.
6. Call `harness_relay_invocation_result` after the terminal event.

`harness_relay_invocation_send` queues additional input for an active native
session when its route advertises steering. `harness_relay_invocation_continue`
starts a new invocation linked to a terminal predecessor when a retained native
session handle is available. Each operation reports its own capability errors;
the broker does not silently restart or retarget a delegate.

Use `harness_relay_connection_update` and `harness_relay_connection_remove`
with the current registration revision. Removal only unregisters the context;
it leaves native configuration and credentials untouched. Connection tools
use the same broker operations as the CLI and typed client, including
revision-conflict and duplicate-registration behavior.

Only operations marked `implemented` in `system.describe` are advertised as
MCP tools. Tool schemas are self-contained so hosts do not need to resolve
cross-file `$ref` values.

Successful calls return their operation result in `structuredContent`, which is
validated against the advertised output schema. Failed calls set `isError` and
return the structured bridge error as JSON text content. They omit
`structuredContent` because an error object does not satisfy the successful
operation's output schema; clients can parse the text content to retain the
bridge error code, message, retryability, and details.

The repository also carries an integration test that starts `harness-relay mcp
serve` as a child process and drives it with the official MCP SDK client over
stdio. It covers initialization, tool discovery, schema-backed calls, visible
bridge errors, and a complete fake invocation lifecycle.

Local model profiles are user-global configuration, separate from native
account registrations. MCP uses the same `selector.runtimeId` as the typed
client and CLI's `--runtime`; it does not install models or start inference
servers. See [local model setup](local-models.md) for Ollama execution and the
current LM Studio discovery limitation.
