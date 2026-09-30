# Ollama qwen3:8b live qualification record

**Date:** 2026-09-30

**Status:** Qualified for the tested configuration only

This record follows the opt-in procedure in
[local model setup](../local-models.md#opt-in-live-qualification). It covers one
model on one machine. It does not qualify other Qwen variants, quantizations,
Ollama versions, or model families.

## Configuration

| Item          | Value                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Relay         | Source build of `main` at `066633e` (0.2.0 plus #170), Node.js 24.21.0     |
| Pi SDK        | `@earendil-works/pi-coding-agent` 0.87.1, embedded worker                  |
| Runtime       | Ollama 0.34.4, default server settings, endpoint `http://127.0.0.1:11434`  |
| Model         | `qwen3:8b`, Q4_K_M, 8.2B parameters, 40960-token context, thinking enabled |
| Model digest  | `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`         |
| Machine       | Apple M1 Ultra, 64 GB memory, macOS 27.0                                   |
| Relay context | Isolated config, state, and runtime directories; default login untouched   |

Discovery reported the route as `ready` with provider `unknown`
(`modelVendorEvidence: unverified`), model identity `reported`, capabilities
`core.tools`, `steering`, and `continuation`, interaction strategies `deny` and
`unattended`, and assurance `none`.

## Locality

`ollama show` resolved the model to a local blob in the Ollama model store with
no remote host. During a run, `ollama ps` listed `qwen3:8b` as loaded with
`100% GPU`, and the server's request log recorded every chat completion. This
is native evidence that inference ran on this machine; the loopback endpoint
was not relied on alone.

## Passed evidence

- **Tool task.** With the probe task from the procedure, the model ran
  `write`, `read`, `write`, and `bash` sequentially in about 26 seconds.
  `probe.txt` contained `after`, and the assertion command passed when run
  independently. Git observation reported `probe.txt` as created, and the
  effect observation was complete.
- **Streaming.** Every successful run streamed `output` events (37 to 225 per
  run) and tool activity before the terminal event.
- **Steering.** An instruction sent while a 20-second `bash` call was running
  was `input_accepted`, then `input_delivered` with
  `native_session_acknowledgement` one second later. The `bash` call finished
  uninterrupted 19 seconds after delivery, and the model then wrote the
  requested `note.txt` in a later turn.
- **Continuation.** Continuing that completed invocation without tools returned
  the earlier shell command and the steered file name correctly. The new
  invocation recorded `continuedFrom`, and the predecessor outcome stayed
  unchanged.
- **Cancellation during a tool call.** Cancelling during `sleep 117` produced
  `cancelled` within a second. The `bash` process and its `sleep` child were
  gone afterwards, and no output file was written.
- **Cancellation during generation.** Cancelling during a long text answer
  produced `cancelled`, kept the streamed partial text in `content`, and the
  Ollama server log recorded `stop: cancel task` in the same second. This is
  server-side evidence that inference stopped, not only an HTTP disconnect.
- **Timeout.** A 45-second invocation timeout during `sleep 118` produced
  `timed_out` with `reason: timeout`, and no descendant process remained.
- **Missing model.** Selecting `qwen3:14b` on a dedicated test runtime failed
  before execution with `route_unavailable` and candidate diagnostics.
- **Stopped server.** After the dedicated test server on port 11435 was
  stopped, an invocation of its previously discovered route failed within 30 ms
  with `route_unavailable`. The main server's log showed no chat request at
  that time, so no fallback to the other runtime occurred.

## Model limitations observed

- **Parallel tool calls and false reporting.** Without an explicit instruction
  to use one tool per step, the model issued all four probe tool calls in one
  turn. The `read` call failed because the file did not exist yet, and Relay
  reported it as `tool_failed`. The model still claimed it had confirmed the
  file contents. The final file was correct only because of execution order.
  Callers must verify results independently rather than trusting the report.
- **`/think` suffix.** Ollama's `qwen3` chat template appends ` /think` to the
  last user message when thinking is enabled. A steered instruction to write
  exactly `steered` produced `steered /think`. Exact-content tasks with this
  model can pick up the suffix.

## Diagnostics worth improving

- When the runtime directory produces a Unix socket path longer than the macOS
  limit of 104 bytes, broker startup fails with only "The broker could not
  complete the operation."
- A stopped inference server is reported as "The selected local model, digest,
  or loaded instance changed after route discovery." The failure is explicit
  and correct, but the message does not say the server was unreachable.
