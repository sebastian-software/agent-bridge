# ADR-0026: Publish advisory route guidance and ship a routing skill

- **Status:** Accepted
- **Date:** 2026-10-02

## Context

[ADR-0023](0023-ship-caller-side-delegation-and-workflow-skills.md) lets the
caller select "an appropriate qualified route and effort" when the user names
none. It does not say what appropriate means. A caller then chooses from
memory, and that memory is stale: model lineups and effort ladders change
within weeks, and a harness may no longer serve a model the caller remembers.

Three things decide a good choice. How capable the model is relative to the
task, which models have a particular strength, and how use of the route is
paid for. The first two are judgments about models. The third is a fact about
the login behind a route.

A routing rule such as "review with a more capable model than the author's" is
stable. The lineup it applies to is not. Writing model names into a skill
would bind the rule to the lineup of one release date.

## Decision

Route descriptors carry two optional fields, and a fifth caller skill applies
routing rules to them.

`guidance` is editorial advice about the model behind a route: a capability
`tier` (`frontier`, `strong`, `balanced`, or `fast`, in that order), a list of
`strengths`, the assessment date `asOf`, and a `source`. Built-in guidance is
maintained next to each adapter's model manifest and has source `built-in`. A
user's `config.json` can declare or replace guidance for any model; that
guidance has source `user-declared`. A route without guidance has an unknown
tier.

`billing` reports how use of the route is paid for: `local`, `subscription`,
`metered`, or `unknown`, with an evidence status. An adapter derives it from
the authentication status probe it already runs. A login shape that has not
been observed for a qualified harness version stays `unknown`.

Route resolution reads neither field. [ADR-0004](0004-model-first-ad-hoc-routing.md)
is unchanged: the caller names provider, model, and effort, and the bridge
never substitutes them. Guidance is not qualification evidence and does not
extend what a route can do. `capabilities` remain the only statement of that.
A strength such as `computer-use` says the model suits the task; it does not
say the route was qualified for it.

The routing rules ship as `references/routing.md` of the `harness-relay` skill
(see the 2026-10-02 update of ADR-0023) and name no models:

- Explicit user choices and existing preferences come first.
- Routine work goes to the lowest tier and effort that can do it, and moves
  up one step at a time when the outcome shows that it was not enough.
- Hard decisions and open-ended reasoning go to the highest ready tier.
- A review uses a higher tier than the author's. When the author already has
  the highest ready tier, the review uses a different provider at that tier.
- Among routes that suit the task, `local` is preferred over `subscription`,
  and `subscription` over `metered`.
- A route without guidance is chosen only for low-stakes routine work or on
  request.

The skill reports the tier, route, effort, billing mode, and the reason for
each choice, and it says so when no ready route satisfies a rule.

## Consequences

- Built-in guidance is a maintained claim. It changes with the model manifest
  and needs the same review as a manifest change.
- Tier assignments across providers are coarse on purpose. Four tiers support
  "higher than" and "lowest sufficient"; they do not rank models within a tier.
- Cost preference is advice, in line with ADR-0023: the skill adds no
  mandatory limits. User constraints stay binding.
- A caller applying the review rule to its own work has to know its own tier.
  It looks its model up in the discovered routes and states the assumption
  when it is not listed.
- An older CLI returns routes without these fields. The skill then asks the
  user for the route instead of choosing from memory.
