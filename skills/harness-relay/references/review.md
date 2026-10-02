# Second opinions and reviews

A second opinion is a review with one contributor; a multi-model review has
several. Both follow the core procedure in [SKILL.md](../SKILL.md) for every
contributor, with these additions.

## Prepare

- Fix one review target and a stable basis: revision or files, the question,
  acceptance criteria, and user constraints. Keep contributors read-only unless
  the user explicitly asks one of them to implement a finding.
- Give every contributor the same evidence and ask for concrete findings with
  reasoning, severity or priority where useful, and optional suggestions.
- Preserve independence. When a first appraisal already exists, give the
  contributor the underlying question and evidence rather than that conclusion,
  so it is not led toward agreement or disagreement.

## Choose contributors

- Honor every explicit route preference. Without one, choose useful ready
  routes with [routing.md](routing.md) and record why: a reviewer needs a
  higher tier than the author, and a second opinion should preferably come
  from a different model family than the first appraisal.
- An explicitly requested contributor that is unavailable or ambiguous is a
  visible failed contributor, never silently replaced.
- The number and order of contributors belong to the caller and user; this
  skill imposes no limit.

## Run and record

- Keep the review prompt neutral. When contributors run concurrently, keep
  each invocation ID tied to its events and result.
- Record each contributor individually: route, requested and observed
  identity, status, findings, artifacts, diagnostics, usage, and effects.
  Failed or incomplete contributors stay visible with whatever they returned;
  partial participation is not a complete review.

## Synthesize

- Compare only after every contribution is recorded. Keep findings attributed
  to their contributors, including disagreements, uncertain assessments, and
  low-priority nits, and separate facts from recommendations.
- Explain corroboration and conflicts with evidence. Do not impose consensus,
  a majority vote, or forced resolution, and do not present a missing result
  as agreement.
- Report the contributor table or equivalent attribution, independence
  caveats, visible failures, and which contributors informed the final
  decision. The caller or user decides which findings are relevant.
