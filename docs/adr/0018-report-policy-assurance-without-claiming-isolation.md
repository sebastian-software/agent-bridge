# ADR-0018: Report policy assurance without claiming isolation

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Harnesses expose different permission and sandbox controls. Codex can configure
native sandbox and approval policies, while Claude Code can constrain tools and
mediate permission requests. These mechanisms are useful but do not create a
uniform security boundary owned by the bridge.

A permitted shell command may access files or the network beyond the intended
workspace. Hooks, plugins, MCP servers, native configuration, harness defects,
and child processes can also have effects that a high-level profile does not
fully describe. Lightweight Git effect observation detects some changes after
the fact but does not prevent them.

## Decision

The bridge does not promise portable profiles named `read-only`,
`workspace-write`, or `unrestricted` as universal security guarantees.

Invocation policy is represented through three separate views:

- `requestedPolicy`: caller intent, such as desired filesystem, command,
  network, and additional-directory behavior;
- `effectiveNativePolicy`: the exact qualified controls the adapter configured
  in the selected harness; and
- `assurance`: the strength of the resulting claim.

The assurance levels are:

- `none`: no relevant control is evidenced;
- `native`: a documented and adapter-qualified harness mechanism applies, but
  the bridge does not claim an external isolation boundary; and
- `isolated`: an independent OS, container, VM, or equivalent boundary enforces
  the policy.

The MVP configures and reports native harness policies but does not itself
provide `isolated` assurance. If a caller requires a policy or minimum assurance
that no qualified route can provide, route resolution fails before execution.

## Consequences

- Native policies remain useful without being misrepresented as a bridge-owned
  sandbox.
- Outcomes record both requested intent and the exact effective native
  configuration.
- Adapter qualification must test and document the native controls supported
  by each harness version.
- Effect observation never upgrades an assurance level; detection is not
  prevention.
- A future container or OS-sandbox execution provider can add `isolated`
  routes without changing the invocation-policy model.
- Secrets, authentication context, and raw environment values are not included
  in policy evidence.
