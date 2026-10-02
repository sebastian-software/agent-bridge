---
name: harness-relay
description: Delegate work to another installed agent harness or model through Harness Relay. Use it to hand off one bounded analysis or implementation task, get an independent second opinion, run a review with several models, or set up a named login for a harness. The caller stays in control and reports the outcome.
metadata:
  short-description: Delegate, review, or get a second opinion through Harness Relay
---

# Harness Relay

Harness Relay hands one bounded invocation to another installed harness, such
as Claude Code, Codex, Grok Build, or a local model through Pi, and returns a
normalized outcome. The caller remains the root: it defines the task, owns the
working directory and user constraints, interprets results, and makes the
final decision.

## Choose the workflow

| The user wants                                                       | Follow                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| One task done or analyzed by another model or harness                | The core procedure below                                     |
| A route and effort chosen for them because they named none           | [routing.md](references/routing.md), then the procedure      |
| An independent appraisal, or a review by one or more other models    | The core procedure and [review.md](references/review.md)     |
| To add instructions to a running delegate or continue a finished one | The core procedure and [dialogue.md](references/dialogue.md) |
| To register or prepare a named login for a harness (another account) | [setup.md](references/setup.md)                              |

Delegate on your own initiative only when it clearly adds value within the
user's authorized task, and say so in the report.

## Core procedure

1. **Bound the task.** State the deliverable, relevant files or revision,
   working directory, constraints, and requested validation. Keep analysis and
   reviews read-only unless the user authorized edits; for implementation, say
   exactly what the delegate may change and what it should validate.

2. **Bootstrap the CLI.** Prefer an installed `harness-relay`; otherwise use
   `npx --yes harness-relay@0.3.1`. Run `describe --json` first and treat its <!-- x-release-please-version -->
   operations and capabilities as the source of truth. Use
   `harness-relay run --help` for syntax. Do not rely on repository
   documentation or reproduce the protocol from memory.

3. **Pick a route.** Discover routes with `harness-relay routes --json`. Honor
   every explicit provider, model, effort, harness (`via`), capability,
   interaction, assurance, and connection preference. Without one, choose a
   ready route and effort with [routing.md](references/routing.md), which
   reads the routes' `guidance` and `billing` instead of naming models. An
   explicit route that is unavailable or
   ambiguous is a visible failure; never substitute another model, effort,
   harness, or login. For local routes, copy the exact provider and model and
   keep the discovered `runtimeId` (`--runtime`); Ollama and LM Studio are
   inference servers and Pi is the harness. A route with assurance `none`
   cannot satisfy a task that requires enforced isolation.

4. **Run it.** Use `run`, or `start`, `events`, and `result` when progress needs
   separate handling. Pass an absolute `--cwd`, the smallest requested policy,
   and the complete prompt. Native authentication belongs to the harness: never
   put credentials in prompts, flags, files, or reports. Respect the user's
   interaction strategy.

5. **Keep the evidence.** Preserve content and artifacts, terminal status,
   diagnostics, route and identity evidence, policy and assurance evidence,
   usage, observed effects, and whether effect observation was complete. A
   failed, incomplete, cancelled, timed-out, interrupted, or unavailable result
   stays visible and is never reported as success. Retries and other recovery
   are the caller's explicit choice, and each attempt is reported.

6. **Check implementation work.** Compare observed effects with the requested
   scope, review the changes, and run the validation the task needs. Relay's
   effects are lightweight before/after evidence, not isolation, attribution
   proof, rollback, or a commit.

7. **Report as root.** Name the route used, status, useful results, effects and
   their completeness, failures or missing results, and validation performed,
   and say which delegation contributed. The caller or user decides what to
   keep, revise, retry, or discard.
