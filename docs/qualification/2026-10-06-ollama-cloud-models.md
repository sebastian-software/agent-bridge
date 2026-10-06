# Ollama cloud models live qualification record

**Date:** 2026-10-06

**Status:** Qualified for the tested configuration only

This record follows the opt-in procedure in
[local model setup](../local-models.md#opt-in-live-qualification) for the
cloud routes added by
[ADR-0027](../adr/0027-ollama-cloud-models-through-the-local-server.md). It
covers two runs on the same day: first on the free plan, where only starter
models are included, then after purchasing usage credits, which unlocked
`glm-5.3:cloud` and `kimi-k3:cloud`. It does not qualify other cloud models,
such as DeepSeek or MiniMax, or other plans.

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

| Model                | Remote model   | Reported size and format | Context | Tag digest     |
| -------------------- | -------------- | ------------------------ | ------- | -------------- |
| `gemma4:31b-cloud`   | `gemma4:31b`   | 32.7B, BF16              | 262144  | `ef09f235533c` |
| `gpt-oss:120b-cloud` | `gpt-oss:120b` | 117B, MXFP4              | 131072  | `ac7f7a1e7785` |
| `glm-5.3:cloud`      | `glm-5.3`      | 753B, FP8                | 1048576 | `8477dab3e25b` |
| `kimi-k3:cloud`      | `kimi-k3`      | 2.81T, MXFP4             | 1048576 | `630e737485bd` |

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
Both models report the thinking levels `low`, `high`, and `max` with default
`max`; Kimi K3 also accepts disabling thinking. Relay passes no level, so every
request used the default.

A reused idempotency key on a continuation was rejected with
`invocation_conflict` instead of returning the earlier invocation for another
request. The repeat with a fresh key is the continuation in the table.

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
- Cloud models other than the four that ran, and the behavior when credits
  run out.
- Effort levels. The routes advertise none, so every request used the model's
  default thinking setting.
