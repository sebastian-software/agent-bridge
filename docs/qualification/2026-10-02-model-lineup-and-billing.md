# Model lineup and billing qualification record

**Date:** 2026-10-02

**Status:** Qualified for Claude Code 2.1.282 and Codex CLI 0.159.2 with their
default subscription logins

This record covers the model and effort lists in the Claude and Codex
manifests and the `billing` classification of their authentication status. It
does not cover route `guidance`, which is an editorial assessment, and it does
not qualify any capability beyond text input and output. In particular, the
`computer-use` strength on `gpt-6-astra` was not exercised through Relay.

## Configuration

| Item    | Value                                                                 |
| ------- | --------------------------------------------------------------------- |
| Relay   | Source build of `main` at `bdaac58` plus this change, Node.js 24.21.0 |
| Claude  | Claude Code 2.1.282, default login (`claude.ai`, subscription)        |
| Codex   | Codex CLI 0.159.2, default `CODEX_HOME`, "Logged in using ChatGPT"    |
| Policy  | Interaction `deny`, filesystem `read-only`                            |
| Prompt  | `Reply with exactly: OK`, one empty Git workspace per invocation      |
| Machine | Apple M1 Ultra, macOS 27.0                                            |
| Context | Isolated Relay config, state, and runtime directories                 |

## Relay evidence

All 34 invocations ended `succeeded` with the content `OK`.

| Route               | Efforts exercised                                | Observed model      |
| ------------------- | ------------------------------------------------ | ------------------- |
| `claude-fable-5-1`  | `low`, `medium`, `high`, `xhigh`, `max`          | `claude-fable-5-1`  |
| `claude-opus-5-5`   | `low`, `medium`, `high`, `xhigh`, `max`          | `claude-opus-5-5`   |
| `claude-sonnet-5-5` | `low`, `medium`, `high`, `xhigh`, `max`          | `claude-sonnet-5-5` |
| `fable` (alias)     | `low`                                            | `claude-fable-5-1`  |
| `opus` (alias)      | `low`                                            | `claude-opus-5-5`   |
| `gpt-6-astra`       | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | not reported        |
| `gpt-6.1-sol`       | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | not reported        |
| `gpt-6-luna`        | `low`, `medium`, `high`, `xhigh`, `max`          | not reported        |

Claude's stream reports the runtime model, so its identity evidence is
`reported`. Codex's JSONL output does not, so its model identity stays
`unverified`. The effective native policy recorded the requested effort for
every Codex run: `model_reasoning_effort` carried the requested name,
including the native `max` and `ultra`.

Discovery reported `billing` as `subscription` with evidence `reported` for
every Claude and Codex route. An API key login was not available. The Codex
classifier recognizes the wording that version prints for it; the Claude
classifier leaves every login other than the observed one `unknown`.

## Native observations behind the manifest changes

These were made with the harness CLIs directly, before the manifest change.

- Claude Code resolves the alias `sonnet` to `claude-sonnet-5`. The alias is
  therefore not offered; `claude-sonnet-5-5` is requested by its full ID. For
  that ID the CLI logs `unrecognized_model` and still runs it.
- With `--model haiku`, the session reported `claude-haiku-4-5-20251001`, but
  the assistant message and the usage record named `claude-sonnet-5`, in two
  of two runs. The full Haiku ID was served by Haiku. The alias is not offered.
- `claude-opus-4-8` is still served. It is no longer in the manifest.
- With a ChatGPT login, Codex rejects `gpt-5.3-codex`, `codex-mini-latest`,
  and the alias `gpt-5` with "not supported when using Codex with a ChatGPT
  account". `gpt-5.5` still runs; Codex's catalog calls it a legacy model.
  All of them are no longer in the manifest. With them went the mapping of
  Relay's `max` to the native `xhigh`: every remaining model has a native
  `max`.
- `codex exec` accepted `ultra` for `gpt-6-luna`, although Codex's model
  catalog lists that model only up to `max`. The manifest follows the catalog.

## Deterministic coverage

`test/adapters.test.ts` covers the manifest route lists, built-in guidance,
billing from an injected authentication status, and the effort passed to
Codex for current and legacy models. `test/route-guidance.test.ts` covers the
billing classifiers and user guidance validation. `test/model-catalog.test.ts`
covers declared and replaced guidance.
