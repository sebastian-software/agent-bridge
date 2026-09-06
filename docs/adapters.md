# Adapter authoring guide

An adapter translates one reviewed harness contract into the bridge's stable
operations, events, and outcomes. It must not become an alternate broker or
copy caller assertions into observed identity.

## SPI choice

Use `Adapter` directly when the harness is an in-process library or needs a
protocol that cannot be represented as one supervised process. Implement
`discover()`, `run()`, and, when policy mapping is possible, `resolvePolicy()`.

Extend `ProcessAdapter` for a command-line harness that emits JSONL. Provide a
manifest-backed `discover()`, a safe argument-array `command()`, and a
`normalizeNative()` function. The base class owns stdin, stderr bounds,
process-group cancellation, timeout grace, JSONL parsing, lifecycle events,
and terminal error handling.

## Manifest fields

`AdapterManifest` contains:

- `id`, `provider`, `via`, and executable `command`;
- `versionArgs` and `authArgs` probes;
- a semver `qualifiedVersionRange` and `authenticationMode`;
- model entries with `efforts`, `capabilities`, and supported
  `interactionStrategies`;
- a `policySupport` table for filesystem, commands, network, and additional
  directories; and
- a precise `qualificationClaim` describing the tested native contract.

Model entries also declare one canonical native model ID and optional request
aliases. Discovery publishes one route for the canonical ID and one for each
alias; resolution keeps the requested ID in `model` and passes that requested
ID to the harness. `canonicalModel` remains an expected-resolution hint for
route metadata; the harness may resolve an alias differently, so the observed
runtime model is recorded separately from both values.

Discovery records the absolute executable, observed version, authentication
readiness, diagnostics, and a qualification record. Missing executables are
unavailable; out-of-range versions are unqualified. Neither is silently
treated as a usable route.

## Normalization rules

Map native messages to the smallest useful bridge category:

| Native observation | Bridge category |
| --- | --- |
| assistant answer or final text | `output` |
| command/tool/reasoning progress | `activity` |
| stderr or malformed/unsupported detail | `diagnostic` |
| reported token/cost counters | `usage` |
| native file/tool changes | `effect` |
| approval or input request | `input_required` |

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
4. a policy-mapping table test for every supported and rejected control.

Run the shared suite with `pnpm check`. Do not test only happy-path text: an
adapter that cannot distinguish an incomplete stream from success is not
qualified.

## Version qualification checklist

- Pin the command and argument contract used by the adapter.
- Record the tested harness version and a semver range, not only a major.
- Record a stable qualification ID, test date, test-suite path, and the exact
  test commit or tag in the manifest. Discovery adds the observed installed
  version to the claim without changing the static `testedAt` evidence.
- Verify authentication without exposing credentials or placing them in argv.
- Exercise every advertised model, effort, capability, and interaction mode.
- Verify stdin behavior, bounded native output, identity evidence, usage, and
  workspace effects.
- Abort a long-running invocation and confirm the complete process tree exits.
- Confirm malformed and truncated streams become failed or degraded outcomes.
- Add the qualification claim and update the route manifest and docs together.
