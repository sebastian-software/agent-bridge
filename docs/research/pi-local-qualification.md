# Pi local-agent qualification

Date: 2026-09-29. Decision: [ADR-0025](../adr/0025-direct-local-model-access.md).

The internal Pi 0.87.1 worker now satisfies the worker/runtime portion of #149:
it reuses Pi's full coding-agent SDK in a Relay-supervised process and has
scripted-SDK coverage for lifecycle, policy boundaries, configuration, and
private session continuation. The adapter remains absent from the default
registry and discovers no routes. This evidence does not qualify an Ollama or
LM Studio route; those are tracked in #150 and #151. Active dialogue and live
continuation qualification remain in #153.

## Reproduce the standalone SDK probe

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

The probe is deliberately retained as an opt-in SDK-upgrade and direct-steering
compatibility check. Relay's worker tests cover the supervised adapter
boundary; this probe still exercises Pi's native steering during inference and
tool execution, which the private adapter does not expose. Run it explicitly
when changing the probe or upgrading the pinned Pi release.

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

The standalone probe itself has only been run on macOS. The production worker
suite runs in CI on Linux and macOS with Node 22.x and 24.x; the worker requires
Node >=22.19.0 and rejects Windows because it depends on supervised POSIX
process groups. These bounded fixtures do not establish model competence,
performance, general process-tree cleanup, or OS sandbox enforcement.

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
are disabled. The worker reports `assurance=none` and `sandbox=none`, and rejects
policy requests it cannot enforce, including `workspace-write` and `network=deny`.
Process supervision does not provide filesystem or network sandbox enforcement.

The worker rejects Pi's leading `!` shell-command configuration values in
`auth.json` API-key credentials, `models.json` provider API keys and headers,
model-definition and model-override headers, and cached model headers. It checks
the exact `ModelConfig` snapshot loaded by the pinned SDK before the first
request. For auth, it keeps Pi's native `AuthStorage` parser and resolver and
wraps the SDK's file backend: current content and proposed writes are checked
while Pi's native file lock is held on every read or write. This also rejects a
command value introduced into `auth.json` between model requests, without
copying credentials or adding a Relay auth resolver. Static values and
environment-backed values continue through Pi's native resolver. The worker
does not refresh model catalogs during a run; the initial scan checks the
explicit `models-store.json` cache before Pi starts.

`@earendil-works/pi-coding-agent` 0.87.1 is an optional package dependency;
normal installs still install optional dependencies. Pi execution requires
Node >=22.19.0, checked only when the private worker starts. Core imports, the
CLI, and Claude/Codex discovery are smoke-tested from a packed installation
with optional dependencies omitted. Without Pi installed, Pi execution reports
that it is unavailable instead of preventing the rest of Relay from starting.

Each invocation still starts a fresh one-shot worker. The private adapter now
persists Pi sessions and can branch a settled session into a new native session
file; scripted SDK fixtures cover continuation and reject changed checkpoint
identity before making another model request. This does not qualify a local
model route, so the adapter remains absent from the default registry and does
not advertise steering, continuation, or questions.

Opaque continuation handles and their route, account, policy, working-directory,
and model-configuration bindings live only in the broker process. Handles expire
after 24 hours. Native session files stay under a private temporary root; store
activity removes expired directories, and orderly adapter disposal removes the
whole root. A handle from a previous process is unavailable and Relay rejects it
rather than reopening the file without its original binding. An unclean process
exit can leave temporary files for the operating system to clean up.

## Remaining qualifications

The worker acceptance for #149 is complete within the tested platform and
assurance limits above. The following work is separate; the scripted endpoint
and private adapter do not imply that a local model route is ready:

- [#150](https://github.com/sebastian-software/harness-relay/issues/150) covers
  Ollama endpoint/model discovery and explicit routing, then live local
  inference, tool use, streaming, server failure, cancellation, and model
  limitations.
- [#151](https://github.com/sebastian-software/harness-relay/issues/151) covers
  LM Studio independently. An OpenAI-compatible API or loopback address alone
  does not establish local inference.
- [#153](https://github.com/sebastian-software/harness-relay/issues/153) covers
  dialogue capabilities across Pi and the other supported harnesses. Scripted
  tests already cover retained-session continuation and binding; active
  steering, correlated questions and answers, progress, dialogue races, and
  continuation with live local inference remain unqualified.

On the observed machine, Ollama responds at `127.0.0.1:11434`, but `/api/tags`
contains no models. Nothing listens at the conventional LM Studio port
`127.0.0.1:1234`; the app is absent from `/Applications` and `lms` is not on PATH.
Those limited checks do not rule out a custom installation elsewhere. No real
local-model run has been performed, and no model was downloaded for this spike.
