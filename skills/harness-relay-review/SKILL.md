---
name: harness-relay-review
description: Coordinate a multi-model review through Harness Relay with contributor-attributed findings, disagreements, nits, and visible incomplete outcomes.
metadata:
  short-description: Run a contributor-attributed multi-model review
---

# Harness Relay multi-model review

Use this skill when the caller wants multiple model contributors to review the
same bounded change, proposal, or artifact. The caller remains the root: it
sets the review scope, coordinates invocations, and decides what to accept.

## Procedure

1. Establish one review target and a stable basis for comparison: revision or
   files, review question, acceptance criteria, user constraints, and whether
   contributors may edit. Reviews should be read-only unless the user
   explicitly asks for a contributor to implement a finding. Give each
   contributor the same relevant evidence and a request for concrete findings,
   reasoning, severity or priority when useful, and optional suggestions.

2. Bootstrap Harness Relay from the caller's environment. Prefer the installed
   `harness-relay`; otherwise use `npx --yes harness-relay@0.3.1`. Run <!-- x-release-please-version -->
   `describe --json` before relying on operations, then discover the qualified
   routes from the described contract or `harness-relay routes --json`. When
   syntax is needed, run `harness-relay run --help` (or the same `npx` command
   with `run --help`); an installed skill must not depend on repository
   documentation.

3. Honor every explicit model, provider, effort, harness-family (`via`),
   capability, interaction, assurance, and other user preference. When the
   contributors are unspecified, select a useful set of qualified routes for
   the review and record why they were chosen. An explicitly requested route
   that is unavailable or ambiguous is a visible failed contributor; never
   silently substitute a different model, effort, or harness. The number and
   ordering of contributors belong to the caller and user rather than to an
   arbitrary limit in this skill.

4. Run each bounded review through the documented `run` flow, or use `start`,
   `events`, and `result` when separate progress handling is useful. Keep the
   review prompt neutral and include an absolute working directory plus the
   smallest requested policy. Do not put credentials in prompts, arguments,
   or reports. If contributors run concurrently, preserve each invocation's
   ID and event/result association.

5. Record every contributor as an individual. For each, retain the selected
   route, requested and observed identity evidence, status, returned findings,
   artifacts, diagnostics, usage when present, effects, and effect-observation
   completeness. Failed, cancelled, timed-out, interrupted, unavailable, and
   incomplete contributors remain visible with their available results. Do not
   turn partial participation into an apparent successful review or silently
   hide failures. If the caller or user chooses a retry or other recovery, make
   it explicit and report each attempt.

6. Synthesize after recording the contributions. Keep findings attributed to
   their contributors, including disagreements, uncertain assessments, and
   low-priority nits. Explain corroboration and conflicts with evidence and
   preserve optional suggestions. This review reports perspectives; it does
   not require consensus, a majority verdict, or compulsory resolution of
   every disagreement.

7. Return the review to the caller with the complete contributor table or
   equivalent attribution, visible failures/incomplete work, observed effects
   and completeness, and validation performed. The caller or user decides
   which findings are relevant and whether to change the target. Say which
   contributors informed the final decision.
