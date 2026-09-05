# Agent Bridge domain context

## Purpose

`agent-bridge` is a public, local harness-to-harness delegation gateway. It lets
an orchestrating harness delegate one bounded invocation to another installed
harness or capability provider and regain control with a normalized outcome.
It does not become the caller's workflow orchestrator.

## Glossary

- **Caller:** The human, CI job, IDE, agent host, or other component that invokes
  a bridge operation.
- **Root:** The caller-owned component that controls workflow order, combines
  results, and makes the final decision. The term does not mean filesystem root
  or workspace root.
- **Bridge operation:** One bounded function exposed by the bridge, such as
  discovering a route or starting one invocation.
- **Broker:** The long-lived local bridge process that owns active invocation
  processes, event streams, continuation handles, and their lifecycle.
- **Harness:** An existing agent runtime and its CLI contract, such as Claude
  Code or Codex CLI.
- **Adapter:** A reviewed bridge implementation that translates one bridge
  operation to one qualified harness contract.
- **Provider:** The model vendor whose model a selector names, such as
  Anthropic, OpenAI, or Google. A provider is not a harness; one provider's
  model may be reachable through several installed harnesses.
- **Delegation selector:** The caller's ad-hoc description of the desired
  delegate: provider, model, effort, optional harness family, and optional
  required capabilities. It is not a pre-created named object.
- **Delegate:** The harness route chosen for one invocation.
- **Resolved route:** The concrete adapter, executable, harness version,
  authenticated native context, and model selection chosen for one invocation.
- **Invocation:** One asynchronous, bounded delegation from an orchestrator to
  exactly one resolved route. An invocation is not a task graph or workflow.
- **Invocation event:** An ordered, cursor-addressable observation emitted
  while an invocation runs, such as lifecycle state, assistant output, tool
  activity, diagnostics, usage, or an observed effect update.
- **Outcome:** The terminal result of an invocation. It contains returned
  content and artifacts, execution status, and observed effects such as
  workspace file modifications.
- **Effect:** An observable state change caused by an invocation, for example a
  created, modified, renamed, or deleted repository file.
- **Effect observation:** A lightweight before/after comparison performed by
  the bridge. It reports evidence of changes but does not provide isolation,
  attribution proof, rollback, or transactional guarantees.
- **In-place invocation:** An invocation whose delegate runs in the caller-chosen
  working directory and may leave effects there. It is not a transaction or an
  isolation boundary.
- **Workflow:** Caller-owned coordination of one or more invocations.
- **Interaction strategy:** Explicit handling of native approvals and input:
  `orchestrator`, `deny`, or `unattended`.
- **Requested policy:** Permissions the caller asks the selected route to use.
- **Assurance:** The execution boundary actually provided by a route:
  `none`, `native`, or future `isolated`.
- **Evidence status:** Whether an identity or observation is `unverified`,
  `inferred`, `reported`, or `verified`.
- **Tombstone:** Minimal retention metadata left after an invocation payload is
  evicted.
- **Continuation:** A future linked invocation that resumes a native session;
  it is not an active-turn operation.
- **Steering:** A future operation that sends direction into an active native
  invocation.
- **Caller correlation ID:** Optional caller-owned metadata used to search or
  group invocations.
- **Idempotency key:** Optional caller-owned key that deduplicates an equivalent
  start request without changing invocation identity.

## Resolved invariants

- The caller remains the only root in the initial architecture.
- The bridge exposes bounded operations and does not silently create a second
  orchestration loop.
- The initial execution primitive is a one-shot invocation. Persistent delegate
  sessions are optional future capabilities, not part of the core contract.
- Starting an invocation returns control immediately with a handle. Progress and
  output remain observable while the delegate runs.
- An outcome may include both returned content and effects that remain in the
  delegated workspace.
- In-place invocation is the primary workspace mode. The orchestrator owns any
  commit, snapshot, copy, worktree, or other recovery point needed before the
  invocation.
- The bridge supervises an installed harness but is not a sandbox around it.
  The harness retains the effective permissions of its process, native
  configuration, and authenticated session.
- The bridge observes and reports lightweight workspace effects before and
  after an invocation without managing source-control state.
- Delegation is model-first and ad hoc. A caller normally selects provider,
  model, and effort; a harness family is an optional disambiguator.
- Route resolution never silently substitutes another model, effort, or
  harness. Ambiguous or unavailable selectors fail with candidate diagnostics.
- The CLI is self-describing. Detailed operation knowledge lives in the bridge,
  not in a host-specific skill or duplicated instruction file.
- A local broker owns asynchronous invocations. CLI and optional MCP adapters
  are clients or projections over the same broker contract.
- Result aggregation inside the bridge, if introduced later, must not transfer
  ownership of the final verdict unless a separate workflow-root capability is
  explicitly designed and selected.

## Process and security boundary invariants

These invariants describe the bridge's own boundary, not a sandbox around the
harness.

- Routes resolve only to reviewed adapters and the executables they qualify.
  The bridge never turns an arbitrary executable, URL, or shell fragment into a
  route.
- Harness processes are launched with argument arrays and a resolved absolute
  executable path, never through a shell string built from caller input.
  Symlinked executables are normal for harness installations and are allowed.
- Credentials never appear in argv, invocation input, events, outcomes, logs,
  or repository files. The harness's native authenticated session is the
  credential boundary.
- Cancellation and timeout terminate the whole harness process tree. A
  cancelled or timed-out invocation cannot leave a running descendant.
- A missing adapter, unqualified harness version, or unavailable route is a
  failed resolution, never a fallback.
- Malformed or incomplete harness output yields a failed or degraded outcome,
  never a completed one. Incomplete results are always distinguishable from
  success.
- A harness's self-reported identity is evidence, not proof, of the runtime
  model. Outcomes state the strongest evidence level actually observed.
- Untrusted harness output is data. The bridge never interprets it as a new
  instruction, operation, or credential.
- Every contract surface is versioned: requests, events, outcomes, and the
  describe output.

## Terms awaiting decisions

The initial contract and broker behavior are resolved. Remaining design work is
explicitly limited to:

- Windows Named Pipes, Job Objects, packaging, and process-tree qualification.
- Non-Git effect observation that can attribute changes without a repository.
- A genuinely isolated assurance level rather than native permission mapping.
- Active-turn steering and linked continuation semantics.
- Additional non-harness capability providers such as OCR and vision.

The current operation list, state machine, evidence rules, and retention
behavior are documented in [`docs/contract.md`](docs/contract.md). New changes
should update the relevant ADR and contract together.
