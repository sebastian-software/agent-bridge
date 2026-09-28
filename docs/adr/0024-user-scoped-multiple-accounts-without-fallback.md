# ADR-0024: Keep multiple harness accounts user-scoped without automatic fallback

- **Status:** Accepted design for the next increment; not yet implemented
- **Date:** 2026-09-28

The next increment supports multiple selectable harness connections, configured
globally for the local operating-system user. A connection names access to a
harness's native configuration and authentication context and can have an
optional, freely assigned purpose description. It does not bind a model, effort
level, or workflow role. Accounts may serve different purposes, such as analysis
and implementation. Project-specific harness configuration and automatic
account or model switching are outside this
increment: they add policy and workflow ownership that are unnecessary for
making multiple accounts usable.

Relay continues to execute one invocation against one resolved route. If that
execution fails, including because capacity runs out after work has begun, Relay
returns the failure, available partial results, and observed effects. The caller
or human decides whether to retry, use another account, inspect the workspace,
or continue in a new worktree. Relay does not select another account or model,
retry the work, or manage recovery worktrees. This preserves ADR-0001,
ADR-0002, ADR-0003, and ADR-0004.

Without an explicit connection selection, Relay continues to use the harness's
normal native authentication context. Additional registered connections do not
become automatic alternatives. Provider and model remain explicit invocation
inputs; effort remains optional. Model and effort overrides apply to the
individual invocation rather than editing saved native defaults. Each adapter
must qualify the native override mechanism before claiming support.

Assisted setup supports both registering existing native contexts and preparing
separate contexts for additional accounts. The user authenticates through the
native harness; Relay does not copy credentials or perform a global account
switch. The configuration management interface remains to be specified. This
decision does not change the currently published request schema.
