# Contract reference

The bridge has three versioned surfaces: the invocation schemas and operation
description use schema/operations version `1.0`, and local Unix-socket IPC uses
protocol `1.0`. `system.describe` is the source of truth for the operation
list and broker configuration; `route.discover` is the source of truth for
route descriptors. The JSON files in
[`schemas/`](../schemas/) are the machine-readable contract.

## Operations

| Operation                    | Purpose                                                           | Next affordances                         |
| ---------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `system.describe`            | Describe versions, operations, and settings                       | —                                        |
| `system.status`              | Inspect broker readiness, counts, and environment names           | `broker stop`                            |
| `system.shutdown`            | Stop the broker, optionally forcing active work to interrupt      | —                                        |
| `route.discover`             | Discover qualified and authenticated routes                       | `invocation.start`                       |
| `connection.discover`        | Refresh default and named routes with safe registration summaries | `connection.inspect`                     |
| `connection.list`            | List registered native contexts without private references        | `connection.inspect`                     |
| `connection.inspect`         | Refresh route readiness evidence for one registration             | `invocation.start`                       |
| `connection.register`        | Register an existing native context                               | `connection.inspect`                     |
| `connection.prepare`         | Prepare a private context and return user-owned login steps       | `connection.inspect`                     |
| `connection.update`          | Update a registration using its expected revision                 | `connection.inspect`                     |
| `connection.remove`          | Remove only the registration using its expected revision          | —                                        |
| `invocation.start`           | Resolve one route and enqueue one invocation                      | `invocation.events`, `invocation.cancel` |
| `invocation.list`            | List lightweight retained summaries and optional tombstones       | `invocation.inspect`                     |
| `invocation.inspect` / `get` | Read state, policy, route, and event cursor                       | `invocation.events`, `invocation.cancel` |
| `invocation.events`          | Read events after a cursor, with bounded long polling             | repeat with `nextCursor`                 |
| `invocation.wait`            | Wait for terminal state with a maximum 30-second poll             | `invocation.result`                      |
| `invocation.result`          | Read the immutable terminal outcome                               | —                                        |
| `invocation.cancel`          | Request cancellation of active work                               | `invocation.events`                      |
| `invocation.respond`         | Allow or deny a pending permission request                        | `invocation.events`                      |
| `invocation.answer`          | Answer a pending free-form delegate question                      | `invocation.events`                      |
| `invocation.send`            | Queue additional input for an active native session               | `invocation.events`                      |
| `invocation.continue`        | Start a linked invocation from a retained native session          | `invocation.events`, `invocation.cancel` |

An invocation request contains a model-first `selector`, one or more typed
`input` content parts, an absolute `workingDirectory`, an interaction strategy,
and a requested policy. `selector.via` disambiguates harness family without
turning a provider into a harness. Optional `selector.connectionId` selects one
user-global native context. Omitting it keeps the harness's normal login even
when named connections are registered. Discovery accepts the same
`connectionId`; its named route IDs and `connectionRevision` identify the
registration snapshot used for resolution. The native context reference stays
inside the broker and qualified adapter. Route resolution never silently
substitutes the requested model, effort, harness, or connection.

Optional `selector.runtimeId` selects one configured local model server. It is
independent of the native account selector. Local routes keep `provider` as the
model vendor (`unknown` when unestablished), `via`/`adapter` as `pi`, and
`inferenceServer` as `ollama` or `lm-studio`. `inferenceLocation` is `local`
when the server runs the model, `remote` for an Ollama cloud model that the
server forwards to ollama.com, and absent when the metadata does not establish
it (ADR-0027). `modelVendorEvidence` qualifies the
vendor claim. `runtimeId`, `runtimeRevision`, and any `modelDigest` or
`runtimeInstanceId` remain in the resolved route and persisted invocation
metadata. Discovery and preflight bind the exact model snapshot; a stale route
fails instead of silently adopting refreshed metadata. Catalog aliases may
name an existing local model but cannot synthesize an executable local route.
See [local model setup](local-models.md) for readiness and assurance limits.

## Route guidance and billing

A route descriptor may carry two optional fields that help a caller choose
among routes. Route resolution reads neither, and neither is qualification
evidence (ADR-0026).

`guidance` is editorial advice about the model behind the route:

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `tier`      | `frontier`, `strong`, `balanced`, or `fast`, from most to least capable   |
| `strengths` | Tasks the model particularly suits, such as `computer-use`                |
| `source`    | `built-in` for the adapter manifest, `user-declared` for the user catalog |
| `asOf`      | ISO date of the assessment; always present for built-in guidance          |

A strength describes the model. It does not add a capability: `capabilities`
remain the only statement of what the route can do. A route without
`guidance` has an unknown tier. Built-in routes list `efforts` from lowest to
highest.

`billing` reports how use of the route is paid for:

| `mode`         | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `local`        | Inference runs on the user's hardware; no charge per use |
| `subscription` | A flat-rate login that draws on a usage cap              |
| `metered`      | Charged per use, for example an API key                  |
| `unknown`      | Not established                                          |

`billing.evidence` is `reported` when the mode comes from the harness's own
authentication status, `inferred` for a ready local route, and `unverified`
for `unknown`. A ready Ollama cloud route is `metered` with evidence
`inferred`: Ollama prices every cloud request per token, and Relay does not
read the account's plan. Claude Code reports a claude.ai subscription login; Codex
reports a ChatGPT login or an API key. Any other login, and every route that
is not ready, is `unknown`. The status output is classified during discovery
and not retained.

The user catalog in `config.json` declares or replaces guidance. An entry
under `adapters.<adapter>.guidance` is keyed by the requested or canonical
model. A model defined under `adapters.<adapter>.models` takes its own
`guidance` and never inherits one; an alias keeps the guidance of its target.

```json
{
  "adapters": {
    "pi": { "guidance": { "qwen3:8b": { "tier": "fast" } } },
    "codex": {
      "guidance": {
        "gpt-6.1-sol": { "tier": "balanced", "strengths": ["refactoring"], "asOf": "2026-10-02" }
      }
    }
  }
}
```

An invalid tier, strengths list, or date fails discovery with
`invalid_request`.

Connection management operations share the same broker API across IPC, the
typed client, CLI, and MCP. `connection.discover` includes default and named
route observations plus redacted registration summaries; `connection.list`
returns only summaries. `connection.inspect` refreshes readiness for one
registration. Readiness is route evidence, not proof of account identity.
`connection.register` accepts an existing readable native context and is
idempotent when the stable ID and settings are unchanged. `connection.prepare`
creates an empty private context directory and returns its path and structured
`executable`/`args`/`env` login instructions in that explicit setup response;
Relay does not start the native login or copy credentials. Updates and removals
require the current registration revision. Removing a registration does not
delete its native context or credentials.

## State machine

```text
queued → running → waiting_for_input → running
   │        │              │             │
   ├────────┴──────────────┴─────────────┴──→ cancelling → terminal
   └────────────────────────────────────────→ terminal
```

`waiting_for_input` is reachable only through adapters exposing a response
channel: Claude's orchestrator permission route in this release, and the
development-only fake question fixture (registered with
`HARNESS_RELAY_FAKE_ROUTES=1`). Permission requests use `invocation.respond`
with only `allow` or `deny`. General delegate questions use `invocation.answer`
with caller-provided content parts. They are separate request kinds and cannot
be answered through one another's operation. Deny and unattended routes do not
enter the permission response state.

Terminal states are `succeeded`, `failed`, `cancelled`, `timed_out`, and
`interrupted`. A broker restart produces `interrupted`; a timeout produces
`timed_out`; caller cancellation produces `cancelled`. A forced broker
shutdown marks active records `interrupted` with a `broker_shutdown` error.
Terminal records have one immutable outcome and remain queryable until
retention evicts them.

## Events and cursors

Every event has the schema version, bridge-owned invocation ID, contiguous
sequence, ISO timestamp, provenance, and an opaque cursor of the form
`v1:<sequence>`. Categories are `lifecycle`, `activity`, `output`, `diagnostic`,
`effect`, `usage`, `input_required`, `input_answered`, `input_accepted`,
`input_delivered`, `input_delivery_failed`, and `input_expired`.

`invocation.events` returns events strictly after `after`. `waitMs` is bounded
to 30 seconds. Empty pages are normal when the invocation is still active; the
caller repeats the request using `nextCursor`. The CLI `--follow` and typed
client `follow()` implement this loop. Events are append-only and their native
payload is bounded by default.

An `input_required` event includes a stable request ID, `kind` (`permission` or
`question`), and prompt. Permission requests may also include a tool name. The
caller answers the matching kind only; unknown, already-answered, or expired
request IDs are rejected rather than guessed.
The caller must poll or follow the event stream to observe updates; the relay
does not guarantee waking or notifying an arbitrary host agent.

`invocation.send` is a separate operation for active-session steering. The
broker records `input_accepted` and returns immediately with delivery `pending`.
It sends accepted inputs in FIFO order per invocation. `input_delivered` is
recorded only after the adapter acknowledges acceptance at a native session
boundary. The evidence says the input reached that boundary; it does not prove
that the model consumed or acted on it. Sending input does not cancel or
interrupt a running native tool call; it waits for a boundary supported by the
route. Use `invocation.cancel` to request cancellation. Failed delivery and input left pending
at cancellation, terminal completion, or broker restart are recorded as
`input_delivery_failed` or `input_expired`. Repeating an identical send with
the same per-invocation idempotency key returns its existing input ID; reusing
that key for different content is a conflict. Native send is available only
when both the route capability and adapter handler are implemented. The
development-only fake fixture exercises this contract in the test suite. The
private Pi 1.0.0 worker implements text-only native steering through
`AgentSession.steer(text)` and returns its delivery ACK only after the SDK
accepts the message into its queue. Pinned-SDK integration tests cover FIFO
delivery across a running shell command and the following model requests. This does not establish model consumption or qualify
a live local model. Configured local Pi routes expose the supported worker
capabilities through the default registry. Only ready Ollama routes advertise
text-only `steering`; a combined wrapper/SDK fixture covers early input,
profile removal during an active run, the native SDK acknowledgement, and the
following model requests. This does not establish model consumption or live
model competence. The current Claude and Codex adapters do not implement
native steering. See [local model setup](local-models.md).

`invocation.continue` is a separate operation that creates a new invocation
linked by `continuedFrom`; it never changes the predecessor's terminal outcome.
The broker clones the predecessor's selector, strategy, requested policy, and
workspace, replacing only the input and idempotency key. The adapter-owned
continuation handle is not caller supplied or exposed through IPC. Before
continuing, the broker freshly resolves the original request and rejects a
changed or ambiguous route, requested effort/strategy, account revision, or
effective policy. Missing or expired native handles and routes without the
continuation capability fail explicitly; the broker does not restart without
the retained session or fall back to a different route. Ready local Pi routes
advertise native continuation; the current Claude and Codex adapters do not.
Scripted Pi SDK fixtures verify the retained-session boundary; live local-model
qualification remains separate.

## Outcomes

`content` is the delegate's returned answer. `artifacts` are returned content
references. `effects` are observed workspace changes (`created`, `modified`,
`deleted`, `renamed`, or `unknown`) with evidence marked as `git-status` or
`harness-reported`. Harness-reported paths inside `workingDirectory` are
normalized to relative paths; paths outside it remain absolute and carry
`outsideWorkspace: true`. Git-observed paths are workspace-relative.
`effectObservation.complete` and its diagnostics say when the before/after
snapshot was incomplete.

`observedIdentity` keeps provider, model, harness version, and native session
ID separate from the requested and resolved identities. Each value carries
`unverified`, `inferred`, `reported`, or `verified` evidence. The bridge never
copies a requested model into observed identity. `usage` is included only when
the adapter reports it. `policy` records the requested policy, native controls,
and assurance (`none`, `native`, or `isolated`). Native assurance is not a
sandbox claim; this release does not implement isolation.

## Listing and retention

`invocation.list` can filter by `state`, exact `callerCorrelationId`, and
`since`, with a limit of at most 1000. Results contain only IDs, selectors,
route ID, timestamps, working directory, state, and correlation metadata.
`includeTombstones` returns IDs evicted by retention without exposing their
payloads. Completed records are retained by age and total byte budget at
invocation granularity.

Named native connections are stored user-globally in
`connections.json` beside the Relay user configuration file (under
`XDG_CONFIG_HOME`, or `~/.config` by default). The file stores adapter
references and optional purpose text, never copied credentials. Registration
updates use a bounded cross-process lock and atomic file replacement. Direct
store writes use a snapshot-token compare-and-swap; stale updates return
retryable `connection_conflict` errors. A lock left by a terminated writer is
not removed automatically. The bounded timeout reports the owner PID when
available and asks the caller to verify that no writer is active before manual
recovery. A running invocation keeps the connection revision it resolved, so
a later update or removal cannot retarget it.

The default state layout is a private directory containing a manifest,
per-invocation metadata, append-only events, outcomes, and tombstones. Native
payloads are omitted or bounded unless diagnostic mode is explicitly enabled.

The broker captures its process environment when it starts. Harness processes
inherit that broker environment after bridge-internal and adapter-declared
session variables are removed; a later shell export is therefore picked up by
`broker restart`, not by an already-running broker. `system.status` exposes the
sorted names of variables present in the broker environment for diagnostics,
never their values.

## Errors and exit codes

Every IPC failure has `code`, `message`, `retryable`, and optional diagnostic
`details`. The CLI maps errors to stable codes: `0` success, `1` execution or
internal failure, `2` invalid request, `3` broker unavailable, `4` invocation
not found/evicted/not terminal, `5` route unavailable or ambiguous, and `6`
invocation or connection conflict. `connection_conflict` covers a stale
snapshot, revision, or active registration lock. `run` additionally maps terminal `cancelled`, `timed_out`,
and `interrupted` outcomes to non-zero statuses.

Callers may retry errors marked `retryable` after observing their details.
`route_unavailable` details include candidate diagnostics; human CLI mode keeps
those diagnostics visible instead of reducing them to a single message.

## Versioning

Adding optional fields or a new operation keeps the version. Removing or
changing field meaning requires a new schema or operations version. IPC clients
must send the exact supported protocol version. Adapters may expose different
capabilities, but every normalized event and outcome follows this contract.
