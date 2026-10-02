# ADR-0023: Ship caller-side delegation and workflow skills

- **Status:** Accepted
- **Date:** 2026-09-15
- **Updated:** 2026-10-02

The first usable public release includes both general delegation guidance and
concrete workflow skills. A caller needs a reusable way to hand off a bounded
task as well as guidance for applying delegation to a specific goal.

Both kinds of skill execute in the caller's context. Workflow skills may
coordinate invocations and interpret their outcomes, while the caller remains
the root and owns the final decision. This preserves
[ADR-0001](0001-caller-owned-orchestration.md): distributing workflow guidance
does not move workflow ownership into the broker.

Skills use the self-describing CLI to discover the installed contract, following
[ADR-0006](0006-local-broker-and-self-describing-cli.md). The CLI continues to own
operation schemas and detailed command knowledge. Shipping useful workflows
therefore adds caller guidance without introducing a second implementation of
the bridge protocol.

The initial skill scope covers general delegation, an independent second
opinion, and a review with multiple models. General delegation accepts bounded
analysis and implementation tasks; the release does not require a complete
development workflow that decomposes and implements an entire project.

The calling agent may initiate delegation within the user's authorized task
when it adds clear value, without requiring the user to name delegation
explicitly. It reports which delegations contributed to the result. Existing
user constraints remain binding.

Explicit model and effort choices, and existing user preferences, take
precedence. When those choices are absent, the caller selects an appropriate
qualified route and effort for the task. A second opinion preferably uses a
different model family. An explicitly requested route that is unavailable
produces an explained failure, never a silent substitution.

Skills do not introduce mandatory call-count, time, recursion, or retry limits.
The caller and the user's installed harnesses control execution, and explicit
user constraints remain binding. The bridge's optional timeout and cancellation
operations remain available. Skill guidance is not represented as an enforced
runtime boundary.

Reviews treat delegates as individual contributors. Reports attribute findings
to their contributors and preserve differing assessments and optional
suggestions. The calling workflow or user can then decide which findings are
correct, relevant, and worth acting on. The review skill does not require a
consensus, majority verdict, or automatic resolution of every disagreement.

Each delegation's status and available results must remain visible. Failures
and incomplete work are reported alongside the contributions that are
available, without being suppressed or presented as success. Recovery and retry
decisions remain caller-owned.

## Update 2026-10-02: one routed skill

The workflows ship as one `harness-relay` skill instead of four separate
skills. The delegation, second-opinion, and review skills repeated the same
bootstrap, route-selection, evidence, and reporting rules, and a second opinion
is a review with one contributor. Separate skills also compete for the agent's
attention when it decides which one applies.

`SKILL.md` now holds the shared procedure and routes by intent to reference
files that are loaded only when needed: second opinions and reviews, dialogue
with a running or finished delegate, and named-login setup. The scope and the
rules above are unchanged; only the packaging is.
