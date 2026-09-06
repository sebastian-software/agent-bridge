# Contributing

Thank you for taking the time. `agent-bridge` exposes a versioned contract, so
most changes touch a test, a document, or a decision record next to the code.
Please read [`CONTEXT.md`](CONTEXT.md) first: purpose, glossary, and the
resolved invariants are normative, and a change that contradicts one of them
needs a decision record rather than a patch.

## Setup

```sh
pnpm install --frozen-lockfile
```

Node.js 22 or newer, as declared in `engines`. pnpm comes from the
`packageManager` field; enable it with `corepack enable`. macOS and Linux are
supported; Windows support is not claimed yet.

## The gate

`pnpm check` is what CI runs, and it is the command to run before opening a
pull request:

```sh
pnpm check
```

It is composed of the scripts in `package.json`:

| Script           | Command                                   | Purpose                                              |
| ---------------- | ----------------------------------------- | ---------------------------------------------------- |
| `lint`           | `oxlint` then `eslint . --max-warnings=0` | OxLint first, then the type-aware ESLint pass        |
| `format:check`   | `oxfmt --check .`                         | Formatting; `pnpm format` writes the fixes           |
| `typecheck`      | `tsc -p tsconfig.json --noEmit`           | Types for `src`, `test`, and the lint configs        |
| `build`          | `tsc -p tsconfig.build.json`              | Compiles `src` and `test` into `dist`                |
| `test`           | `node --test 'dist/test/**/*.test.js'`    | The suite, after a build                             |
| `test:coverage`  | the suite with `--test-coverage-lines=75` | The line-coverage floor                              |
| `package:check`  | `pnpm pack --dry-run`                     | The published tarball contents                       |
| `docs:adr-index` | `node scripts/check-adr-index.mjs`        | `docs/adr/README.md` lists every ADR, and only those |

`pnpm agent:check` is the shorter loop (lint, format check, typecheck, build,
tests) for iterating locally. The tests run from the compiled output, so
`pnpm test` builds first — never run `node --test` against a stale `dist`.

CI adds two checks that are not part of `pnpm check`: `standards check` from
[`@sebastian-software/standards`](https://github.com/sebastian-software/standards),
which fails on drift in managed files, and a non-blocking `pnpm audit --prod`.
Never hand-edit a managed file such as `.oxfmtrc.json`; run `standards apply`
instead.

## Running against the fake harnesses

Two deterministic fixtures let you exercise the broker without an installed
harness or a model call.

`--via fake` is an in-process adapter with the routes `fake-echo`, `fake-slow`,
and `fake-fail`. It qualifies every interaction strategy, so the default
`orchestrator` works:

```sh
agent-bridge run --provider agent-bridge --model fake-echo --via fake \
  --cwd "$PWD" "hello from a fixture"
```

`--via fake-process` runs `scripts/fake-harness.mjs` as a real child process, so
it covers process supervision: stdin, stderr bounds, cancellation of the process
group, timeout grace, and JSONL parsing. Its model name selects the scenario —
`success`, `failure`, `timeout`, `malformed`, `truncated`, `effects`, `cancel`,
`identity-absent`, `slow`, or `exit-before-read`. These routes qualify `deny`
and `unattended` only, so pass `--interaction`; the CLI otherwise defaults to
`orchestrator` and resolution fails with `route_unavailable`:

```sh
agent-bridge run --provider agent-bridge --model effects --via fake-process \
  --interaction deny --cwd "$(mktemp -d)" "write a file"
```

The script also runs on its own, which is the quickest way to inspect the JSONL
it emits:

```sh
pnpm fake-harness -- --scenario effects --text "hello" --cwd "$(mktemp -d)"
```

`AGENT_BRIDGE_FAKE_HARNESS_PATH` overrides the path to the script; the compiled
tests set it because they run from `dist`. The `effects` scenario writes into
the directory you pass with `--cwd`, so point it at a scratch directory.

## Adapters

New harness support goes through the adapter SPI described in
[`docs/adapters.md`](docs/adapters.md): the manifest fields, the normalization
table, the identity and policy rules, and the tests every adapter is expected to
bring. Read it before adding a route — an adapter must not become a second
broker, and it must never copy a caller's assertion into observed identity.

## Decision records

Architectural changes are recorded in [`docs/adr/`](docs/adr/README.md). Add the
ADR in the same pull request as the change it explains, name the file
`NNNN-short-slug.md`, and add the row to the table in `docs/adr/README.md`.
`pnpm docs:adr-index` verifies that the table and the directory agree.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/), because the
  release workflow reads them. Keep the pull-request title in the same shape.
- One topic per pull request, with the gate run locally.
- Update the published surface — [`docs/contract.md`](docs/contract.md),
  [`docs/cli.md`](docs/cli.md), [`docs/mcp.md`](docs/mcp.md),
  [`docs/adapters.md`](docs/adapters.md), the JSON schemas — in the same change
  as the behavior it describes.
- US English for code, comments, identifiers, commits, and documentation. The
  wire-format value `cancelled` is a deliberate exception; see
  [`AGENTS.md`](AGENTS.md).
- Report effects, evidence, and assurance as what the bridge observed. Do not
  claim isolation, attribution, or rollback anywhere in code, tests, or prose.

## Security

Do not report a vulnerability in a public issue or pull request. Follow
[`SECURITY.md`](SECURITY.md), which also states what is in and out of scope for
a process supervisor that is deliberately not a sandbox.
