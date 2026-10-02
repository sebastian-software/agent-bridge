# Harness Relay domain context

## Purpose

`harness-relay` is a public, local harness-to-harness delegation gateway. It
lets an orchestrating harness delegate one bounded invocation to another
installed harness or capability provider and regain control with a normalized
outcome. It does not become the caller's workflow orchestrator.

## Glossary

- **Harness Relay (`harness-relay`):** This project: the npm package, the
  `harness-relay` executable, the local broker it starts, its MCP projection,
  and its typed client. The rename and its one-time migration are recorded in
  [ADR-0021](docs/adr/0021-rename-the-tool-to-harness-relay.md); the decision
  records numbered 0001 to 0020 keep the previous name in their text and mean
  the same tool. The vocabulary below still calls the component "the bridge",
  because bridging two harnesses is what it does.
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
- **Model runtime:** A service that executes model inference, such as Ollama or
  LM Studio.
  A model runtime is distinct from the harness that executes tools and controls
  an agent's work.
- **Account:** An authenticated identity through which a harness obtains access
  to models or capabilities. An account is distinct from a local label or
  configuration profile used to select it.
- **Harness connection:** A user-named access to a harness's native configuration
  and authentication context, with an optional user-defined purpose. It does
  not prescribe a model, effort level, or workflow role.
- **Adapter:** A reviewed bridge implementation that translates one bridge
  operation to one qualified harness contract.
- **Provider:** The model vendor whose model a selector names, such as
  Anthropic, OpenAI, or Google. A provider is not a harness; one provider's
  model may be reachable through several installed harnesses.
- **Delegation selector:** The caller's ad-hoc description of the desired
  delegate: provider, model, effort, optional harness family, and optional
  required capabilities. It is not a pre-created named object.
- **Delegate:** The execution route chosen for one invocation, through a harness
  or capability provider.
- **Local delegate:** A tool-using delegate whose model inference runs locally.
- **Resolved route:** The concrete adapter, executable, harness version,
  authenticated native context, and model selection chosen for one invocation.
- **Route guidance:** Editorial advice attached to a route about the model
  behind it: a capability tier and particular strengths, built in or declared
  by the user. It is not evidence, adds no capability, and plays no part in
  route resolution.
- **Billing mode:** How use of a route is paid for, as far as the bridge can
  tell: `local`, `subscription`, `metered`, or `unknown`.
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
- **Delegation skill:** Caller-side instructions for handing one bounded task
  to a delegate and interpreting its outcome.
- **Routing skill:** Caller-side instructions for choosing the route and
  effort of a delegation from route guidance and billing mode.
- **Workflow skill:** Caller-side instructions for coordinating invocations
  toward a specific goal. The caller remains the root and owns the final
  decision.
- **Interaction strategy:** Explicit handling of native approvals and input:
  `orchestrator`, `deny`, or `unattended`.
- **Requested policy:** Permissions the caller asks the selected route to use.
- **Assurance:** The execution boundary actually provided by a route:
  `none`, `native`, or future `isolated`.
- **Evidence status:** Whether an identity or observation is `unverified`,
  `inferred`, `reported`, or `verified`.
- **Tombstone:** Minimal retention metadata left after an invocation payload is
  evicted.
- **Continuation:** A new invocation linked to a terminal predecessor that
  resumes a retained native session when the exact route and policy remain
  qualified. It has a new identity and does not alter the predecessor outcome.
- **Steering:** Additional caller input queued for an active invocation through
  an adapter's supported native session boundary. Acceptance and native
  delivery are distinct evidence; delivery does not prove model consumption.
- **Caller correlation ID:** Optional caller-owned metadata used to search or
  group invocations.
- **Idempotency key:** Optional caller-owned key that deduplicates an equivalent
  start request without changing invocation identity.

## Resolved invariants

- The caller remains the only root in the initial architecture.
- The bridge exposes bounded operations and does not silently create a second
  orchestration loop.
- The initial execution primitive is a one-shot invocation. Steering and
  continuation are separate optional adapter capabilities; continuation creates
  a linked invocation rather than making an invocation persistent.
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
- Route guidance and billing mode inform the caller's choice. The bridge
  never selects a route from them.
- The next increment expands reviewed built-in adapters while keeping their
  internal boundaries extensible. A public third-party adapter/plugin contract
  and plugin loading are outside this increment.
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
- Native steering and linked-continuation qualification for each adapter.
- Additional non-harness capability providers such as OCR and vision.

The current operation list, state machine, evidence rules, and retention
behavior are documented in [`docs/contract.md`](docs/contract.md). New changes
should update the relevant ADR and contract together.
