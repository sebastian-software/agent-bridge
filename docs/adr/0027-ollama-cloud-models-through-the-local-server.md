# ADR-0027: Route Ollama cloud models through the local Ollama server

- **Status:** Accepted; live-qualified with GLM 5.3, Kimi K3, DeepSeek V4.1 Flash, and two free-plan models
- **Date:** 2026-10-02

## Context

[ADR-0025](0025-direct-local-model-access.md) lets Pi run models that an
Ollama or LM Studio server executes on the user's machine. Ollama can also list
cloud models, such as `glm-5.3:cloud` or `kimi-k3:cloud`. The local server
forwards their requests to ollama.com under the account that `ollama signin`
established. Until now Relay excluded every Ollama model that reported
`remote_host` or `remote_model`, because local routes promised local
inference.

Hosted open-weight models such as GLM and Kimi are useful delegates. Reaching
them directly through a vendor or an aggregator such as OpenRouter would make
Relay hold an API key. That would break a process invariant: the native
authenticated session is the credential boundary. The local Ollama server
already holds the sign-in, so Relay can reach these models while the
credential stays with the runtime.

## Decision

Ollama models that forward to Ollama's own cloud become Pi routes with
`inferenceLocation: "remote"`. Ollama models that execute locally report
`inferenceLocation: "local"`. LM Studio routes omit the field, because their
metadata does not establish where inference runs.

- A tag is a cloud model only when `/api/tags` names `remote_host` exactly
  `https://ollama.com` and a nonempty `remote_model`. Any other remote host or
  an incomplete entry stays excluded. `/api/show` may repeat the remote fields
  but must not contradict them. A local tag whose `/api/show` reports remote
  fields stays excluded as before.
- When the inventory contains a cloud model, discovery asks the server with
  `POST /api/me` whether it is signed in. Relay reads only the status code;
  the body carries account details or a sign-in link and is discarded. Without
  a confirmed sign-in, cloud routes are `unavailable` and tell the user to run
  `ollama signin`. Relay never signs in, and never falls back to another model
  or a local variant.
- Preflight repeats discovery, including the sign-in check. A sign-out after
  discovery fails the invocation with that reason.
- Ready cloud routes report `billing` `metered` with evidence `inferred`.
  Ollama prices every cloud request per token at the model's rate and draws it
  from the plan's included credits, then from purchased credits; this holds
  for the free plan too. Relay does not read the plan, so the evidence is
  inferred from the pricing model, not reported for the account.
- A ready cloud route means the server is signed in. It does not establish
  that the account's plan includes the model: discovery cannot learn that
  without spending a request. A model outside the plan fails the invocation
  with Ollama's own HTTP 402 message.
- Everything else matches local Ollama routes: Pi executes the tools on the
  user's machine, assurance stays `none`, the model vendor stays `unknown`
  unless the server establishes it, and the exact tag and digest are bound.

## Consequences

- A `remote` route sends the prompt and any workspace content the delegate
  reads to ollama.com. Callers and the routing skill must treat it as a hosted
  service: it does not satisfy a request to keep work on the machine.
- The glossary term "local delegate" now applies only to routes with
  `inferenceLocation: "local"`. A cloud route is a delegate whose tools run
  locally and whose inference does not.
- Relay still holds no model credentials. Direct vendor APIs and aggregators
  that require a key remain out of scope until a separate decision settles
  how Relay would hold one.
- Discovery adds one request per server that lists a cloud model. It stays
  within the existing request and inventory deadlines.
- The [qualification record](../qualification/2026-10-06-ollama-cloud-models.md)
  covers `glm-5.3:cloud`, `kimi-k3:cloud`, and `deepseek-v4.1-flash:cloud`
  with purchased credits,
  `gemma4:31b-cloud` and `gpt-oss:120b-cloud` on the free plan, and the 402
  failure for a model outside the plan. The fixture tests cover tag
  classification, the sign-in check, preflight after sign-out, and that no
  account detail or sign-in link reaches a route.
