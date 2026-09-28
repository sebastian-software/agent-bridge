# Adapter authoring guide

An adapter translates one reviewed harness contract into the bridge's stable
operations, events, and outcomes. It must not become an alternate broker or
copy caller assertions into observed identity.

## SPI choice

Use `Adapter` directly when the harness is an in-process library or needs a
protocol that cannot be represented as one supervised process. Implement
`discover()`, `run()`, and, when policy mapping is possible, `resolvePolicy()`.

## Dialogue capabilities

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

Terminal continuation is separate. A successful `run()` may return an opaque
`continuationHandle` owned and interpreted by that adapter. The bridge retains
it internally and passes it back only to the adapter for a linked invocation;
never include it in events, routes, diagnostics, or caller input. Advertise
`continuation` only when the adapter can resume that exact native session.
Continuation must not fall back to a new context-free request. Broker fixtures
exercise the SPI, but native support requires its own qualification evidence.

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
- model entries with `efforts`, `capabilities`, and supported
  `interactionStrategies`;
- a `policySupport` table for filesystem, commands, network, and additional
  directories; and
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

Discovery records the absolute executable, observed version, authentication
readiness, diagnostics, and a qualification record. Missing executables are
unavailable; out-of-range versions are unqualified. Neither is silently
treated as a usable route.

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
