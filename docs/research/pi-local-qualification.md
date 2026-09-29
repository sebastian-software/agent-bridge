# Pi local-agent qualification

Date: 2026-09-29. Decision: [ADR-0025](../adr/0025-direct-local-model-access.md).

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

| Boundary                  | Observed evidence                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless execution        | The SDK runs in a Node child process without presenting a TUI or requiring a Pi CLI installation.                                                                                                   |
| Full coding tools         | Pi writes and edits a file, reads it successfully, and executes a shell command that copies it. File contents and tool result events are checked.                                                   |
| Output streaming          | Text delta events arrive through the SDK subscription.                                                                                                                                              |
| Continuation              | A second prompt in the same in-memory session includes the preceding conversation and settles separately.                                                                                           |
| Steering during inference | A queued instruction is absent from the already-issued request and appears in the next model request. Accepting it is distinct from delivering it.                                                  |
| Steering during a tool    | A real shell command waits at a controlled barrier. Steering does not end the command; after release, it completes and the next request contains the instruction.                                   |
| Quota-like failure        | A scripted HTTP 429 produces one request and an assistant `error` outcome with retries disabled. The `prompt()` promise resolves despite the failure.                                               |
| Cancellation              | Aborting a session during `bash` terminates the observed `sleep` descendant, produces a tool error event, and reaches `agent_settled`.                                                              |
| Command timeout           | The real Pi Bash tool passes its timeout to Relay's supervised runner; a scripted one-second timeout is reported as a tool failure, the run settles, and its descendant exits.                      |
| Invocation timeout        | A broker timeout during a live Bash call records exactly one `timed_out` outcome/event with streamed partial text and verified Pi identity; the command descendant exits.                           |
| Worker and host loss      | Killing the Pi worker during Bash fails the invocation while preserving streamed partial text and identity; killing a separate host process during Bash closes the worker and its shell descendant. |
| Explicit defaults         | Every model request uses the explicitly configured model despite conflicting isolated settings; the settings file remains unchanged.                                                                |

These observations support proceeding with the Pi adapter. They do not establish
model competence, performance, OS sandbox enforcement, arbitrary process-tree
cleanup, cross-account isolation, or support outside the POSIX macOS fixture
environment used for the lifecycle tests.

## Private worker implementation

Relay now has an internal Pi adapter and supervised worker foundation, but the
adapter is deliberately absent from the default registry and discovers no
routes. This is not a production-ready Ollama or LM Studio route.

The worker uses the pinned full SDK's agent session and built-in coding tools.
Relay replaces only Pi's BashOperations execution seam so its headless worker
can register a process group with the host before a command executes. The
worker-host protocol is bounded; the worker drains command output while the
host drains protocol output, tracks each registered group, cleans it on normal
completion, cancellation, timeout, abrupt worker loss, or malformed worker
output, and retains the best observed partial text. The gated runner also treats
worker control-channel EOF as parent loss and terminates its registered process
group. Real-SDK fixtures qualify command timeout as a failed tool event, while
a broker-level fixture verifies one `timed_out` outcome after invocation timeout
with partial evidence and no live command descendant. A separate host-process
fixture verifies worker and descendant exit after abrupt host loss. These are
bounded POSIX process fixtures, not general cross-platform process-tree or
OS-sandbox guarantees. Pi retries are disabled. A
fixture-backed HTTP 429 produces one model
request and a failed outcome. Large tool output follows Pi's truncation
behavior and preserves its tail. These tests use a scripted endpoint and do
not qualify any real model or provider.

The worker explicitly passes empty system-prompt overrides to Pi's resource
loader, which prevents project and global `SYSTEM.md` and `APPEND_SYSTEM.md`
files from being discovered; Pi still supplies its built-in coding-agent
prompt. Extensions, skills, prompt templates, themes, and project context files
are disabled. Requested policies the worker cannot enforce are rejected. This
process supervision is not an OS sandbox and does not support `workspace-write`
or `network=deny` enforcement.

`@earendil-works/pi-coding-agent` 0.87.1 is an optional package dependency;
normal installs still install optional dependencies. Pi execution requires
Node >=22.19.0, checked only when the private worker starts. Core imports, the
CLI, and Claude/Codex discovery are smoke-tested from a packed installation
with optional dependencies omitted. Without Pi installed, Pi execution reports
that it is unavailable instead of preventing the rest of Relay from starting.

The private worker is one-shot and uses an in-memory Pi session. It does not
advertise steering, continuation, or questions, and it does not resume a
session across worker processes.

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
2. Qualify local endpoint/model configuration and expose a ready route only
   after the live Ollama and LM Studio paths pass their qualification suites.
3. Qualify production policy enforcement, resource and credential isolation,
   broader parent-loss and cleanup behavior, and supported platforms; process
   supervision alone is not an OS sandbox.
4. Add qualified dialogue and persistent continuation behavior. In-memory
   sessions end with the worker and cannot be resumed.

On the observed machine, Ollama responds at `127.0.0.1:11434`, but `/api/tags`
contains no models. Nothing listens at the conventional LM Studio port
`127.0.0.1:1234`; the app is absent from `/Applications` and `lms` is not on PATH.
Those limited checks do not rule out a custom installation elsewhere. No real
local-model run has been performed, and no model was downloaded for this spike.
