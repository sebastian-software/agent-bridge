# MCP server

`agent-bridge mcp serve` exposes the implemented bridge operations over MCP
stdio. The server is local and starts the user-owned broker on demand.

## Claude Code

```sh
claude mcp add agent-bridge -- agent-bridge mcp serve
```

## Codex

Add a stdio server entry to `~/.codex/config.toml`:

```toml
[mcp_servers.agent_bridge]
command = "agent-bridge"
args = ["mcp", "serve"]
```

## Recommended tool flow

1. Call `agent_bridge_system_describe` to inspect the contract and routes.
2. Call `agent_bridge_invocation_start` with an absolute working directory and
   the smallest required policy.
3. Follow progress with `agent_bridge_invocation_events` using the returned
   cursors. Answer pending permission requests with
   `agent_bridge_invocation_respond`.
4. Call `agent_bridge_invocation_result` after the terminal event.

Only operations marked `implemented` in `system.describe` are advertised as
MCP tools. Tool schemas are self-contained so hosts do not need to resolve
cross-file `$ref` values.
