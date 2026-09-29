# ADR-0025: Reuse an existing harness for local model execution

- **Status:** Accepted; Pi selected, production integration pending qualification
- **Date:** 2026-09-28

Local model support must work without Codex. The first increment supports both
Ollama and LM Studio with locally executing open models, such as suitable Kimi
or GLM variants. Local inference does not require all tools to operate offline;
tool network access remains subject to the requested execution policy.

The local routes must provide full agent execution, including reading and
changing files and running commands such as tests. Relay must reuse an existing
complete open-source harness or embeddable agent runtime rather than build its
own model/tool loop or coding-tool suite. A model API client alone does not meet
this requirement. Use the full Pi coding-agent SDK in a headless Relay-managed worker process.
This reuses its coding tools and agent loop without requiring a separate Pi
CLI installation or a terminal UI. Do not replace it with Pi's lower-level
model client or agent core, which would leave Relay responsible for supplying
the missing harness behavior.

This is execution within one caller-assigned invocation. The caller still owns
workflow ordering, recovery, account/model selection, and the final decision;
Relay does not gain an independent task-planning workflow or automatic fallback.
Local delegates participate in caller-to-delegate communication. Direct
delegate-to-delegate messaging is outside this increment.

Relay remains responsible for its adapter boundary: discovery, explicit
routing, connection selection, normalized events/outcomes, and qualification of
policy, identity, cancellation, and communication behavior. Reusing a runtime
does not establish these guarantees automatically. This is compatible with the
qualified optional library-adapter path in ADR-0015; it does not replace the
existing native Claude and Codex adapters.

Pi is selected for pragmatic integration, not on a claim of the lowest memory
use or fastest startup. Its distribution includes UI-related dependencies even
when no UI is presented. Pin and qualify the released SDK version; keep its
automatic retry/recovery behavior disabled where it would violate Relay's
caller-owned recovery contract. Model/provider errors must be mapped from the
observed outcome, not from whether `prompt()` resolves.

The initial [qualification](../research/pi-local-qualification.md) uses
`@earendil-works/pi-coding-agent` 0.87.1, now pinned as an optional worker
dependency. User-global `localRuntimes` profiles now register explicit local
routes through a Pi wrapper in the default registry. Profiles name the inference
server and loopback endpoint; `selector.runtimeId` distinguishes duplicate model
IDs across servers. The wrapper keeps model-vendor evidence separate from the
server, binds exact model snapshots, and does not create a fallback policy.

Ollama tool-capable models without native remote-model metadata can execute;
this is server-reported evidence, not a claim that every model is qualified.
LM Studio discovery alone cannot establish locality because LM Link can route
requests to another device, so its execution stays unqualified. Live model
qualification remains open for both runtimes. Pi offers assurance `none`, and
unsupported policy restrictions fail explicitly. Node >=22.19.0 is required by
this Pi version, stricter than Relay's current >=22 declaration; discovery and
the private worker check this before execution.
