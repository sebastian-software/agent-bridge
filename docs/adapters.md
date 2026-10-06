# Adapter authoring guide

An adapter translates one reviewed harness contract into the bridge's stable
operations, events, and outcomes. It must not become an alternate broker or
copy caller assertions into observed identity.

## SPI choice

Use `Adapter` directly when the harness is an in-process library or needs a
protocol that cannot be represented as one supervised process. Implement
`discover()`, `run()`, and, when policy mapping is possible, `resolvePolicy()`.

## Local inference through Pi

The default registry includes `LocalPiAdapter`, which exposes routes only for
explicit user-global `localRuntimes` profiles. It delegates agent execution to
the pinned full Pi SDK worker; Ollama and LM Studio are inference servers, not
replacement harnesses. Discovery reports exact model identity and readiness.
Ollama tool-capable nonremote models can execute with assurance `none`; LM
Studio models remain unqualified for local execution because loaded metadata
does not establish locality. Ollama cloud models execute through the same path
when the server is signed in to ollama.com, and their routes report
`inferenceLocation: "remote"`. Ollama routes take their `efforts` from the
thinking levels in `/api/show`; Pi sends the selected one as
`reasoning_effort` and is configured so that it cannot clamp an unlisted level
to a neighbor. See [local model setup](local-models.md).

Adapters with mutable configuration can implement `discoveryCacheKey()` to
invalidate the registry's cached route inventory after configuration changes.
They must still revalidate the captured route before execution and preserve
bindings for active invocations. Discovery refresh is not permission to move an
active invocation or its input channel to a new native session.

## Dialogue capabilities

See [native dialogue support](native-dialogue.md) for the capability matrix,
caller examples, and the distinction between delivery and model consumption.

`invocation.respond` is reserved for permission requests and accepts only
`allow` or `deny`. An adapter that asks a general question emits an
`input_required` request with `kind: "question"` and waits through
`AdapterRunContext.awaitAnswer`; that caller answer is a distinct operation.
Do not encode a question as a permission request.

Active-session steering is opt-in through both the route's `steering`
capability and `Adapter.sendInput`. The handler promise resolves only after the
native session API acknowledges a supported boundary. A write to process stdin
alone is not delivery evidence, and the acknowledgement does not prove that the
model consumed the input. The broker delivers accepted inputs in FIFO order per
invocation. If the native adapter has no session-level acknowledgement or
cannot preserve that order, omit the capability and handler.
The handler must honor its `AbortSignal` and settle its work when aborted.
`Broker.close()` waits for in-flight delivery tasks, so an uncooperative handler
can prevent shutdown; adapter qualification must exercise this cancellation
boundary.

Terminal continuation is separate. A successful `run()` may return an opaque
`continuationHandle` owned and interpreted by that adapter. The bridge retains
it internally and passes it back only to the adapter for a linked invocation;
never include it in events, routes, diagnostics, or caller input. Advertise
`continuation` only when the adapter can resume that exact native session.
Continuation must not fall back to a new context-free request. Broker fixtures
exercise the SPI, but native support requires its own qualification evidence.

A `ProcessAdapter` returns the handle from `continuationHandleFor()`, which runs
only after a successful native result. The Codex adapter uses it from version
0.159.2: a continuable run omits `--ephemeral`, its handle is the native
thread ID from `thread.started`, and a continuation runs
`codex exec fork <thread-id>`. `exec fork` accepts neither `--sandbox`, `--cd`,
nor `--add-dir`, so the adapter sets the sandbox through `-c sandbox_mode=...`,
relies on the broker's working directory, and keeps runs with additional
directories ephemeral and without a handle.

The Claude adapter uses the same hook from version 2.1.282. Its handle is the
`session_id` from the stream, and a continuation appends
`--resume <session-id> --fork-session` to the original arguments. Named Claude
connections keep `CLAUDE_CONFIG_DIR`, so the fork reads the session from the same
native context.

Extend `ProcessAdapter` for a command-line harness that emits JSONL. Provide a
manifest-backed `discover()`, a safe argument-array `command()`, and a
`normalizeNative()` function. The base class owns stdin, stderr bounds,
process-group cancellation, timeout grace, JSONL parsing, lifecycle events,
and terminal error handling. A normalizer must mark a qualified native success
event with `data.state: "native_result"`; a clean process exit without that
marker is an incomplete failed invocation. Native failure markers should carry
the adapter event's `failure` detail so the bridge preserves observed output
and identity alongside the error.

## Manifest fields

`AdapterManifest` contains:

- `id`, `provider`, `via`, and executable `command`;
- `versionArgs` and `authArgs` probes;
- a semver `qualifiedVersionRange` and `authenticationMode`;
- model entries with `efforts` (lowest first), `capabilities`, supported
  `interactionStrategies`, and optional `guidance`;
- a `policySupport` table for filesystem, commands, network, and additional
  directories;
- optional `versionCapabilities`, which add capabilities only when the detected
  harness version satisfies their own range;
- an optional `billingFromAuthStatus` classifier for the output of the
  `authArgs` probe; and
- a precise `qualificationClaim` describing the contract covered by the
  qualification suite.

Model entries also declare one canonical native model ID and optional request
aliases. Discovery publishes one route for the canonical ID and one for each
alias; built-in native aliases such as `opus` remain in the requested
`model` and are passed through to the harness. A user model catalog adds
`nativeModel` to the route, so the declared native ID is passed to the
harness while the requested alias remains in `model`. `canonicalModel` is an
expected-resolution hint for route metadata; the observed runtime model is
recorded separately from both values.

Model `guidance` is an editorial assessment with a tier, strengths, and an
`asOf` date. Review it with every manifest change, and leave it out for a
model that is kept only for callers that still request it. A strength must
not stand in for a capability the route has not been qualified for.
`billingFromAuthStatus` returns a mode only for a status output that was
observed on a qualified harness version and returns `unknown` otherwise.
Discovery passes it the probe output and discards the output afterwards.

Discovery records the absolute executable, observed version, authentication
readiness, diagnostics, and a qualification record. Missing executables are
unavailable; out-of-range versions are unqualified. Neither is silently
treated as a usable route.

## Named native contexts

The built-in Claude Code and Codex adapters support explicitly selected native
configuration directories within a narrower version range than the default
route. An unselected request keeps
the normal native login behavior. A named route's `ready` state means its
native authentication probe succeeded under the selected context; it does not
identify the account that a later invocation used. Runtime identity remains
unverified unless the harness reports it.

Named Claude Code contexts use `CLAUDE_CONFIG_DIR` for the probe and invocation
and pass `--setting-sources user` to both. Project and local settings therefore
do not participate. A selected user `settings.json` with `apiKeyHelper` or a
nonempty `env` block is unavailable until it is removed; inherited shell auth,
provider, and session selectors are also filtered from named child processes.
This behavior was qualified on Claude Code 2.1.282; named contexts accept
`>=2.1.282 <3.0.0`.

Named Codex contexts use `CODEX_HOME`, filter inherited auth/profile selectors,
and force `model_provider="openai"` for the invocation. Before discovery and
again before each named run, Relay parses the installed Codex configuration
sources with TOML: the system config, the selected home config, the working
directory `config.toml`, and `.codex/config.toml` files on both lexical and
canonical working-directory ancestor paths. A profile selector, a non-native
`model_provider`, any `model_providers` table, invalid TOML, or a config that
cannot be inspected makes the named route unavailable. The CLI loads project
configuration above `CODEX_HOME`, so the invocation check is required even
when discovery had no working directory. This behavior was first qualified on
Codex CLI 0.155.1, using the [pinned loader](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/config/src/loader/mod.rs)
and its [pinned authentication storage](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/login/src/auth/storage.rs).
Named contexts accept `>=0.155.1 <1.0.0`. On 0.159.2, a named connection to an
authenticated `CODEX_HOME` completed a live invocation and a continuation.
Discovery reports any version outside these ranges as unqualified.

Fixture tests exercise separate named Codex homes concurrently, scrubbed
inherited credentials, configuration precedence, and private-path redaction.
They do not use live credentials or prove that two real accounts are distinct.
No real second-account invocation or identity observation has been qualified;
that remains an opt-in runtime qualification task. Machine-managed policy and
real-account behavior are outside the fixture evidence.

## Grok Build

The Grok adapter speaks ACP v1 to `grok agent --no-leader stdio` for Grok Build
`>=1.0.44 <2.0.0`. It was fixture-tested on 1.0.44 and live-qualified on 1.0.46
with the default login; see the
[qualification record](qualification/2026-10-02-grok-build-1.0.46.md).

Discovery runs the read-only `grok models` listing in the selected context. A
route is `ready` only when Grok reports a logged-in account and lists the model;
an unauthenticated context or an unreadable listing makes every route
unavailable, and an unlisted model is unavailable on its own. Run against an
empty `GROK_HOME`, `grok models` creates Grok's default directory layout there.

Grok 1.0.46 ignores `--model`, `--always-approve`, and `--permission-mode` when
they precede the `agent` subcommand, so every native control follows it. The
model is also selected with ACP `session/set_model` after checking it against
the session's available models, and the `modelId` in the prompt result must
match; otherwise the invocation fails instead of reporting another model.
Effort uses `agent --reasoning-effort`. Usage comes from the prompt result's
token counts and any reported cost.

Grok executes its own tools; Relay advertises no ACP client filesystem or
terminal methods, and any such reverse request fails the invocation. Under
`unattended`, `agent --always-approve` lets Grok edit files and run commands
without asking. Under `deny`, Relay answers each `session/request_permission`
with Grok's reject option; Grok then ends the turn, and the invocation fails
with `harness_failed` and reason `permission_denied`. `orchestrator` and
filesystem, command, or network restrictions are unsupported, so the
descriptor claims assurance `none`. Effects come from the broker's workspace
observation.

Grok runs each tool command as its own process-group leader, so terminating the
agent's group alone leaves tools running. On cancellation or timeout the adapter
first sends ACP `session/cancel`, which stops the running tool, and waits up to
two seconds for the turn to settle. It then terminates the agent's process
group and every descendant process group it recorded before signalling.

Session updates that arrive before `session/new` returns its ID are held and
validated once the ID is known. A fixture also confirms that after an accepted
prompt write, a native process can close its stdin read end without the parent
Writable emitting `close` or `error` while the process stays alive. Such runs
settle through the caller's timeout or cancellation signal; the adapter does
not impose a default prompt deadline.

Named Grok contexts use `GROK_HOME` for version probing, discovery, and
invocation, and the adapter removes inherited Grok and xAI authentication or
model override variables before launching the child. It rejects config entries
for external auth commands, per-model credentials or headers, and non-xAI
endpoints. A context that is not logged in is unavailable; Relay never falls
back to the default login.

## Normalization rules

Map native messages to the smallest useful bridge category:

| Native observation                     | Bridge category  |
| -------------------------------------- | ---------------- |
| assistant answer or final text         | `output`         |
| command/tool/reasoning progress        | `activity`       |
| stderr or malformed/unsupported detail | `diagnostic`     |
| reported token/cost counters           | `usage`          |
| native file/tool changes               | `effect`         |
| approval or input request              | `input_required` |

Assign identity values only from the harness's observed fields. A requested
model, provider, or session ID is not evidence on its own. Preserve native
payloads only when useful and within the bridge bounds. Return the final
content once; duplicate native final messages must not duplicate the outcome.

Policy mapping must report unsupported controls explicitly. Never claim
`isolated` assurance when the harness only supplies native permission flags.
Use `deny` for explicit rejection, `unattended` only for a qualified native
non-interactive mode, and `orchestrator` only when a request can pause and
resume through `awaitInput`.

## Required tests

Every adapter should add:

1. discovery fixtures for executable, version, authentication, model, and
   qualification evidence;
2. recorded-stream normalizer fixtures covering output, activity, diagnostic,
   usage, effect, identity, and malformed output;
3. fake-harness lifecycle scenarios for success, failure, timeout, cancellation,
   truncation, and process-tree teardown; and
4. a policy-mapping table test for every supported and rejected control; and
5. process teardown tests proving malformed, incomplete, cancelled, and
   timed-out streams do not leave descendants running.

Run the shared suite with `pnpm check`. Do not test only happy-path text: an
adapter that cannot distinguish an incomplete stream from success is not
qualified.

## Version qualification checklist

- Pin the command and argument contract used by the adapter.
- Record the tested harness version and a semver range, not only a major.
- Record a stable qualification ID, test date, test-suite path, and the exact
  test commit or tag in the manifest. Discovery adds the observed installed
  version to the claim without changing the static `testedAt` evidence.
- Keep the static manifest claim limited to what the suite actually verifies:
  discovery, argument construction, and normalizer fixtures do not prove that
  a real harness or model was executed.
- If an opt-in run against an installed harness is performed, record its
  observed harness version and model IDs in a separate runtime qualification
  record. Never synthesize that record from discovery or overwrite the static
  `testedAt`/`testCommit` facts.
- Verify authentication without exposing credentials or placing them in argv.
- Exercise every advertised model, effort, capability, and interaction mode.
- Verify stdin behavior, bounded native output, identity evidence, usage, and
  workspace effects.
- Abort a long-running invocation and confirm the complete process tree exits.
- Confirm malformed and truncated streams become failed or degraded outcomes.
- Add the qualification claim and update the route manifest and docs together.
