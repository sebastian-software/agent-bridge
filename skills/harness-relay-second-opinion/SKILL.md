---
name: harness-relay-second-opinion
description: Obtain an independent appraisal of a bounded plan, change, or decision through a separate Harness Relay route while keeping the caller in control.
metadata:
  short-description: Get an independent second opinion
---

# Harness Relay second opinion

Use this skill when a bounded plan, implementation, analysis, or decision
would benefit from an independent appraisal. The caller remains the root and
chooses how the appraisal affects the final answer.

## Procedure

1. Capture the question and the material to appraise: the relevant revision,
   files, proposal, assumptions, acceptance criteria, and any user
   constraints. Ask for a reasoned assessment with concrete findings and
   suggested checks. Keep the appraisal read-only unless the user explicitly
   authorizes edits.

2. Bootstrap Harness Relay from the caller's environment. Prefer the installed
   `harness-relay`; otherwise use `npx --yes harness-relay@0.3.1`. Run <!-- x-release-please-version -->
   `describe --json` before choosing operations, then discover routes from the
   described contract or `harness-relay routes --json`. When syntax is needed,
   run `harness-relay run --help` (or the same `npx` command with `run --help`);
   an installed skill must not depend on repository documentation.

3. Honor explicit provider, model, effort, harness-family (`via`), capability,
   interaction, assurance, and other user preferences. If no route is
   specified, choose a qualified route suitable for the question, preferably
   from a different model family than the primary appraisal. If an explicitly
   requested route is unavailable or ambiguous, report that failure and do not
   silently substitute another route.

4. Preserve independence. If there is a first appraisal, collect the second
   opinion without its conclusion when practical; provide the underlying
   question and evidence instead of leading the delegate toward agreement or
   disagreement. Invoke one bounded appraisal through the documented `run`
   flow, or use `start`, `events`, and `result` when progress needs separate
   handling. Pass an absolute working directory and the user's requested
   policy. Never put credentials in the prompt or command line.

5. Preserve the complete outcome, including returned content, artifacts,
   terminal status, diagnostics, route and identity evidence, policy/assurance
   evidence, usage when present, effects, and observation completeness. A
   failed or incomplete opinion is reported as such alongside any available
   material. Do not present absence of a result as agreement or silently hide
   a failure. If the caller or user chooses a retry or other recovery, make it
   explicit and report each attempt.

6. Compare appraisals only after the independent result is recorded. Attribute
   each conclusion and finding to its contributor, identify agreement and
   disagreement, and separate facts from recommendations. The caller or user
   decides which assessment is correct and whether any change is warranted;
   this skill does not impose a vote, consensus, or automatic resolution.

7. Report the route used, independence caveats, status, useful findings,
   disagreements, observed effects and their completeness, and validation
   performed. State clearly which second opinion contributed to the final
   decision.
