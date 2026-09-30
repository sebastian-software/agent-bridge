# Ollama gemma4:26b-a4b live qualification record

**Date:** 2026-09-30

**Status:** Qualified for the tested configuration only

This record follows the opt-in procedure in
[local model setup](../local-models.md#opt-in-live-qualification) on the same
machine, Relay build, and Ollama server as the
[qwen3:8b record](2026-09-30-ollama-qwen3-8b.md). It does not qualify other
Gemma variants, quantizations, or Ollama versions.

## Configuration

| Item          | Value                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Relay         | Source build of `main` at `066633e` (0.2.0 plus #170), Node.js 24.21.0                                  |
| Pi SDK        | `@earendil-works/pi-coding-agent` 0.87.1, embedded worker                                               |
| Runtime       | Ollama 0.34.4, default server settings, endpoint `http://127.0.0.1:11434`                               |
| Model         | `gemma4:26b-a4b`, Q4_K_M, 25.2B parameters (mixture of experts), 262144-token context, thinking enabled |
| Model digest  | `001e5dafc3c77684c2307ebc6ab8e336e10c9b18eca52acf547d72fc83c3ca8c`                                      |
| Machine       | Apple M1 Ultra, 64 GB memory, macOS 27.0                                                                |
| Relay context | Isolated config, state, and runtime directories; default login untouched                                |

Discovery reported the route as `ready` with provider `unknown`, capabilities
`core.tools`, `steering`, and `continuation`, interaction strategies `deny` and
`unattended`, and assurance `none`.

## Locality

`ollama show` resolved the model to a local blob with no remote host. During
the steering and generation runs, `ollama ps` listed `gemma4:26b-a4b` as loaded
with `100% GPU`, and the server's request log recorded every chat completion.

## Passed evidence

- **Tool task without ordering hints.** Given the probe task without an
  instruction to use one tool per step, the model still ran `write`, `read`,
  `write`, and `bash` sequentially, plus one extra `bash` check. Its report
  matched the tool results. `probe.txt` contained `after`, the assertion
  passed independently, and git observation was complete. The first run took
  about 33 seconds including model load.
- **Tool task with ordering hints.** The same sequence completed in about
  10 seconds with a correct report.
- **Streaming.** Every successful run streamed `output` events (19 to 221 per
  run) and tool activity before the terminal event.
- **Steering.** An instruction sent while a 20-second `bash` call was running
  was `input_accepted`, then `input_delivered` with
  `native_session_acknowledgement` in the same second. The `bash` call finished
  uninterrupted, and the model then created `note.txt` with exactly `steered`.
  Its final answer did not mention the extra file; the effect and file content
  show that it was done.
- **Continuation.** Continuing that invocation without tools returned the
  earlier shell command and the steered file name in about 3 seconds. The new
  invocation recorded `continuedFrom`. A continuation that reused an
  idempotency key from an unrelated earlier request was rejected with
  `invocation_conflict`.
- **Cancellation during a tool call.** Cancelling during `sleep 117` produced
  `cancelled` within a second; the `bash` process and its `sleep` child were
  gone afterwards, and no output file was written.
- **Cancellation during generation.** Cancelling during a long text answer
  produced `cancelled`, kept the streamed partial text in `content`, and the
  Ollama server log recorded `stop: cancel task` in the same second.
- **Timeout.** A 45-second invocation timeout during `sleep 118` produced
  `timed_out`, and no descendant process remained.

Missing-model and stopped-server failures depend on the runtime profile, not
the model, and are covered by the qwen3:8b record.

## Model behavior observed

- The model reasons for a long time before long answers: the first output of
  a 3000-word essay arrived about 30 seconds after the start.
- Unlike qwen3:8b, the Ollama template for this model does not append a
  thinking directive to user messages, and exact-content output was exact.
