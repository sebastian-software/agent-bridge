---
name: harness-relay
description: Delegate one bounded analysis or implementation task to an installed harness through Harness Relay and report its outcome to the caller.
metadata:
  short-description: Delegate one bounded task through Harness Relay
---

# Harness Relay delegation

Use this skill when the caller benefits from handing one clearly bounded
analysis or implementation task to another installed harness. The caller
remains the root: it defines the task, owns the working directory and user
constraints, interprets the result, and makes the final decision.

## Procedure

1. Define the task boundary before invoking the delegate. Include the desired
   deliverable, relevant files or revision, working directory, constraints,
   and validation requested. Keep analysis requests read-only unless the user
   authorized edits. For implementation, tell the delegate exactly what it
   may change and what it should validate.

2. Bootstrap the command from the caller's environment. Prefer an installed
   `harness-relay`. If it is unavailable, use the public release CLI with
   `npx --yes harness-relay@0.3.0`. Run `describe --json` first and use its <!-- x-release-please-version -->
   operation and capability data as the source of truth. When command syntax
   is needed, run `harness-relay run --help` (or the same `npx` command with
   `run --help`); the installed skill must not depend on repository
   documentation. Do not reproduce the
   bridge protocol from memory or assume an operation is implemented.

3. Discover qualified routes with the described route-discovery operation or
   the equivalent `harness-relay routes --json` command. Honor explicit
   provider, model, effort, harness-family (`via`), capability, interaction,
   assurance, and other user preferences. When those choices are absent,
   select an appropriate qualified route and effort for the task. An explicit
   route that is unavailable or ambiguous is a visible resolution failure;
   never silently substitute another model, effort, or harness. For local
   routes, preserve the discovered `runtimeId` (`--runtime` in the CLI) to
   identify the inference server, and copy the exact provider/model values.
   The model vendor may be `unknown`; Ollama and LM Studio are inference
   servers, while Pi is the harness. Local inference does not imply offline
   tools or sandboxed filesystem access. A route reporting `assurance: none`
   cannot satisfy a task requiring enforced isolation.

4. Start the bounded invocation using the CLI's documented `run` flow (or
   `start`, `events`, and `result` when progress must be handled separately).
   Pass an absolute `--cwd`, the smallest requested policy, and the complete
   task prompt. Native authentication belongs to the selected harness; never
   put credentials in prompts, flags, files, or reports. Respect the user's
   interaction strategy and any existing approval preferences.

5. Treat the terminal outcome as evidence. Preserve the returned content and
   artifacts, terminal status, diagnostics, route and identity evidence,
   policy/assurance evidence, usage when present, effect observations, and
   effect-observation completeness. A non-success, incomplete, cancelled,
   timed-out, interrupted, or unavailable result remains visible. Do not call
   incomplete work successful or silently hide a failure. If the caller or
   user chooses a retry or other recovery, make it explicit and report each
   attempt; recovery remains caller-owned.

6. For implementation work, inspect the workspace after the outcome and
   compare the observed effects with the requested scope. The bridge reports
   lightweight before/after evidence; it does not provide isolation,
   attribution proof, rollback, or a commit. Review the delegate's changes and
   run the validation appropriate to the user's task before accepting them.

7. Report back as root with the selected route, invocation status, useful
   returned material, observed effects and their completeness, failures or
   missing results, and validation performed. Say which delegation contributed
   to the result. The caller or user decides what to keep, revise, retry, or
   discard.

## Communicating with the delegate

Discover capabilities on the exact CLI or MCP server before using dialogue
operations. A harness supporting them natively is not enough: the selected
Relay route must advertise the capability. Keep the initial invocation ID.

For a route advertising `steering`, send a bounded additional instruction with
an invocation-scoped idempotency key:

```sh
harness-relay send <invocation-id> \
  --idempotency-key add-regression-case-1 \
  --text "Also cover the empty-input case." --json
```

Use the same executable prefix validated during bootstrap. Follow invocation
events after sending. `input_accepted` means the broker recorded the request;
`input_delivered` means the native session acknowledged its boundary. Neither
proves that the model followed the instruction. A pending, failed, or expired
delivery must remain visible. Reuse the same key and identical content when
retrying the send; a different key creates another instruction. Sending does
not interrupt a running tool. Use explicit cancellation to stop the invocation.

After completion, use `continue` only when the route advertises `continuation`
and a retained native session is available:

```sh
harness-relay continue <invocation-id> \
  --idempotency-key review-completed-change-1 \
  --text "Review the change you just made and report remaining risks." --json
```

Track the returned new invocation ID and its own outcome. A missing, expired,
or changed native session is an explicit failure; do not silently replace it
with a new conversation. The caller decides whether to start fresh.

Answer a correlated general question through `invocation.answer`, using the
request ID from its `input_required` event. Permission requests use
`invocation.respond` with `allow` or `deny`. Do not infer question requests from
ordinary assistant prose or treat permission approval as a general answer.
