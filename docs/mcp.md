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

1. Call `harness_relay_system_describe` to inspect the contract and routes.
2. Call `harness_relay_route_discover` to inspect qualified routes. Pass
   `connectionId` to inspect one named native context.
3. Call `harness_relay_invocation_start` with an absolute working directory,
   the smallest required policy, and optional `selector.connectionId`. Omitting
   the selector preserves the harness's normal native login.
4. Follow progress with `harness_relay_invocation_events` using the returned
   cursors. Answer pending permission requests with
   `harness_relay_invocation_respond`; answer general delegate questions with
   `harness_relay_invocation_answer`.
5. Call `harness_relay_invocation_result` after the terminal event.

`harness_relay_invocation_send` queues additional input for an active native
session when its route advertises steering. `harness_relay_invocation_continue`
starts a new invocation linked to a terminal predecessor when a retained native
session handle is available. Each operation reports its own capability errors;
the broker does not silently restart or retarget a delegate.

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
