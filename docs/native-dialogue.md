# Communicating with a running delegate

Relay keeps the caller in charge. Use `invocation.send` to add an instruction
while a delegate is working, `invocation.continue` for a new invocation that
retains a completed delegate's context, and `invocation.cancel` to stop work.
These operations are separate from answering a delegate's question or granting
a tool permission.

## Check the route first

A native harness may have an API that Relay has not implemented or qualified.
Inspect the discovered route's capabilities before choosing an operation;
protocol documentation alone does not make a capability available through
Relay.

| Harness boundary                            | Active steering in Relay                                                                                                       | Retained continuation in Relay                                                                               | General questions in Relay                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Pi coding-agent SDK 0.87.1, private worker  | Native `AgentSession.steer(text)` is implemented and scripted-tested; the private adapter is not route-discoverable by default | Native persisted-session branch is scripted-tested; the private adapter is not route-discoverable by default | Unsupported                                    |
| Claude Code 2.1.282 or later, print adapter | Unsupported                                                                                                                    | `--resume <session> --fork-session`; live-qualified on 2.1.282                                               | Unsupported; permission responses are separate |
| Codex CLI 0.159.2 or later, exec adapter    | Unsupported                                                                                                                    | `codex exec fork` of the retained thread; live-qualified on 0.159.2                                          | Unsupported                                    |
| Grok, pending adapter qualification         | Not advertised                                                                                                                 | Not advertised                                                                                               | Not advertised                                 |

The Pi row describes the worker integration, not availability of a discovered
local-model route. A usable route also needs its inference-server integration
and model configuration. Ready Ollama routes integrate this worker and
advertise both `steering` and `continuation`; LM Studio routes advertise
neither. The SDK tests use a scripted model endpoint; they do not prove that
any live local model follows instructions or calls tools correctly. The
[qwen3:8b](qualification/2026-09-30-ollama-qwen3-8b.md),
[gemma4:26b-a4b](qualification/2026-09-30-ollama-gemma4-26b-a4b.md), and
[gemma4:e4b](qualification/2026-10-01-ollama-gemma4-e4b.md) qualification
records add live evidence for three Ollama models: a steered instruction
delivered during an uninterrupted tool call, and a continuation that recalled
the earlier session. A route must advertise steering or continuation only after
it integrates this worker path and qualifies the selected runtime.

## Follow delivery, not just acceptance

A successful send returns an input ID and its delivery state. The usual first
state is `pending`: Relay has recorded the request and can deduplicate a retry
with the same idempotency key. Follow the invocation's events to learn whether
it reaches the native session.

- `input_accepted`: Relay recorded the instruction.
- `input_delivered`: the native session acknowledged its input boundary. For
  Pi, the SDK accepted the text into its steering queue.
- `input_delivery_failed`: the adapter could not deliver the instruction.
- `input_expired`: the invocation ended, was cancelled, or lost its broker
  before pending delivery could be established.

Delivery does not prove that the model read, followed, or completed the new
instruction. Inspect subsequent output and the terminal outcome. An uncertain
or failed delivery does not trigger a second invocation, a model switch, or an
automatic retry.

For an already running invocation whose route supports steering:

```ts
import { HarnessRelayClient } from "harness-relay";

const client = new HarnessRelayClient();
const sent = await client.send({
  invocationId,
  idempotencyKey: "add-regression-case-1",
  input: [{ type: "text", text: "Also cover the empty-input case in the test." }],
});

for await (const event of client.follow(invocationId)) {
  if (event.data?.inputId === sent.inputId) {
    console.log(event.category, event.data);
  }
}
const result = await client.result(invocationId);
```

Use the same key and identical content when retrying that send. A different key
is a different instruction. Reusing a key for different content is an error.

Pi's SDK queues steering for the next model request after the current assistant
turn's tool calls. Sending an instruction does not interrupt an active shell
command. Relay's ACK reports SDK queue acceptance; it does not report model
consumption. The worker accepts text input only; unsupported content fails
explicitly. The worker and adapter integration are covered with a scripted
endpoint, but no live local model route has been qualified.

## Continue after completion

Once an invocation ends, send is no longer the operation to use. A supported
continuation creates a new invocation and preserves the predecessor's outcome:

```ts
const next = await client.continue({
  invocationId,
  idempotencyKey: "review-completed-change-1",
  input: [{ type: "text", text: "Review your change and report any remaining risk." }],
});
```

Continuation retains the route, account selection, working directory, and
policy. Missing, expired, or changed native context causes an explicit error.
Relay does not substitute a fresh conversation. Pi continuation handles are
owned by the running broker and do not survive its restart.

Codex continuation forks the predecessor's native thread with
`codex exec fork`. Each continuation is its own branch: two continuations of the
same invocation do not see each other, and the predecessor's session file stays
unchanged. To make that possible, continuable Codex runs are not ephemeral.
Codex stores each of them in `CODEX_HOME/sessions`, where it also appears in
`codex resume`; Relay never deletes those files. The broker keeps the handle for
24 hours and drops it on restart. Runs with additional directories stay
ephemeral and cannot be continued, because `exec fork` has no `--add-dir`. See
the [qualification record](qualification/2026-10-01-codex-continuation.md).

Claude continuation resumes the predecessor's session with `--resume` and
`--fork-session`, so it also runs as an independent branch and leaves the
original session file unchanged. Claude Code already stores print-mode sessions
under its configuration directory; continuation does not change that. Additional
directories and every interaction strategy carry over. The broker keeps the
handle for 24 hours and drops it on restart. See the
[qualification record](qualification/2026-10-01-claude-continuation.md).

## Questions and permissions

A question has `kind: "question"` and is answered through
`invocation.answer`. A permission request has `kind: "permission"` and accepts
`allow` or `deny` through `invocation.respond`. Both use the request ID from the
matching `input_required` event. Do not turn ordinary assistant prose into a
question request or treat permission approval as a general answer.

The broker contract supports both kinds. The native routes above do not yet
have a qualified general-question round trip. A caller must keep polling or
following events; Relay cannot guarantee that a host agent wakes up when an
event arrives.

## Native interfaces still to qualify

The installed Codex CLI 0.155.1 can export app-server schemas with
`codex app-server generate-json-schema --out <directory>`. The exported
protocol includes `turn/steer`, guarded by `threadId` and `expectedTurnId`,
`thread/resume`, `thread/fork`, and `item/tool/requestUserInput` with correlated
thread, turn, item, and question IDs. This is version-specific schema evidence,
not a live execution test. Relay's exec adapter uses `codex exec fork` for
continuation; active steering and questions through the app-server remain
unimplemented.

Claude Code 2.1.282 advertises streaming JSON input and replayed user messages
in its CLI help. Relay uses session resumption with forking for continuation;
steering over streaming input still needs native lifecycle and delivery
qualification. Its current permission handler does not implement general
question answers.
