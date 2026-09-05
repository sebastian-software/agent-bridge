# TanStack AI harness spike

This isolated package evaluates whether TanStack AI can implement the harness
adapter layer of agent-bridge without becoming the bridge's broker or public
operations contract.

The first measured run and architectural recommendation are recorded in
[RESULTS.md](./RESULTS.md).

## Acceptance criteria

The same runner must exercise Claude Code and Codex with:

- the existing host login;
- a caller-selected in-place working directory;
- ordered live stream chunks with bounded raw capture;
- a terminal result and native session/thread identifier;
- a second invocation that resumes the native session;
- cancellation through an `AbortSignal`; and
- observable workspace effects.

The spike must also record unsupported behavior rather than smoothing it over.
In particular, active-turn steering and orchestrator-mediated approval are
expected gaps and remain agent-bridge requirements.

## Safety

Run against a disposable Git repository. The delegated harness can execute
commands and modify files with its effective native permissions.

## Commands

```sh
pnpm install
pnpm check
pnpm run run -- --help
```

Raw JSONL is written outside the workspace by default and is intentionally not
versioned. It can contain prompts, tool arguments, command output, paths, and
provider metadata.
