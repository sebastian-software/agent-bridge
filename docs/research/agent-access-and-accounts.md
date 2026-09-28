# Broader harness support, assisted setup, and multiple accounts

Date: 2026-09-28; implementation status updated 2026-09-29

Status: Product scope settled; the connection contract (#145) is merged and
bounded native-context fixtures are implemented. Live dual-account
qualification and assisted setup remain. Accepted directions are recorded in
[ADR-0024](../adr/0024-user-scoped-multiple-accounts-without-fallback.md) and
[ADR-0025](../adr/0025-direct-local-model-access.md).

## Delivery tracking

The implementation is tracked in three GitHub epics. The decision and
qualification PR does not complete these features.

| Epic                                                                                               | Implementation issues                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Accounts and assisted setup](https://github.com/sebastian-software/harness-relay/issues/142)      | [Connection contract #145](https://github.com/sebastian-software/harness-relay/issues/145), [native contexts #146](https://github.com/sebastian-software/harness-relay/issues/146), [management and setup skill #147](https://github.com/sebastian-software/harness-relay/issues/147)                                          |
| [Grok and local agents](https://github.com/sebastian-software/harness-relay/issues/143)            | [Grok #148](https://github.com/sebastian-software/harness-relay/issues/148), [Pi worker #149](https://github.com/sebastian-software/harness-relay/issues/149), [Ollama #150](https://github.com/sebastian-software/harness-relay/issues/150), [LM Studio #151](https://github.com/sebastian-software/harness-relay/issues/151) |
| [Caller-to-delegate communication](https://github.com/sebastian-software/harness-relay/issues/144) | [Broker contract #152](https://github.com/sebastian-software/harness-relay/issues/152), [native integration #153](https://github.com/sebastian-software/harness-relay/issues/153)                                                                                                                                              |

Start with the connection contract (#145). The Pi worker (#149) and dialogue
contract (#152) can be developed independently, with their interfaces coordinated.
Native account qualification and assisted setup follow the connection contract;
the runtime routes and native dialogue integration follow their respective
foundations. Both Ollama and LM Studio remain in scope; development order does
not remove either from the first local-model increment.

## Product goals

- Add the standalone Grok harness as the next execution adapter. Cursor is not
  a target for this increment. OpenCode and harnesses associated with Kimi
  remain possible later integrations. A model provider and the harness exposing
  its models are separate concepts.
- Allow multiple accounts for one harness with explicit selection. Example
  purposes include analysis, implementation, and video work; these examples do
  not commit this increment to a video capability provider.
- Keep harness/account configuration global for the local operating-system
  user. Project-specific configuration is outside this increment.
- Return failures and available partial results to the caller. The caller or
  human chooses any retry, alternate account/model, workspace inspection, or
  worktree recovery. Automatic fallback and quota management are outside this
  increment.
- Discover available harnesses and usable account contexts with assistance
  where automatic discovery is insufficient.
- Prefer agent-assisted installation and configuration. Relay should expose
  configuration management operations that an agent can use; a rigid
  interactive initialization wizard is not the preferred direction. The exact
  operation surface and persistence boundaries remain undecided.
- Support local models on macOS directly through both Ollama and LM Studio in
  the first increment, without requiring Codex. Reuse a complete existing
  open-source harness or embeddable agent runtime for file and command
  execution. Building a new harness or model/tool loop is outside scope.
- Support communication beyond the initial delegated request: intermediate
  reports, questions, and follow-up instructions between the caller and each
  delegate. Direct peer messaging is outside this increment. Delivery semantics
  and the mapping to native steering/continuation remain to be resolved.

## Existing constraints and implementation findings

- ADR-0001 assigns workflow ownership to the caller. ADR-0002 defines one
  invocation against one delegate. A retry is not already part of that
  invocation contract.
- ADR-0004 anticipates multiple accounts or installations as route candidates
  and requires explicit resolution of ambiguity. It prohibits silent model,
  effort, or harness substitution.
- CLI, MCP, and the TypeScript client already expose the same broker contract
  to callers. New caller integrations do not necessarily need new adapters.
- The built-in execution adapters cover Claude and Codex. The current model
  catalog extends model selection for existing adapters; it does not add a new
  harness or account context.
- The selector has no account-context field. Generated route identifiers and
  the registry do not distinguish multiple instances of one adapter.
- Discovery probes inherit the broker environment. Native processes also
  inherit that environment with adapter-specific changes. Account selection
  must apply consistently to both discovery and execution; changing the
  environment of a later CLI client is insufficient.
- Authentication readiness is not proof of which account executes a request.
- Existing effect observations cannot establish that a failed invocation had
  no external effects. Relay reports its evidence and leaves retry and recovery
  decisions to the caller, including after a capacity failure.

Implementation findings were checked against `origin/main` at `62667b3`.
Relevant sources: `src/contract.ts`, `src/adapters/registry.ts`,
`src/adapters/discovery.ts`, `src/adapters/process.ts`, `src/model-catalog.ts`,
and `src/client.ts`.

## Domain terms

`CONTEXT.md` distinguishes an account from a harness connection. A connection
is a named native access context; its optional purpose is freely assigned by the
user. It does not bind a model or effort level and is not a workflow role.

## Settled scope

- Use reviewed built-in adapters for this increment and keep their internal
  boundaries extensible. A public third-party adapter/plugin contract, loader,
  and compatibility guarantees are deferred. Broader harness support does not
  require a plugin ecosystem in this increment.

- Multiple accounts are useful on their own; automatic switching is not needed
  to deliver this increment.
- Failures after partial work are returned to the caller without automatic
  retry, model substitution, or workspace recovery.
- Configuration is user-global, with no project-specific configuration layer
  in this increment.
- Agent-assisted setup remains the preferred direction. Concrete management
  operations have not yet been selected.
- Assisted setup supports registering existing native contexts and preparing
  additional contexts, followed by native user authentication.
- A connection contains access information and an optional purpose description,
  without model or workload presets.
- Without an explicit connection selection, preserve the normal native login.
  Provider and model remain explicit per-invocation inputs, with optional
  effort. Native parameter overrides must not edit saved default settings.
- The standalone Grok harness is the next adapter target; access through Cursor
  is not the intended integration.
- Both Ollama and LM Studio are included in the first local-model increment.
  Use the full Pi coding-agent SDK in a headless managed worker, without
  requiring Codex (ADR-0025).
- Local delegates are full agents. Their model/tool loop and coding tools come
  from the reused runtime, not a new Relay implementation.
- Communication is caller-to-delegate. Direct peer messaging is not required.
- Follow-up messages are delivered at the next supported processing boundary
  without automatically interrupting running commands. Acceptance and observed
  delivery are separate evidence; cancellation is a separate operation.
- Locality refers to model inference, with open local models such as suitable
  Kimi or GLM variants. Tool network access follows requested permissions;
  an entirely offline environment is not required.

## Native invocation parameter verification

Read-only verification on 2026-09-28 used official documentation and local CLI
help: Codex 0.155.1, Claude Code 2.1.282, and Grok 1.0.41. No authenticated model
invocations were executed for this check.

| Harness     | Model override  | Effort override                              | Documented scope                                                                                 |
| ----------- | --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Codex       | `--model MODEL` | `-c 'model_reasoning_effort="high"'`         | Single-run overrides                                                                             |
| Claude Code | `--model MODEL` | `--effort high`                              | Current session; effort explicitly does not persist                                              |
| Grok Build  | `--model MODEL` | `--reasoning-effort high` (`--effort` alias) | Headless flags override saved defaults; no explicit no-write guarantee was found for these flags |

Sources: [Codex one-off overrides](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Grok CLI reference](https://docs.x.ai/build/cli/reference), and
[Grok model guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md).

Grok additionally documents a `GROK_CONFIG` JSON overlay for harness/ACP clients
that supplies model defaults without writing a `config.toml` or relocating
`GROK_HOME`. This is an available mechanism, not a decision to use ACP:
[Grok configuration guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#injecting-config-with-grok_config).

Codex and Claude adapters already pass model and optional effort parameters.
Runtime qualification still needs to confirm account separation, supported
model/effort combinations, and unchanged saved defaults, particularly for Grok.
Unchanged defaults do not imply that native execution writes no session state.

## Native-context fixture qualification

The bounded native-context implementation selects Claude Code 2.1.282 through
`CLAUDE_CONFIG_DIR` and Codex CLI 0.155.1 through `CODEX_HOME`. Claude named
probes and runs load only the user settings source; unsupported selected-user
`apiKeyHelper` and nonempty `env` settings fail closed. Codex named routes use
the native OpenAI provider and reject parsed profile or provider overrides in
the selected home, the system config, and the invocation's working-directory
config layers. Codex's config order is documented in the
[loader at the exact tested source commit](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/config/src/loader/mod.rs);
the same commit's [authentication storage](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/login/src/auth/storage.rs)
and [authentication manager](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/login/src/auth/manager.rs)
are the references for native credential selection.

The regression suite runs two fake Codex contexts concurrently in separate
workspaces and checks project-config bypasses, inherited-key removal, and path
redaction. It does not execute a live authenticated model or verify that two
real account identities differ. Those claims remain unqualified until an
opt-in runtime run records the installed versions and harness-reported
identity evidence. Named labels and directories are not account identity
evidence.

## Technical follow-up

- Qualify the standalone Grok harness using its native machine-readable
  interface and verify its model availability and account-context behavior.
- Specify discovery, registration, validation, configuration updates, and the
  handoff to native authentication without Relay storing credentials.

## Remaining design and integration work

Integrate the selected full Pi SDK in a headless Relay-managed worker and
finalize dependency packaging. Neither a new Relay-owned agent loop nor a
mandatory Codex installation is acceptable. Match native events, approvals, questions, steering, continuation,
and cancellation to Relay's invocation contract. Do not equate queue acceptance
with model consumption. Local model execution must be verified rather than
inferred solely from a loopback server address.

### Local execution integration findings

The existing `Adapter` interface supports an embedded library without
`ProcessAdapter`; process adapters are alternatives. Broker lifecycle, event
persistence, partial results, workspace effects, and permission handling are
reusable. Relay has no coding-tool suite or model/tool loop, and must not build
these for this work. The selected full harness/runtime supplies them.

The adapter must distinguish native completion from an incomplete stream before
returning success. Runtime cancellation must stop its loop and tool process
trees; closing an HTTP connection alone does not prove that server inference
stopped. Existing permission responses only allow or deny sequential permission
requests and cannot carry general answers to a delegate's questions.

The contract must represent harness/runtime identity and execution policy
accurately: an inference server is not a model vendor. Tool validation or
approval prompts are not OS-level isolation. ADR-0015 permits a qualified
library adapter; its historical rejection of specific TanStack adapters was not
a ban on libraries or embedding a full harness. The recorded failures in that
spike are useful qualification cases, not current verdicts on other libraries.

### Current communication boundary

The broker already persists ordered progress events and exposes cursor-based
retrieval and following. These are observable when the caller reads them; they
do not guarantee that an arbitrary caller agent is awakened automatically.
Native session identifiers alone do not establish continuation support.

The current contract has no peer addressing, inbox, message acknowledgments, or
sender identity for a shared communication pool. `callerCorrelationId` is
grouping metadata, not an authenticated sender. Caller-to-delegate dialogue and
direct delegate-to-delegate messaging are therefore separate design choices.

These findings were checked against `origin/main` at `62667b3`, including
`src/operations.ts`, `src/broker.ts`, `src/contract.ts`, `src/client.ts`, and the
Claude, Codex, and process adapters.

### Local model feasibility

The required path is `Relay -> existing full OSS agent runtime -> Ollama or
LM Studio -> local model`. Pi is selected as the embedded full SDK in a
headless Relay-managed worker.
Neither local path requires a Codex installation.
Both local model runtimes are in the first increment.

Ollama provides model discovery, streaming chat, structured output, and tool-call
requests. The reused harness executes those tools and returns their results.
LM Studio also exposes local discovery and streaming APIs. Its native API can
execute MCP integrations; ordinary custom function calls still require a client
to execute tools. Neither API alone is the chosen full coding harness.

Sources: [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling),
[Ollama model listing](https://docs.ollama.com/api/tags),
[LM Studio native API](https://lmstudio.ai/docs/developer/rest),
[LM Studio streaming](https://lmstudio.ai/docs/developer/rest/streaming-events),
and [LM Studio MCP](https://lmstudio.ai/docs/developer/core/mcp).

Runtime support does not establish compatibility with every Kimi/GLM variant,
quantization, context size, or machine. Ollama can also route to cloud models;
the selected local route must actually run inference locally.

### Existing harness candidates

Research date: 2026-09-28. These are documentation/source findings, not runtime
qualification. Pi is now selected; the other candidates remain background
research. See the [pinned SDK qualification](pi-local-qualification.md) for
executed evidence and the limits of that evidence.

| Candidate       | Full agent execution                                                                                       | Integration boundary                                                             | Important qualification issue                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Pi coding agent | Existing coding tools, tool loop, sessions and context management; Ollama/LM Studio endpoint configuration | Embeddable Node SDK or bidirectional JSONL RPC subprocess                        | Permission hooks, subprocess teardown, recovery settings, released API and true completion events                |
| OpenCode        | Existing coding tools and agent loop; both local runtimes documented                                       | CLI JSON, server plus JS/TS SDK, or ACP; SDK still needs the OpenCode executable | Pin a released version; some steering/question evidence is from current v2 source rather than a verified release |
| Goose           | Existing Developer tools and agent loop; both local runtimes documented                                    | CLI, ACP, or server; its provider SDK alone is not the full harness              | Active steering currently uses an explicitly unstable ACP extension                                              |

Pi sources: [full SDK](https://pi.dev/docs/latest/sdk),
[RPC integration](https://pi.dev/docs/latest/cli-integration),
[local endpoint configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
[built-in tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/05-tools.ts),
and [package manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json).
The inspected manifest identifies `@earendil-works/pi-coding-agent` 0.87.1,
MIT, Node >=22.19.0. The isolated qualification now installs that exact npm
release; the production Relay package does not depend on it yet.
Pi provides `steer`, `followUp`, event subscriptions, abort, and session
persistence. Tool hooks can block execution; this is not a sandbox. Its default
recovery settings and event completion semantics require explicit qualification.

OpenCode sources: [providers](https://opencode.ai/docs/providers/),
[tools](https://opencode.ai/docs/tools/), [server](https://opencode.ai/docs/server/),
[SDK](https://opencode.ai/docs/sdk/), and [ACP](https://opencode.ai/docs/acp/).
Its TypeScript SDK talks to or starts a server process; it is not an embedded
full agent library. The project is MIT licensed. The documented local providers
and current v2 discovery/steering APIs must be checked against the chosen release.

Goose sources: [providers](https://goose-docs.ai/docs/getting-started/providers/),
[Developer tools](https://goose-docs.ai/docs/mcp/developer-mcp/),
[ACP](https://goose-docs.ai/docs/gdk/acp/),
[steering reference](https://goose-docs.ai/docs/gdk/acp/reference/), and
[SDK boundary](https://goose-docs.ai/docs/gdk/sdk/).
The project is Apache-2.0 licensed. Its separate Ollama Cloud provider must not
be mistaken for local inference.

Selection: use Pi as the complete headless agent runtime for local routes.
This avoids a separate harness installation and lets Relay own the worker
lifecycle. OpenCode remains a possible additional native adapter. Qualify the
pinned Pi release with both local model runtimes before publishing local routes.

The desired integration is headless: neither a graphical nor terminal user
interface is required. Favor the smallest practical integration of a complete
existing agent, rather than choosing by community size alone. Headless runtime
behavior and distribution size are separate considerations. The npm metadata
for `@earendil-works/pi-coding-agent` 0.87.1 reports 23,148,544 unpacked bytes for
the package alone, excluding dependencies, and includes `pi-tui` as a dependency.
Its SDK does not require presenting a terminal UI, but the distribution is not
a UI-free minimal core. No startup-time or memory benchmark has been run.

### Public adoption indicators

Live GitHub API snapshot on 2026-09-28:

| Project                                           |   Stars |  Forks |
| ------------------------------------------------- | ------: | -----: |
| [OpenCode](https://github.com/anomalyco/opencode) | 210,595 | 27,868 |
| [Pi](https://github.com/earendil-works/pi)        | 110,054 | 13,991 |
| [Goose](https://github.com/aaif-goose/goose)      |  54,738 |  6,336 |

All three repositories were unarchived and showed pushes on the snapshot date.
These figures measure repository interest, not active installations or model
quality. Pi's repository covers multiple packages, so the counts are not a
like-for-like measure of end-user CLI adoption.

[OpenCode's website](https://opencode.ai/) reports over 16 million monthly
developers and 950 contributors. This is a publisher-reported figure, not an
independently verified metric or a comparable three-project usage dataset.
The inspected Pi and Goose homepages do not provide comparable monthly active
user counts. OpenCode therefore has the strongest observed public-repository
visibility of these candidates, while the embedding versus external-harness
tradeoff remains a separate selection criterion. No runtime choice is made by
these popularity figures.

## Implementation qualification checklist

- Keep the normal native login usable without registering an additional
  connection. Adding a connection must not change the default route selection.
- Run two connections for the same harness independently, including concurrent
  invocations. Discovery and execution must use the same selected native
  context and must not inherit conflicting authentication from another one.
- Preserve explicitly requested model and effort values. Verify that an
  invocation override does not alter saved model or effort defaults.
- Report native authentication evidence at the strength actually observed;
  a user-assigned name alone does not establish the account identity.
- Verify that registering an existing context and preparing an additional
  context preserve existing native credentials and settings.
- Return errors and partial outcomes without retrying another connection or
  model. Never convert an unknown error into an asserted quota failure.
- Exercise Grok discovery, streaming output, terminal success and failure,
  cancellation, timeout, and policy mapping before advertising a qualified
  route.
- Qualify direct Ollama and LM Studio routes independently, including model
  discovery, streaming, failures, cancellation, and supported model
  capabilities. Do not assume identical behavior from similar API shapes.
