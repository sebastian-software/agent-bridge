# Architecture decision records

ADRs are edited in place while the architecture is young. Git history records
how a decision changed; the current text is normative.

| ADR  | Decision                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0001 | Caller-owned orchestration                                                                                         |
| 0002 | One-shot harness delegation                                                                                        |
| 0003 | In-place workspace effects                                                                                         |
| 0004 | Model-first ad-hoc routing                                                                                         |
| 0005 | Asynchronous streaming invocations                                                                                 |
| 0006 | Local broker and self-describing CLI                                                                               |
| 0007 | TypeScript and Unix-first developer preview                                                                        |
| 0008 | Bidirectional Claude/Codex MVP                                                                                     |
| 0009 | Persist events and interrupt on restart                                                                            |
| 0010 | Steering and continuation as separate capabilities                                                                 |
| 0011 | Explicit interaction strategies                                                                                    |
| 0012 | Normalized events and typed content                                                                                |
| 0013 | Bounded invocation retention                                                                                       |
| 0014 | TanStack AI compatibility spike                                                                                    |
| 0015 | Native CLI integrations for the MVP                                                                                |
| 0016 | Bridge-owned invocation identity                                                                                   |
| 0017 | Requested, resolved, and observed identity                                                                         |
| 0018 | Policy assurance without an isolation claim                                                                        |
| 0019 | Atomic completed-invocation eviction                                                                               |
| 0020 | M0 operational decisions                                                                                           |
| 0021 | Rename the tool to harness-relay                                                                                   |
| 0022 | [Compose the README with mdtheme](0022-compose-readme-with-mdtheme.md)                                             |
| 0023 | [Ship caller-side delegation and workflow skills](0023-ship-caller-side-delegation-and-workflow-skills.md)         |
| 0024 | [User-scoped multiple accounts without automatic fallback](0024-user-scoped-multiple-accounts-without-fallback.md) |
| 0025 | [Reuse an existing harness for local model execution](0025-direct-local-model-access.md)                           |
| 0026 | [Publish advisory route guidance and ship a routing skill](0026-advisory-route-guidance-and-routing-skill.md)      |

Open questions are maintained in [`CONTEXT.md`](../../CONTEXT.md) and the
GitHub issue tracker rather than in stale ADR lists.
