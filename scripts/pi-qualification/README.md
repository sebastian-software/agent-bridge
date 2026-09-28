# Pi qualification probe

A development-only probe for the pinned full Pi coding-agent SDK. See the
[qualification report](../../docs/research/pi-local-qualification.md) for the
evidence and remaining release gates.

Requirements: macOS, Node >=22.19.0, pnpm 11.24.0. Run from the repository root:

```sh
pnpm --dir scripts/pi-qualification install --frozen-lockfile --ignore-scripts
pnpm --dir scripts/pi-qualification check
```

`verify.ts` starts `scenarios.ts` in a child process with a temporary home and
minimal environment. The scenarios start a loopback HTTP fixture, embed the
actual Pi SDK, and exercise its real coding tools. They create and remove files
only in the temporary test directory, including shell subprocesses for steering
and cancellation checks. A 45-second watchdog bounds the child run.

The model replies are scripted. This does not measure model quality or establish
Ollama/LM Studio compatibility. No cloud credentials, installed Pi CLI, local
model server, or downloaded model is required. This package is intentionally
outside Relay's production dependencies and default gate; run its check
explicitly when changing the probe or upgrading the pinned Pi release.
