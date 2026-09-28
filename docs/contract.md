# Contract reference

The bridge has three versioned surfaces: the invocation schemas and operation
description use schema/operations version `1.0`, and local Unix-socket IPC uses
protocol `1.0`. `system.describe` is the source of truth for the operation
list and broker configuration; `route.discover` is the source of truth for
route descriptors. The JSON files in
[`schemas/`](../schemas/) are the machine-readable contract.

## Operations

| Operation                    | Purpose                                                      | Next affordances                         |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `system.describe`            | Describe versions, operations, and settings                  | —                                        |
| `system.status`              | Inspect broker readiness, counts, and environment names      | `broker stop`                            |
| `system.shutdown`            | Stop the broker, optionally forcing active work to interrupt | —                                        |
| `route.discover`             | Discover qualified and authenticated routes                  | `invocation.start`                       |
| `invocation.start`           | Resolve one route and enqueue one invocation                 | `invocation.events`, `invocation.cancel` |
| `invocation.list`            | List lightweight retained summaries and optional tombstones  | `invocation.inspect`                     |
| `invocation.inspect` / `get` | Read state, policy, route, and event cursor                  | `invocation.events`, `invocation.cancel` |
| `invocation.events`          | Read events after a cursor, with bounded long polling        | repeat with `nextCursor`                 |
| `invocation.wait`            | Wait for terminal state with a maximum 30-second poll        | `invocation.result`                      |
| `invocation.result`          | Read the immutable terminal outcome                          | —                                        |
| `invocation.cancel`          | Request cancellation of active work                          | `invocation.events`                      |
| `invocation.respond`         | Allow or deny a pending permission request                   | `invocation.events`                      |
| `invocation.answer`          | Answer a pending free-form delegate question                 | `invocation.events`                      |
| `invocation.send`            | Queue additional input for an active native session          | `invocation.events`                      |
| `invocation.continue`        | Start a linked invocation from a retained native session     | `invocation.events`, `invocation.cancel` |

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

## State machine

```text
queued → running → waiting_for_input → running
   │        │              │             │
   ├────────┴──────────────┴─────────────┴──→ cancelling → terminal
   └────────────────────────────────────────→ terminal
```

`waiting_for_input` is reachable only through adapters exposing a response
channel: the fake permission and question fixtures and Claude's orchestrator
permission route in this release. Permission requests use `invocation.respond`
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

`invocation.send` is a separate operation for active-session steering. The
broker records `input_accepted` and returns immediately with delivery `pending`.
It sends accepted inputs in FIFO order per invocation. `input_delivered` is
recorded only after the adapter acknowledges acceptance at a native session
boundary. The evidence says the input reached that boundary; it does not prove
that the model consumed or acted on it. Failed delivery and input left pending
at cancellation, terminal completion, or broker restart are recorded as
`input_delivery_failed` or `input_expired`. Repeating an identical send with
the same per-invocation idempotency key returns its existing input ID; reusing
that key for different content is a conflict. Native send is available only
when both the route capability and adapter handler are implemented. The fake
fixture exercises this contract; current native adapters do not advertise
active-session input support.

`invocation.continue` is a separate operation that creates a new invocation
linked by `continuedFrom`; it never changes the predecessor's terminal outcome.
The broker clones the predecessor's selector, strategy, requested policy, and
workspace, replacing only the input and idempotency key. The adapter-owned
continuation handle is not caller supplied or exposed through IPC. Before
continuing, the broker freshly resolves the original request and rejects a
changed or ambiguous route, requested effort/strategy, account revision, or
effective policy. Missing or expired native handles and routes without the
continuation capability fail explicitly; the broker does not restart without
the retained session or fall back to a different route. The fake fixture
exercises linked continuation; current native adapters do not advertise it.

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
updates are validated before an atomic file replacement. A running invocation
keeps the connection revision it resolved, so a later update or removal cannot
retarget it.

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
invocation conflict. `run` additionally maps terminal `cancelled`, `timed_out`,
and `interrupted` outcomes to non-zero statuses.

Callers may retry errors marked `retryable` after observing their details.
`route_unavailable` details include candidate diagnostics; human CLI mode keeps
those diagnostics visible instead of reducing them to a single message.

## Versioning

Adding optional fields or a new operation keeps the version. Removing or
changing field meaning requires a new schema or operations version. IPC clients
must send the exact supported protocol version. Adapters may expose different
capabilities, but every normalized event and outcome follows this contract.
