# AGENTS.md

Guidance for coding agents working in this repository. Humans welcome too.

## Language

Project language is US English: code, comments, identifiers, commit messages
and documentation.

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm agent:check
```

`pnpm agent:check` runs OxLint and ESLint, the oxfmt format check, TypeScript
validation, the build and the test suite. `pnpm check` is the fuller gate CI
runs: `agent:check` plus coverage and the package dry-run.

## Where the context lives

- [`CONTEXT.md`](CONTEXT.md) is the domain context. Purpose, glossary and
  non-goals are normative — read it before changing behavior or naming.
- [`docs/adr/`](docs/adr/README.md) records the accepted decisions. They are
  constraints, not proposals to re-open in routine work.
- [`docs/contract.md`](docs/contract.md), [`docs/cli.md`](docs/cli.md),
  [`docs/mcp.md`](docs/mcp.md) and [`docs/adapters.md`](docs/adapters.md)
  describe the published surface. Keep them in step with the code.

## Conventions

- Conventional Commits; the release workflow depends on them.
- Effects, evidence and assurance are reported, never claimed beyond what the
  bridge actually observes (see `CONTEXT.md` and ADR 0018).
- Tooling follows the org standards recorded in `.repometa.json`: oxfmt
  formats, OxLint and `eslint-config-setup` lint. `.oxfmtrc.json` is managed by
  `@sebastian-software/standards` — never hand-edit it.
