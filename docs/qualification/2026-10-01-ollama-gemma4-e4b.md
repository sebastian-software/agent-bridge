# Ollama gemma4:e4b live qualification record

**Date:** 2026-10-01

**Status:** Qualified for the tested configuration only

This record follows the opt-in procedure in
[local model setup](../local-models.md#opt-in-live-qualification) on the same
machine, Relay build, and Ollama server as the
[qwen3:8b](2026-09-30-ollama-qwen3-8b.md) and
[gemma4:26b-a4b](2026-09-30-ollama-gemma4-26b-a4b.md) records. At 6.6 GB it is
the smallest of the three and the suggested model for repeating this procedure.
It does not qualify other Gemma variants, quantizations, or Ollama versions.

## Configuration

| Item          | Value                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| Relay         | Source build of `main` at `066633e` (0.2.0 plus #170), Node.js 24.21.0        |
| Pi SDK        | `@earendil-works/pi-coding-agent` 0.87.1, embedded worker                     |
| Runtime       | Ollama 0.34.4, default server settings, endpoint `http://127.0.0.1:11434`     |
| Model         | `gemma4:e4b`, Q4_K_M, 7.5B parameters, 131072-token context, thinking enabled |
| Model digest  | `dc35e8d9c6061baa6f0fa870975ab6932e2542b579b13ea0f199fa4bb7300c9c`            |
| Machine       | Apple M1 Ultra, 64 GB memory, macOS 27.0                                      |
| Relay context | Isolated config, state, and runtime directories; default login untouched      |

Discovery reported the route as `ready` with capabilities `core.tools`,
`steering`, and `continuation`, interaction strategies `deny` and `unattended`,
and assurance `none`.

## Locality

`ollama show` resolved the model to a local blob with no remote host. During
the steering run, `ollama ps` listed `gemma4:e4b` as loaded with `100% GPU`, and
the server's request log recorded every chat completion.

## Passed evidence

- **Tool task.** Four runs of the probe task, two with and two without an
  instruction to use one tool per step, all ran `write`, `read`, `write`, and
  `bash` sequentially with no failed tool call and an accurate report.
  `probe.txt` contained `after` each time, the assertion passed independently,
  and git observation was complete. Warm runs took 12 to 13 seconds.
- **Steering.** An instruction sent while a 20-second `bash` call was running
  was `input_accepted` and `input_delivered` with
  `native_session_acknowledgement` in the same second. The `bash` call finished
  uninterrupted, and the model then wrote `note.txt` with exactly `steered`,
  read it back, and mentioned it in the report.
- **Continuation.** Continuing that invocation without tools returned the
  earlier shell command and the steered file name in about 3 seconds, linked
  through `continuedFrom`.
- **Cancellation during a tool call.** Cancelling during `sleep 117` produced
  `cancelled`; the `bash` process and its `sleep` child were gone afterwards,
  and no output file was written.
- **Cancellation during generation.** Cancelling during a long text answer
  kept the streamed partial text, and the Ollama server log recorded
  `stop: cancel task` in the same second.
- **Timeout.** A 45-second invocation timeout during `sleep 118` produced
  `timed_out`, and no descendant process remained.

Missing-model and stopped-server failures depend on the runtime profile, not
the model, and are covered by the qwen3:8b record.

## Speed compared with other Gemma 4 sizes

Measured directly against Ollama on the same machine with a warm model,
thinking disabled, as the mean of two runs:

| Model            | Size on disk | Prompt processing (about 3600 tokens) | Generation  | Relay probe, warm |
| ---------------- | ------------ | ------------------------------------- | ----------- | ----------------- |
| `gemma4:e4b`     | 6.6 GB       | 1929 tokens/s                         | 51 tokens/s | 12–13 s           |
| `gemma4:12b`     | 8.0 GB       | 1218 tokens/s                         | 26 tokens/s | about 21 s        |
| `gemma4:26b-a4b` | 18 GB        | 2683 tokens/s                         | 63 tokens/s | about 9 s         |

The mixture-of-experts `26b-a4b` model reads fewer weights per token than the
dense `12b` model and was the fastest. `e4b` trades some speed for a third of
the memory. The probe task is too simple to compare capability between sizes.
