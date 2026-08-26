# ADR-0003: Make in-place workspace execution the primary mode

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

A delegated harness may produce its useful result by modifying files rather
than returning text. In active development the orchestrator's workspace may
also contain uncommitted changes that the delegate needs to see. Automatically
moving every invocation to a clean worktree would hide that state and turn the
bridge into a source-control transaction manager.

Installed harnesses already run with the local user's effective permissions and
their own native approval, sandbox, tool, and network configuration. Wrapping
them does not make their effects transactional or universally restrictable.

## Decision

In-place execution is the primary workspace mode. The orchestrator supplies the
working directory and the target harness may leave file modifications or other
effects there.

The orchestrator owns preparation and recovery. It may commit, snapshot, copy,
stash, or create a temporary worktree before invoking the bridge. The bridge
does not automatically commit, revert, merge, or isolate the workspace.

The bridge is a lifecycle and interoperability boundary, not a universal
sandbox. It invokes an ad-hoc resolved harness route with an explicit execution
profile, but the effective authority remains determined by the operating system
and the harness's native configuration.

The bridge performs lightweight effect observation. For a Git workspace it
records sufficient before/after metadata to report changed paths and relevant
repository state. It does not create a commit, stash, worktree, full backup, or
rollback point. When effects cannot be observed completely, the outcome states
that limitation rather than claiming a complete change set.

## Consequences

- The orchestrator can inspect and continue from file changes immediately after
  the invocation returns.
- A failed, cancelled, or timed-out invocation may leave partial effects.
- The bridge must report terminal process state independently from whether the
  workspace is clean or the requested change is correct.
- Dirty workspaces are not rejected by default.
- The outcome distinguishes harness-reported changes from bridge-observed
  workspace effects.
- Effect observation is evidence for the orchestrator, not proof that every
  change was caused by the delegated harness; concurrent processes may also
  modify the workspace.
- Isolated copies or worktrees can be created by the orchestrator and passed as
  the invocation working directory without requiring a separate bridge mode.
- Automatic rollback is outside the core contract.
