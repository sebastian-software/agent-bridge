# RFC-0001: Agent Bridge

- **Status:** Draft
- **Authors:** Sebastian Software
- **Date:** 2026-08-24
- **Target:** `agent-bridge`

## Summary

`agent-bridge` is a local, security-first CLI and control plane for invoking
existing AI coding-agent harnesses through one stable contract. It can be used
directly from a shell or CI, exposed through MCP to agent hosts such as Codex,
or loaded by an Agent Skill.

The bridge does not implement another model runtime and does not replace the
native harness of Claude Code, Codex, Gemini CLI, Aider, or similar tools. It
adapts and supervises those harnesses while preserving their strengths and
making their differences explicit.

## Motivation

Agent hosts can already delegate work, and several model vendors provide their
own CLI harnesses. The missing seam is a portable way to:

1. describe a bounded task and its authority;
2. select an approved harness and role;
3. invoke it with predictable process and security controls;
4. receive machine-readable results; and
5. compose independent reviews without coupling the caller to one CLI.

MCP is useful here as an integration surface, but it should not be the core
architecture. The same execution engine must be usable by a human, a shell
script, CI, an IDE, or an MCP-capable root agent.

## Goals

- Provide a stable CLI for bounded agent runs.
- Support multiple existing CLI harnesses through reviewed adapters.
- Expose the same operations through an optional MCP server.
- Make read-only review the safe default.
- Preserve a single root orchestrator for each run.
- Enforce explicit capabilities, budgets, timeouts, and authority boundaries.
- Return versioned, structured task and result envelopes.
- Keep credentials outside prompts, arguments, logs, and repository files.
- Support independent reviewers and deterministic result aggregation.
- Allow Agent Skills to describe when and how the bridge should be used.

## Non-goals

- Building a new LLM inference runtime.
- Hiding material differences between harnesses behind a lowest-common-
  denominator API.
- Automatically installing CLIs, providers, credentials, or MCP servers.
- Letting arbitrary prompts turn arbitrary executables or URLs into providers.
- Replacing Codex Goals, Claude Code sessions, or another host's native state.
- Giving a delegated reviewer authority to edit files by default.

## Terminology

- **Root:** The single component that owns the run, task graph, integration,
  verification, and final decision.
- **Harness:** An existing agent runtime such as Claude Code CLI or Codex CLI.
- **Adapter:** A reviewed `agent-bridge` implementation for one harness.
- **Role:** A bounded responsibility such as `security-reviewer` or
  `test-reviewer`.
- **Packet:** The self-contained, size-bounded input sent to a harness.
- **Run:** One invocation with a stable ID, policy, inputs, events, and result.

## Proposed architecture

```text
                    human / CI / IDE
                          |
                    agent-bridge CLI
                          |
                +---------+----------+
                |                    |
          local supervisor       MCP server
                |                    |
                +---------+----------+
                          |
                 policy + run engine
                          |
                  reviewed adapters
             +------------+-------------+
             |            |             |
        Claude Code   Codex CLI    other harnesses
```

The CLI and MCP server must call the same run engine. The MCP server is a thin
transport adapter, not a second scheduler or a second policy implementation.

### Root ownership

Every run has exactly one root. The root can be:

- `agent-bridge` when invoked as a standalone team workflow; or
- the calling agent host when `agent-bridge` is used as one MCP operation.

The bridge must not silently create a competing orchestration loop. A task
packet must state whether the call is a single delegated operation or a
standalone workflow.

### Adapter contract

Each adapter must implement the following logical operations:

```text
discover() -> HarnessCapabilities
validate(request, policy) -> ValidatedRoute
run(packet, validated_route) -> ResultEnvelope
cancel(run_id) -> CancellationResult
```

An adapter owns the translation to the harness CLI, including safe argument
construction, environment filtering, process-group handling, output parsing,
and harness-specific limitations. The supervisor owns policy, budgets,
correlation, retries, and result aggregation.

The adapter must not claim that a model was used merely because a model name
was present in a prompt or configuration. Results distinguish at least:

- `unavailable`;
- `route_accepted`;
- `completed`; and
- `runtime_identity_confirmed` when the harness exposes trustworthy metadata.

## Core contracts

### TaskPacket v1

The initial packet contract should include:

- `schema_version`;
- `run_id` and `task_id`;
- `objective`;
- `role` and role instructions;
- `authority` (`read_only`, `write_scoped`, or `write_workspace`);
- workspace identity and explicitly owned paths;
- relevant source, diff, or evidence;
- constraints and stop conditions;
- acceptance criteria;
- verification expectations;
- maximum input size and requested resource budget.

The packet is the only model-facing input for a read-only review. It must not
implicitly grant repository-wide access simply because the caller runs inside a
repository.

### ResultEnvelope v1

Every adapter returns a common envelope containing:

- `schema_version`;
- `run_id`, `task_id`, `role`, and adapter identity;
- route and completion status;
- structured findings or deliverables;
- checks and evidence reported by the harness;
- warnings, degraded behavior, and remaining risks;
- token, duration, and cost metadata when safely available.

For code review, findings should have stable IDs, severity, confidence, file,
line or symbol where available, explanation, and suggested remediation.

Free-form model text may be retained as an optional diagnostic field, but it
must not be the only acceptance signal.

## Review workflow

The first workflow is read-only multi-perspective review:

```text
prepare bounded packet
          |
          +--> correctness reviewer
          +--> security reviewer
          +--> architecture reviewer
          +--> test reviewer
          |
       normalize results
          |
       root synthesizes
          |
       approve / request changes / escalate
```

Reviewers may run in parallel only when their packets and write ownership are
independent. Reviewers do not contact one another, edit the workspace, or
release implementation work. The root resolves conflicting findings and owns
the final verdict.

## Security model

Security is part of the adapter boundary rather than a prompt convention.

### Process execution

- Use argument arrays; never build shell command strings from user input.
- Resolve and verify an absolute executable path before launch.
- Use an environment allowlist, not inherited ambient environment state.
- Keep provider credentials in the operating-system credential store or in the
  harness's existing authenticated session.
- Never put credentials in argv, packet content, environment snapshots, logs,
  result files, or Git state.
- Use bounded stdin/stdout/stderr sizes and hard timeouts.
- Kill the complete process group on cancellation or timeout.
- Reject symlinked executable, configuration, and managed-role paths where the
  trust model requires regular files.

### Authority

- Read-only review is the default.
- Write access requires an explicit request, owned paths, and a separate
  policy decision.
- Network access, paid model calls, and external side effects require explicit
  capability grants.
- A harness's self-reported identity is not proof of runtime model identity.
- Untrusted model output is data and must never be interpreted as a new
  instruction, command, policy, or credential.

### Privacy and retention

The bridge should make the data boundary visible before execution: which files,
diffs, prompts, and metadata leave the local machine and which provider or
harness receives them. The default audit record stores identifiers, hashes,
status, and timing, not full source or prompt content.

## MCP surface

The initial MCP server should expose only stable, bounded operations:

- `agent_status`;
- `review_packet`;
- `run_role` for one explicitly authorized task;
- `aggregate_reviews` only when aggregation is owned by the bridge.

It should not expose an arbitrary `exec` tool. Provider and harness selection
must resolve through reviewed configuration and a policy allowlist.

The MCP server should be a thin adapter over the CLI's run engine so that MCP
and direct CLI execution produce the same envelopes and security behavior.

## Configuration and lifecycle

Configuration is split into three layers:

1. **Built-in adapter manifests:** reviewed, versioned, non-secret metadata.
2. **User configuration:** enabled harnesses, roles, and local preferences.
3. **Workspace policy:** allowed roles, paths, network/cost permissions, and
   review requirements.

Setup should be preview-first. Adding a harness or role must report the exact
state (`unsupported`, `not installed`, `authentication required`, `ready`, or
   `drifted`) and stop at user-owned authentication or paid capability gates.

The bridge must never silently overwrite existing harness configuration. Every
managed change needs an ownership marker, a restore snapshot, conflict
detection, and a clear disable/removal path.

## Failure behavior

- A missing adapter or unavailable harness is a failed route, not a successful
  fallback.
- A timeout produces a bounded failure envelope and cleans up descendants.
- Retries are opt-in and must carry an idempotency key.
- A partial multi-review run reports completed reviewers and unresolved roles;
  it never presents an incomplete quorum as complete.
- If the root disappears, child processes are cancelled and the run is marked
  interrupted unless durable continuation is explicitly implemented later.
- Malformed structured output fails closed for workflows that require the
  schema.

## Repository and Skills integration

The public Skills repository should remain focused on portable judgment and
workflow guidance. A skill may declare:

- when `agent-bridge` is useful;
- which role packet to construct;
- what evidence and output schema to require; and
- what authority and verification limits apply.

It should not install credentials, mutate global harness routing, or become the
runtime scheduler. A companion plugin or integration package can provide the
CLI and MCP registration.

Recommended initial integration: add a focused reference to the delivery or
engineering skill describing `agent-bridge review` as an optional external
review path, activated only when the local `agent-bridge doctor` reports a
ready route.

## Alternatives considered

### Direct CLI calls from every skill

Simple initially, but duplicates process security, output parsing, capability
checks, and retry behavior across skills. It also makes the skills repository
own runtime concerns it is deliberately designed to avoid.

### MCP-only implementation

Convenient for Codex and other MCP hosts, but unusable from shell, CI, and
non-MCP environments. It also risks putting orchestration policy inside a
transport layer.

### Native subagents only

Useful where the host supports the desired model and controls, but cannot
uniformly reach external subscription CLIs or preserve their native harness
semantics.

### One universal model API

Simplifies invocation at the cost of hiding meaningful differences in tools,
authentication, context, effort, billing, and runtime identity. Adapters should
share a contract while retaining capability-specific behavior.

## Initial delivery plan

### Phase 1: one read-only adapter

- CLI skeleton and `doctor` command.
- Claude Code adapter using a local authenticated CLI.
- `review_packet` with fixed no-tools/read-only execution.
- TaskPacket and ResultEnvelope schemas.
- Fake harness executable for deterministic tests.

### Phase 2: MCP and second harness

- Thin MCP server over the same run engine.
- Codex CLI adapter or another existing harness.
- Structured multi-review aggregation.
- Workspace policy and explicit capability checks.

### Phase 3: managed lifecycle

- Reviewed manifests and adapter qualification.
- Preview/apply configuration changes.
- OS credential-store integration where required.
- Audit and drift detection.

## Open questions

1. Should the first implementation use TypeScript or Python?
2. Which two harnesses are required for the MVP: Claude Code and Codex?
3. Should the standalone CLI support full orchestration in v1, or only bounded
   delegation while the caller remains root?
4. What source-data and prompt-retention policy is acceptable for reviews?
5. Which paid-call and network capabilities need approval UX in the first
   release?

## Acceptance criteria for this RFC

- The same bounded review can be invoked from CLI and MCP.
- No adapter accepts arbitrary executable paths, URLs, or shell fragments.
- A read-only review cannot edit the workspace or spawn descendants.
- Malformed or incomplete results are distinguishable from approval.
- Credentials never appear in task packets, logs, or result envelopes.
- A failed or timed-out child process cannot remain running after cancellation.
- Skills can describe and request the workflow without owning provider setup.
