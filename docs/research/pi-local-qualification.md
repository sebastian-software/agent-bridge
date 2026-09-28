# Pi local-agent qualification

Date: 2026-09-28. Decision: [ADR-0025](../adr/0025-direct-local-model-access.md).

Pi is the selected full agent runtime for the planned local-model routes.
This initial spike validates the installed SDK and its built-in tools against
a controlled local OpenAI-compatible streaming endpoint. It does not qualify
an Ollama or LM Studio route for production.

## Reproduce

The standalone [qualification package](../../scripts/pi-qualification/README.md)
pins `@earendil-works/pi-coding-agent` to 0.87.1 with its own lockfile.
From the repository root on macOS:

```sh
pnpm --dir scripts/pi-qualification install --frozen-lockfile --ignore-scripts
pnpm --dir scripts/pi-qualification check
```

The observed run used Node 24.21.0 and pnpm 11.24.0. Pi requires Node >=22.19.0.
The package is separate from Relay's dependencies, default test suite, build,
and published files. It does not register a new adapter or change the wire
contract. The probe uses POSIX shell commands and has only been run on macOS.

The runner starts a child process with an isolated temporary home and a minimal
environment, before importing Pi. It injects a resource loader without plugins,
skills, prompts, or project instructions; in-memory settings and sessions;
explicit local model configuration; and disabled automatic retry/compaction.
The test endpoint uses scripted responses. Pi's agent loop and `read`, `write`,
`edit`, and `bash` implementations are real. The probe downloads no models and
uses no provider account. Temporary files are removed afterward.

## Observed results

| Boundary                  | Observed evidence                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless execution        | The SDK runs in a Node child process without presenting a TUI or requiring a Pi CLI installation.                                                                 |
| Full coding tools         | Pi writes and edits a file, reads it successfully, and executes a shell command that copies it. File contents and tool result events are checked.                 |
| Output streaming          | Text delta events arrive through the SDK subscription.                                                                                                            |
| Continuation              | A second prompt in the same in-memory session includes the preceding conversation and settles separately.                                                         |
| Steering during inference | A queued instruction is absent from the already-issued request and appears in the next model request. Accepting it is distinct from delivering it.                |
| Steering during a tool    | A real shell command waits at a controlled barrier. Steering does not end the command; after release, it completes and the next request contains the instruction. |
| Quota-like failure        | A scripted HTTP 429 produces one request and an assistant `error` outcome with retries disabled. The `prompt()` promise resolves despite the failure.             |
| Cancellation              | Aborting a session during `bash` terminates the observed `sleep` descendant, produces a tool error event, and reaches `agent_settled`.                            |
| Explicit defaults         | Every model request uses the explicitly configured model despite conflicting isolated settings; the settings file remains unchanged.                              |

These observations support proceeding with the Pi adapter. They do not establish
model competence, performance, OS sandbox enforcement, crash recovery, arbitrary
process-tree cleanup, cross-account isolation, or support on other platforms.

## Integration consequences

- Evaluate assistant stop reasons and errors before producing Relay's terminal
  outcome. A resolved `prompt()` must not become unconditional success.
- Use the actual settled boundary and preserve partial events. Relay still needs
  an explicit adapter contract for cancellation and queued-message delivery.
- Keep retry and model/account fallback under the caller's control. This probe
  disables Pi retries; it does not implement recovery in Relay.
- Use the full coding-agent SDK. Lower-level Pi packages do not supply the
  complete coding harness required by the decision.
- Preserve explicit configuration and resource loading. Default SDK discovery
  is not evidence that a selected Relay connection is isolated.
- A managed process helps own runtime lifecycle; it is not an OS sandbox.
  Permission hooks and Relay's requested policy still need qualified mapping.
- Account for Pi's Node minimum before shipping. The SDK distribution includes
  UI-related dependencies even when it presents no UI; there is no measured
  startup or memory advantage over the alternatives.

## Remaining release gates

1. Exercise actual local inference independently through Ollama and LM Studio:
   discovery, explicit model selection, streamed tool calls, model limitations,
   server failure, and cancellation. The fixture cannot establish compatibility.
2. Qualify the production worker protocol, shutdown on parent exit, timeouts,
   partial outcomes, policy mapping, and resource/credential isolation.
3. Add and test Relay's adapter, discovery, and normalized communication surface.
   Persistent resume is separate from the in-memory continuation tested here.
4. Decide production dependency packaging and the supported Node minimum.

On the observed machine, Ollama responds at `127.0.0.1:11434`, but `/api/tags`
contains no models. Nothing listens at the conventional LM Studio port
`127.0.0.1:1234`; the app is absent from `/Applications` and `lms` is not on PATH.
Those limited checks do not rule out a custom installation elsewhere. No real
local-model run has been performed, and no model was downloaded for this spike.
