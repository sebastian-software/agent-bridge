# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch. Older
releases are not patched separately — upgrade to the latest version to receive a
fix.

## Reporting a vulnerability

Report suspected vulnerabilities privately. Do not open a public issue, pull
request, or discussion for a vulnerability that has not been fixed yet.

Two private channels are available:

- **GitHub private vulnerability reporting** — open this repository's
  **Security** tab and choose **Report a vulnerability**.
- **Email** — security@sebastian-software.de.

Either channel is fine. Email is the one that always works: when the **Security**
tab offers no **Report a vulnerability** button, private reporting is not enabled
yet for this repository, so send the report by email instead.

Include a concise description, the affected version or commit, reproduction
steps, the impact you expect, and any suggested fix. Leave out credentials and
data you are not allowed to share.

## Response expectations

Maintainers aim to:

- Acknowledge a private report within 7 days.
- Assess severity and affected versions within 14 days.
- Coordinate a fix and a disclosure timeline with the reporter.
- Credit the reporter when desired and appropriate.

Timing can vary for low-impact reports and for reports that depend on a fix in
an upstream dependency.

## Scope

In scope: anything in this repository that lets someone read, modify, or execute
something they should not — including the released artifacts and the build and
release automation.

Usually out of scope: reports without a concrete impact path, vulnerabilities in
third-party dependencies used as documented, and problems that require an
already-compromised machine or a deliberately corrupted local state.

### What agent-bridge defends

`agent-bridge` supervises harness processes with the caller's own permissions;
it is not a sandbox around them. The "Process and security boundary invariants"
in [CONTEXT.md](CONTEXT.md) describe that boundary. A report is in scope when it
breaks one of them, for example:

- a route that resolves to an executable, URL, or shell fragment no adapter
  qualified, or a harness launched through a shell string built from caller
  input;
- credentials that reach argv, invocation input, events, outcomes, logs, or
  repository files;
- a cancelled or timed-out invocation that leaves a running descendant process;
- broker runtime or state paths that another local user can read, write, or
  redirect, including the socket and the persisted events and outcomes;
- malformed or incomplete harness output that yields a `completed` outcome, or
  untrusted harness output that the bridge follows as an instruction instead of
  reporting it as data.

Out of scope by design: what a delegated harness does inside the caller-chosen
working directory. The harness keeps the effective permissions of its process,
its native configuration, and its authenticated session, and effect observation
reports changes rather than providing isolation, attribution proof, or rollback.
