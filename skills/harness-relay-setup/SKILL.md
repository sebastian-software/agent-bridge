---
name: harness-relay-setup
description: Discover, register, prepare, and validate user-scoped native harness contexts through Harness Relay.
metadata:
  short-description: Set up a named native context
---

# Harness Relay connection setup

Use this skill when the caller wants to register an existing native harness
context or prepare a separate context for an additional account. The caller
chooses the stable connection ID and purpose label. A label and a ready route
do not establish the identity of the account signed in to the native harness.

## Procedure

1. Check the CLI before using this skill, and keep using the exact executable
   that passes this check. For an installed CLI, run
   `harness-relay describe --json`; for a source build, run
   `node /absolute/path/to/checkout/dist/src/cli.js describe --json`. Confirm
   that all seven operations `connection.discover`, `connection.list`,
   `connection.inspect`, `connection.register`, `connection.prepare`,
   `connection.update`, and `connection.remove` are marked `implemented`.
   Releases before 0.2.0 do not include them. If they are missing, stop and
   explain that this skill needs Harness Relay 0.2.0 or newer, or a source
   build with these operations; installation instructions are at
   https://github.com/sebastian-software/harness-relay/blob/main/docs/skills.md.
   Do not fall back to another `harness-relay` found on `PATH` after validating
   a source build. If using MCP, also verify these operations on the exact
   configured MCP server. Do not install runtimes or plugins automatically.
   Confirm that the selected harness runtime is installed before managing its
   context. If a connection operation reports unsupported, inspect the broker
   with `broker status --json` and `list --active --json` using the same CLI.
   Restart it with that CLI's `broker restart` command without `--force` only
   when no invocations are active. If work is active, wait for it to finish;
   never interrupt it to enable connection management.

2. Call `connection.discover` and `connection.list` to review the default
   route, available named routes, and existing redacted registrations. With an
   installed CLI, the discover command is
   `harness-relay connections discover --refresh --json`; with a source build,
   use the same `node /absolute/path/to/checkout/dist/src/cli.js` prefix you
   validated above. Use
   `connection.inspect` for a registered context. Keep the default route when
   no connection ID is explicitly selected.

3. To register an existing context, use `connection.register` with a stable
   ID, harness ID, and the native context directory the user already
   configured. Ask the user for the directory reference if it is not already
   provided. Do not read or copy authentication files, request secrets, or
   infer account identity from the directory name.

4. To prepare a new context, call `connection.prepare` with a stable ID,
   supported harness, and optional purpose. Relay creates an empty private
   directory and returns `setup.contextPath` plus structured native login
   instructions (`executable`, `args`, and `env`). Present those fields as
   structured data for the user. Do not construct a shell command by
   interpolating the returned path or launch the native login on the user's
   behalf. Relay does not switch the default login. The user must complete the
   native sign-in themselves.

5. Ask the user to say when they have completed native sign-in, then inspect
   the connection again with `connection.inspect` and refresh
   `connection.discover`. Report readiness and diagnostics as route evidence
   only. If the route is unavailable, explain the observed next step; do not
   claim the context belongs to a different account or silently choose another
   connection.

6. Reuse the same stable ID and settings when setup is repeated. Identical
   registration and prepare calls are idempotent. For updates and removal,
   include the current registration revision. If Relay returns
   `connection_conflict`, refresh the list and ask before choosing how to
   resolve a changed registration. Removal unregisters only; it does not
   delete context files or credentials.

7. Report the selected ID and harness, observed readiness, any user action
   still needed, and the fact that account identity was not verified by Relay.
