# TanStack AI harness spike results

- **Date:** 2026-08-27
- **Environment:** macOS 26.5.2 arm64, Node.js 24.19.0
- **Harnesses:** Claude Code 2.1.235, Codex CLI 0.149.1
- **TanStack packages:** `@tanstack/ai` 0.49.1,
  `@tanstack/ai-claude-code` 0.6.0, `@tanstack/ai-codex` 0.5.0,
  `@tanstack/ai-sandbox` 0.5.1, and
  `@tanstack/ai-sandbox-local-process` 0.2.4
- **Models:** Claude `opus` alias and Codex `gpt-5.5` with high reasoning
- **Authentication:** existing host logins; provider API-key environment
  variables were scrubbed from the child environment

## Conclusion

TanStack AI is a useful implementation reference and could later become an
optional adapter, but the tested RC packages should not be the foundational
MVP harness layer of agent-bridge.

Both adapters successfully proved normalized streaming, host authentication,
in-place workspace changes, native session continuation, and signal-driven
stream cancellation. The spike also found correctness gaps in workspace
projection, effect reporting, and Codex process teardown. Active-turn steering
and same-run orchestrator-mediated approvals remain unavailable.

The recommended MVP path remains direct integration with the Claude Agent SDK
and Codex app-server. The public bridge contract should borrow TanStack's small
per-adapter translators, session provenance, event normalization, and explicit
detach-versus-cancel design without depending on its chat or sandbox lifecycle.

## Measured results

| Scenario | Claude Code | Codex |
| --- | --- | --- |
| Basic in-place edit | Passed in 10.7 s | Passed in 18.5 s |
| Native session ID | Emitted | Emitted |
| Continuation | Same session, passed in 6.1 s | Same thread, passed in 16.4 s |
| Live tool events | Bash/tool events | command/file-change events |
| File watcher | Detected create/change with unified diff | Detected create/change with unified diff |
| Cancel after 8 s | Stream stopped; process tree gone | Stream stopped; child `sleep 120` survived |
| Terminal event after cancel | None | None |

The orphaned Codex test process was verified with parent PID 1 and then
explicitly terminated. The Claude cancellation left no matching process.

## Findings that affect agent-bridge

### Strong fit

- `RUN_*`, text, reasoning, tool-call, usage, custom file, and session events
  form a practical normalized vocabulary.
- Both adapters retain native session identity and accept it on a later run,
  matching `invocation.continue` and immutable prior outcomes.
- The local-process provider uses existing CLI authentication and an explicit
  caller-selected directory.
- Claude emits partial text/reasoning and both harnesses expose resolved native
  tool activity.
- `AbortController` stops stream consumption at a predictable boundary.

### Blocking gaps

1. **Codex cancellation leaked a process.** The stream ended at 8.0 seconds,
   but the command launched by Codex remained as an orphaned process. A broker
   cannot claim reliable cancellation on top of the adapter unchanged.
2. **No terminal cancellation event.** Both cancelled streams ended without
   `RUN_FINISHED` or `RUN_ERROR`. Agent-bridge would have to synthesize and
   persist its own terminal `cancelled` outcome.
3. **Workspace projection is not transparent.** `withSandbox()` requires an
   explicit workspace in the published package combination. Without one it
   fails because the middleware declares but does not provide the projection
   capability. With an empty workspace it writes a persistent
   `.tanstack-projected-*` marker into the delegated repository.
4. **Claude adapter noise appears as effects.** Per-run argv and JavaScript
   wrapper files are created inside the workspace. Although they are removed
   after the run, the watcher emits them as file effects and diffs.
5. **Post-run diff misses untracked files.** The Claude `file.changed` summary
   uses `git diff`, so the newly created untracked fixture produced no summary
   event. The live watcher detected it, but callers cannot rely on the summary
   alone.
6. **No active-turn steering.** Session continuation works only as a new
   `chat()` run; it does not implement `invocation.send` into a live turn.
7. **No same-run interaction bridge.** Harness tool approvals cannot pause and
   wait for `invocation.respond`. Codex defaults to `approvalPolicy: "never"`;
   Claude exposes coarse permission modes and rerun-oriented approval events.
8. **The harness adapters are text-only.** TanStack's wider media APIs do not
   make the tested Claude Code and Codex harness adapters multimodal.
9. **Claude effort is not represented.** The Claude Code adapter accepts a
   model but exposes no effort option, so a selector such as “Opus, high
   effort” cannot be faithfully qualified through this package.
10. **Published docs and packages differ.** The tested adapters require
    `withSandbox()` and directly construct CLI commands. This differs from
    documentation describing simple direct usage through the official SDKs.

## Event observations

Successful runs contained:

- `RUN_STARTED` and `RUN_FINISHED`;
- `TEXT_MESSAGE_*` and, for Claude, partial reasoning events;
- normalized `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, and
  `TOOL_CALL_RESULT` events;
- `claude-code.session-id` or `codex.session-id` custom events; and
- `sandbox.file` plus optional `sandbox.file.diff` events.

Usage metadata was present. Claude also reported provider cost metadata. The
model field contained the requested alias or model ID, not independently
verified runtime identity.

## Reproduction

```sh
pnpm install
pnpm check
pnpm run run -- --harness claude --model opus --scenario full
pnpm run run -- --harness codex --model gpt-5.5 --scenario full
```

Each command creates a disposable Git repository when `--workspace` is omitted.
The generated repository is retained for inspection. Raw bounded JSONL is
stored in the operating-system temp directory and is not committed.

## Proposed dependency decision

- Do not make TanStack AI a required MVP runtime dependency.
- Keep the agent-bridge event and content contracts independent of AG-UI.
- Implement Claude through its native Agent SDK and Codex through app-server so
  live input, approvals, runtime identity, and process ownership remain under
  bridge control.
- Reuse or adapt translator and journal patterns where their licenses and APIs
  permit.
- Re-evaluate an optional TanStack-backed adapter after its harness packages
  stabilize and the teardown/projection issues are resolved.
