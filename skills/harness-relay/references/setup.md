# Setting up a named login

Use this when the user wants to register an existing native harness context or
prepare a separate one for another account. The user chooses the stable
connection ID and purpose label. A label and a ready route do not establish
which account is signed in.

1. **Check the CLI** and keep using the exact executable that passes. Run
   `harness-relay describe --json` (or
   `node /absolute/path/to/checkout/dist/src/cli.js describe --json` for a
   source build) and confirm that `connection.discover`, `connection.list`,
   `connection.inspect`, `connection.register`, `connection.prepare`,
   `connection.update`, and `connection.remove` are `implemented`. Releases
   before 0.2.0 lack them; then stop and point to
   https://github.com/sebastian-software/harness-relay/blob/main/docs/skills.md.
   After validating a source build, do not fall back to another
   `harness-relay` on `PATH`. With MCP, verify the operations on the configured
   server. Do not install harnesses or plugins automatically.
   If an operation reports unsupported, an older broker may still run: inspect
   `broker status --json` and `list --active --json`, and run `broker restart`
   without `--force` only when no invocations are active.

2. **Review what exists** with `connection.discover` and `connection.list`
   (`harness-relay connections discover --refresh --json`), and
   `connection.inspect` for a registered context. Without an explicit
   connection ID, the default login stays in use.

3. **Register an existing context** with `connection.register`: a stable ID,
   the harness ID, and the native context directory the user already
   configured. Ask for the directory if it is unknown. Never read or copy
   authentication files, ask for secrets, or infer the account from a
   directory name.

4. **Prepare a new context** with `connection.prepare`: a stable ID, the
   harness, and an optional purpose. Relay creates an empty private directory
   and returns `setup.contextPath` and structured login instructions
   (`executable`, `args`, `env`). Show them as structured data; do not build a
   shell command from the returned path or run the login for the user. The
   user completes the native sign-in, including any second factor, in the
   harness's own flow. The default login is not changed.

5. **Verify** after the user says sign-in is done: inspect the connection and
   refresh discovery. Report readiness and diagnostics as route evidence only;
   if the route is unavailable, explain the next step, and never choose another
   connection instead.

6. **Repeat or change setup** with the same stable ID: identical register and
   prepare calls are idempotent. Updates and removal need the current revision;
   on `connection_conflict`, list again and ask before resolving it. Removal
   unregisters only and leaves context files and credentials in place.

7. **Report** the connection ID and harness, observed readiness, any remaining
   user action, and that Relay did not verify the account identity.

Once ready, the user selects the login per invocation with `--connection <id>`.
