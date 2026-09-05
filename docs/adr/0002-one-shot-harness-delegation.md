# ADR-0002: Use one-shot harness delegation as the core primitive

- **Status:** Accepted
- **Date:** 2026-08-24
- **Amended:** 2026-09-05

## Context

The original RFC centered on read-only multi-perspective code review and left
open whether the bridge would own standalone workflows. The intended product is
broader and smaller at its core: an active harness such as Codex or Claude must
be able to delegate bounded work to another installed harness or specialized
capability provider and then continue its own workflow.

Installed harnesses retain their native authentication, model access, tools,
and provider-specific behavior. The bridge needs to normalize invocation and
outcome boundaries without pretending that those harnesses are identical.

## Decision

The core primitive is a one-shot invocation of exactly one ad-hoc delegate.
The orchestrator supplies a delegation selector, bounded input, and optional
resources, receives an asynchronous invocation handle, and later retrieves a
terminal outcome. It remains responsible for every next workflow step.

The selector names the desired harness family, model, effort, and optional
capabilities directly. The bridge resolves it against installed harnesses and
their discovered capabilities for that invocation. Pre-created named targets
are not required. Resolution must not silently fall back to another harness,
model, or effort level.

The self-describing CLI is the universal integration surface and an optional
MCP server projects the same core contract into MCP tools, as decided in
ADR-0006. Southbound adapters use the strongest machine-readable native
interface available for each installed harness.

The outcome can contain returned content and artifacts as well as observed
effects, including modifications made directly to files in a Git workspace.

## Consequences

- Multi-review orchestration, roles, quorum, and verdicts are not core domain
  concepts.
- Automatic capability-based delegate selection and persistent target objects
  are not required by the core primitive.
- Persistent delegate sessions, resume, approvals, OCR, vision, and computer
  use are optional capabilities layered over the same delegate and route
  model. Streaming itself is core, see ADR-0005.
- The bridge must distinguish returned data from observed external effects.
- Streaming progress, timeout, cancellation, the requested selector, the
  resolved route, and terminal status belong to the invocation contract.
- Harness-specific data may be retained in namespaced extension fields when it
  cannot be normalized without information loss.

## Open follow-up decisions

- How workspace changes are captured and represented in the outcome.
- How interactive permission and user-input requests return to the orchestrator.
- Whether invocation state survives termination of the orchestrator process.

## Amendments

- 2026-09-05: The original text called MCP the primary harness-facing
  integration. ADR-0006 decided the opposite: the CLI is the universal surface
  and MCP is an optional projection. The decision text now reflects ADR-0006.
  The term "target" was replaced by "delegate" and "route" to match
  `CONTEXT.md` and ADR-0004, which rejects pre-created target objects.
