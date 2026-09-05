# agent-bridge

A local harness-to-harness delegation gateway. It lets an orchestrating agent
harness delegate one bounded invocation to another installed harness and regain
control with a normalized outcome.

## Planning documents

- [`CONTEXT.md`](CONTEXT.md): domain glossary and resolved invariants. This is
  the source of truth for terminology.
- [`docs/adr/`](docs/adr/): architecture decision records. Each accepted ADR
  supersedes earlier drafts on the topic it decides.

The original RFC-0001 was retired on 2026-09-05. Its still-valid content lives
in `CONTEXT.md` and the ADRs; the rest was superseded by ADR-0001 to ADR-0006.

## Planning

Work is organized in GitHub issues. Epics carry the `epic` label, milestones
are represented by `milestone:*` labels until GitHub milestones exist:

| Label | Milestone |
| --- | --- |
| `milestone:M0` | Foundation and contract decisions |
| `milestone:M1` | Claude Code end-to-end through broker and CLI |
| `milestone:M2` | Second harness and MCP projection |
| `milestone:M3` | Hardening, cross-platform, release |
