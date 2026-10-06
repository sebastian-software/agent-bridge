# Ollama cloud models live qualification record

**Date:** 2026-10-06

**Status:** Qualified for the tested configuration only

This record follows the opt-in procedure in
[local model setup](../local-models.md#opt-in-live-qualification) for the
cloud routes added by
[ADR-0027](../adr/0027-ollama-cloud-models-through-the-local-server.md). It
covers two runs on the same day: first on the free plan, where only starter
models are included, then after purchasing usage credits, which unlocked
`glm-5.3:cloud`, `kimi-k3:cloud`, and `deepseek-v4.1-flash:cloud`. It does not
qualify other cloud models, such as MiniMax, or other plans.

## Configuration

| Item          | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Relay         | Source build of `aee219b` plus the billing change in this record         |
| Node.js       | 24.21.0                                                                  |
| Pi SDK        | `@earendil-works/pi-coding-agent` 1.0.0, embedded worker                 |
| Runtime       | Ollama 0.35.1, default settings, endpoint `http://127.0.0.1:11434`       |
| Account       | Signed in with `ollama signin`, free plan; later with purchased credits  |
| Machine       | Apple M1 Ultra, 64 GB memory, macOS 27.0.1                               |
| Relay context | Isolated config, state, and runtime directories; default login untouched |

| Model                       | Remote model          | Reported size and format | Context | Tag digest     |
| --------------------------- | --------------------- | ------------------------ | ------- | -------------- |
| `gemma4:31b-cloud`          | `gemma4:31b`          | 32.7B, BF16              | 262144  | `ef09f235533c` |
| `gpt-oss:120b-cloud`        | `gpt-oss:120b`        | 117B, MXFP4              | 131072  | `ac7f7a1e7785` |
| `glm-5.3:cloud`             | `glm-5.3`             | 753B, FP8                | 1048576 | `8477dab3e25b` |
| `kimi-k3:cloud`             | `kimi-k3`             | 2.81T, MXFP4             | 1048576 | `630e737485bd` |
| `deepseek-v4.1-flash:cloud` | `deepseek-v4.1-flash` | 763B, FP8                | 1048576 | `e04da138d31e` |

The digests identify the small tag manifest that `ollama pull` stores, not
model weights, which stay on ollama.com.

## Discovery

Before the sign-in, on Ollama 0.34.4, discovery reported `glm-5.3:cloud` with
`inferenceLocation: "remote"`, readiness `unavailable`, and the diagnostic to
run `ollama signin`. `POST /api/me` answered 401. The local `gemma4:e4b`
stayed `ready` with `inferenceLocation: "local"`.

After the sign-in, `POST /api/me` answered 200 and every installed cloud model
was `ready` with `inferenceLocation: "remote"`, capabilities `core.tools`,
`steering`, and `continuation`, interaction strategies `deny` and
`unattended`, and assurance `none`. The route carried no account detail.

## GLM 5.3 and Kimi K3 with purchased credits

Both models ran the complete procedure. Every tool call was sequential, and
every report was accurate.

| Check                      | `glm-5.3:cloud`                        | `kimi-k3:cloud`                        |
| -------------------------- | -------------------------------------- | -------------------------------------- |
| Tool task                  | 12 s; `write`, `read`, `edit`, `bash`  | 10 s; `write`, `read`, `write`, `bash` |
| Steering during `sleep 20` | Delivered at 2.2 s; `note.txt` correct | Delivered at 3.3 s; `note.txt` correct |
| Continuation without tools | Named the command and `note.txt`       | Named the command and `note.txt`       |
| Cancel during `sleep 117`  | `cancelled`, no process, no file       | `cancelled`, no process, no file       |
| 60 s timeout, `sleep 118`  | `timed_out`, no process, no file       | `timed_out`, no process, no file       |

In each probe workspace `probe.txt` contained `after` and the assertion passed
independently. Steering was `input_accepted` and `input_delivered` with
`native_session_acknowledgement` in the same second, the `bash` call finished
uninterrupted, and `note.txt` contained exactly `steered`. Continuations were
linked through `continuedFrom`. The observed model was `glm-5.3` and `kimi-k3`
respectively, evidence `reported`. Token counts were reported, but the cost
was 0: the Pi model definition Relay writes carries no price, so the actual
charge shows only in the Ollama account.

GLM 5.3 streamed thinking, which Relay reported as `thinking_delta` activity.
These runs passed no effort, so the server default `max` applied.

A reused idempotency key on a continuation was rejected with
`invocation_conflict` instead of returning the earlier invocation for another
request. The repeat with a fresh key is the continuation in the table.

## DeepSeek V4.1 Flash with purchased credits

`deepseek-v4.1-flash:cloud` ran the complete procedure on the build that
offers efforts, without requesting one; its server default is `high`.

- **Tool task.** 6 seconds with `write`, `read`, `edit`, `bash`; `probe.txt`
  contained `after` and the assertion passed independently.
- **Steering.** An instruction sent 1 second into a 20-second `bash` call was
  delivered with `native_session_acknowledgement` in the same second, and the
  `bash` call finished uninterrupted. The model then issued `write` and `read`
  in parallel; the `read` failed because it raced the `write`. It read the
  file again, `note.txt` contained exactly `steered`, and the report named the
  failed read itself.
- **Continuation.** Without tools it named the first shell command and
  `note.txt`, linked through `continuedFrom`.
- **Cancellation and timeout.** Cancelling during `sleep 117` produced
  `cancelled`, and a 60-second timeout during `sleep 118` produced
  `timed_out`. No `sleep` process remained and no output file was written.

The observed model was `deepseek-v4.1-flash`, evidence `reported`.

## Efforts

A later build offers the thinking levels from `/api/show` as efforts:
`low`, `high`, `max` for `glm-5.3:cloud` and `none`, `low`, `high`, `max` for
`kimi-k3:cloud` and `deepseek-v4.1-flash:cloud`. The probe task ran once per setting; every run succeeded and
`probe.txt` passed the assertion independently. The invocation records the
requested effort and the `reasoningEffort` sent.

| Model                       | Effort         | Output tokens | Duration |
| --------------------------- | -------------- | ------------- | -------- |
| `glm-5.3:cloud`             | none requested | 443           | 11 s     |
| `glm-5.3:cloud`             | `low`          | 173           | 4 s      |
| `glm-5.3:cloud`             | `max`          | 715           | 7 s      |
| `kimi-k3:cloud`             | `none`         | 337           | 10 s     |
| `kimi-k3:cloud`             | `high`         | 469           | 11 s     |
| `kimi-k3:cloud`             | `max`          | 543           | 12 s     |
| `deepseek-v4.1-flash:cloud` | none requested | 368           | 8 s      |
| `deepseek-v4.1-flash:cloud` | `none`         | 380           | 5 s      |
| `deepseek-v4.1-flash:cloud` | `low`          | 642           | 6 s      |
| `deepseek-v4.1-flash:cloud` | `high`         | 375           | 4 s      |
| `deepseek-v4.1-flash:cloud` | `max`          | 399           | 4 s      |

Each value is one run, so the durations show the direction, not a benchmark.
Direct requests to the server showed the same ordering for Kimi K3: on a short
reasoning question it produced 8 completion tokens at `none`, 76 at `low`, 104
at `high`, and 401 at `max`. DeepSeek V4.1 Flash showed no such ordering. On
the same question it produced 2 tokens at `none` and 68 to 89 at the other
levels, and its `low` probe run took an extra turn. For DeepSeek, `none`
reliably turns thinking off; the other levels did not measurably differ on
these tasks.

## Free-plan evidence

All runs used `gemma4:31b-cloud` except the second probe task.

- **Tool task.** Both models completed the probe task in about 4 seconds:
  `gemma4:31b-cloud` with `write`, `read`, `write`, `bash`, and
  `gpt-oss:120b-cloud` with `write`, `read`, `edit`, `bash`. In each workspace
  `probe.txt` contained `after` and the assertion passed independently. Each
  report was accurate. The observed model was `gemma4:31b` and `gpt-oss:120b`
  respectively, evidence `reported`. Usage was reported with a cost of 0.
- **Steering.** An instruction sent 3 seconds into a 20-second `bash` call was
  `input_accepted` and `input_delivered` with `native_session_acknowledgement`
  in the same second. The `bash` call finished uninterrupted. The model then
  issued `bash`, `write`, and `read` in parallel: it ran the `sleep` a second
  time, and the `read` failed because it raced the `write`. It wrote and read
  `note.txt` again, and the file contained exactly `steered`. The report
  mentioned both outputs.
- **Continuation.** Continuing that invocation without tools named the first
  shell command and `note.txt`, linked through `continuedFrom`.
- **Cancellation during a tool call.** Cancelling during `sleep 117` produced
  `cancelled`; no `sleep` process remained and no output file was written.
- **Timeout.** A 45-second invocation timeout during `sleep 118` produced
  `timed_out`; no `sleep` process remained and no output file was written.
- **Model outside the plan.** Before credits were added, a probe task on
  `glm-5.3:cloud` failed after about 2 seconds with `harness_failed` and Ollama's HTTP 402 message that the
  model is not included in the free usage. No other model was requested and
  no file was written. Direct requests to the local server returned the same
  402 for `kimi-k3:cloud`, `kimi-k2.7-code:cloud`, `glm-5.3-flash:cloud`,
  `deepseek-v4.1-flash:cloud`, and `minimax-m3:cloud`.

## Not covered

- Cancellation during generation. Ollama's server log does not show whether
  ollama.com stopped computing after the local request was cancelled.
- A sign-out between discovery and run against the real server. The fixture
  test covers the preflight failure.
- Cloud models other than the five that ran, and the behavior when credits
  run out. `gpt-oss:120b-cloud` ran only the tool task.
- Steering, continuation, cancellation, and timeout with an explicit effort.
