# agent-bridge

A local harness-to-harness delegation gateway. It lets an orchestrating agent
harness delegate one bounded invocation to another installed harness and regain
control with a normalized outcome.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs the repository lint gate, TypeScript validation, the full
test suite, and a dry-run package check. The package metadata is ready for a
future npm release; no publish is performed by CI.

## Planning documents

- [`CONTEXT.md`](CONTEXT.md): domain glossary and resolved invariants. This is
  the source of truth for terminology.
- [`docs/adr/`](docs/adr/): architecture decision records.

ADRs are edited in place while the design is young. Git history is the record
of how a decision evolved; the current text is always the current decision.

## Planning

Work is organized in GitHub issues. Epics carry the `epic` label, milestones
are represented by `milestone:*` labels until GitHub milestones exist:

| Label | Milestone |
| --- | --- |
| `milestone:M0` | Foundation and contract decisions |
| `milestone:M1` | Claude Code end-to-end through broker and CLI |
| `milestone:M2` | Second harness and MCP projection |
| `milestone:M3` | Hardening, cross-platform, release |
