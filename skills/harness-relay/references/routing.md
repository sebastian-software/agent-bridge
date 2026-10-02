# Choosing a route and effort

Use this before a delegation, second opinion, or review whenever the user has
not named the model and effort. It decides which route to ask for; the core
procedure in [SKILL.md](../SKILL.md) runs the invocation. The caller remains
the root and owns the choice.

Which models exist, how capable they are, and what they cost changes faster
than this skill. Take those facts only from the installed CLI. Do not choose a
model from memory.

## Procedure

1. Read the facts. Prefer the installed `harness-relay`; otherwise use
   `npx --yes harness-relay@0.4.0`. Run `describe --json`, then <!-- x-release-please-version -->
   `routes --json`. Consider only routes with `readiness: ready`. For each,
   read:
   - `guidance.tier`: `frontier`, `strong`, `balanced`, or `fast`, from most
     to least capable. `guidance.strengths` lists what the model is
     particularly suited to. `guidance.source` says whether the assessment is
     built in or declared by the user; a user declaration takes precedence.
   - `efforts`: the effort levels the route accepts, lowest first for built-in
     routes.
   - `billing.mode`: `local` (runs on the user's hardware, no charge per
     use), `subscription` (flat rate that draws on a usage cap), `metered`
     (charged per use), or `unknown`.
   - `capabilities`: what the route can actually do.

   If no route carries `guidance`, the CLI predates route guidance. Ask the
   user which route to use, or report that you could not choose one.

2. Keep explicit choices. A provider, model, effort, harness family,
   connection, or cost constraint the user gave is binding. Apply the rules
   below only to what the user left open. If a requested route is unavailable,
   report that; do not replace it.

3. Decide what the task demands and take the lowest tier that meets it:

   | Task                                                                                          | Tier       | Effort        |
   | --------------------------------------------------------------------------------------------- | ---------- | ------------- |
   | Mechanical or routine: renames, formatting, boilerplate, lookups, summaries                   | `fast`     | lowest        |
   | Well-specified implementation or analysis with a clear check                                  | `balanced` | low to middle |
   | Multi-step implementation, debugging without a known cause, changes across several modules    | `strong`   | middle        |
   | Hard decisions: architecture, unclear trade-offs, security judgments, settling a disagreement | `frontier` | upper half    |

   Most work is routine. Start at the lower tier when a task sits between two
   rows, as long as you can check the result yourself.

4. Move up on evidence, one step at a time. When an outcome fails validation,
   is incomplete, or leaves the question open, raise the effort by one level
   or the tier by one step and say that you did. Do not start high in case the
   task turns out to be hard.

5. Review with a higher tier than the author's. For delegated work, the
   author's tier is that of the route that produced it. For your own work,
   find your own model in the routes; if it is not listed, state the tier you
   assume. When the author already has the highest ready tier, use a different
   provider at that tier. When no ready route is higher, say so; a review by
   an equal or lower tier does not satisfy this rule and must not be reported
   as if it did.

6. Match strengths to the task. When the task depends on something listed in
   `strengths`, such as `computer-use`, prefer a route that lists it. A
   strength describes the model. The route must still advertise every
   capability the task requires; pass those as required capabilities. If no
   ready route advertises one, report that the task is not qualified through
   Relay.

7. Weigh the cost. Among ready routes that satisfy steps 3 to 6, prefer
   `local`, then `subscription`, then `metered`. A subscription route draws
   on a cap shared with the user's other work, so keep high tiers and efforts
   for tasks that need them. Treat `unknown` as possibly charged. Cost never
   lowers the tier a task or a review requires. These are preferences; a user
   constraint on spending is binding.

8. Handle routes without guidance. Their tier is unknown. Choose one only for
   low-stakes routine work whose result you verify yourself, or when the user
   asks for it. A local model the user wants in regular use needs a guidance
   entry in the user's `config.json`.

9. Hand over and report. Continue the core procedure, or
   [review.md](review.md), with the chosen provider, model, effort, and harness
   family. In the report,
   state for each choice the task class, tier, route, effort, billing mode,
   and reason, each escalation, and any rule that no ready route could
   satisfy.
