# Local models through Pi

Harness Relay uses the embedded Pi coding harness to execute tools while a
configured model runtime serves inference. You do not need Codex or the Pi CLI.
The optional Pi SDK dependency must be installed, and the worker requires Node.js
22.19 or later on macOS or Linux.

Ollama routes can execute when their native metadata identifies an installed,
nonremote model with tool support. LM Studio discovery reports loaded models,
but execution remains unavailable: a loopback LM Studio server can use LM Link
to route inference to another device, and the current adapter cannot establish
that the model runs locally. Loaded-model metadata alone is insufficient.

Three Ollama configurations are live-qualified, each only as tested:
[qwen3:8b](qualification/2026-09-30-ollama-qwen3-8b.md),
[gemma4:26b-a4b](qualification/2026-09-30-ollama-gemma4-26b-a4b.md), and
[gemma4:e4b](qualification/2026-10-01-ollama-gemma4-e4b.md). The records cover
locality evidence, tool use, steering, continuation, cancellation, timeout,
failure cases, and the model behavior observed. Both Gemma models kept tool
calls sequential and reported accurately without ordering hints; qwen3:8b
needed them.

## Configure an existing runtime

Start the runtime and install the desired model using its own tools. Relay does
not download models, start servers, or request model loading during discovery.
Use a Relay build that includes local runtime routes; the configuration below is
not supported by earlier releases.

Merge a `localRuntimes` array into the existing user configuration at
`~/.config/harness-relay/config.json`. Preserve other configuration fields. The
normal `XDG_CONFIG_HOME` and `HARNESS_RELAY_CONFIG_PATH` overrides also apply.

```json
{
  "localRuntimes": [
    {
      "id": "ollama-mac",
      "kind": "ollama",
      "endpoint": "http://127.0.0.1:11434"
    },
    {
      "id": "lm-studio-mac",
      "kind": "lm-studio",
      "endpoint": "http://127.0.0.1:1234"
    }
  ]
}
```

Each profile has exactly these three fields. IDs are unique user-selected labels.
Endpoints must use HTTP on a loopback address, without credentials, paths, query
strings, or fragments. `localhost` is normalized to `127.0.0.1`. Discovery requests do not follow redirects. Profiles do not accept API keys, arbitrary headers, or commands.

Refresh discovery after configuration or model changes:

```sh
harness-relay routes --refresh --json
```

Inspect the route's readiness, diagnostics, model, provider, and `runtimeId`.
The provider identifies the model vendor, not Ollama, LM Studio, or Pi. When
native metadata does not establish a vendor, the route reports `unknown`.
Copy the values from discovery rather than guessing a vendor from a model name.

## Run a bounded task

Select the exact model and runtime. For example, after discovery reports a ready
route with provider `unknown`, substitute its exact model ID below:

```sh
harness-relay run \
  --provider unknown \
  --model '<exact model ID from discovery>' \
  --via pi \
  --runtime ollama-mac \
  --cwd /absolute/path/to/worktree \
  --text 'Inspect the project and summarize the next useful change.' \
  --interaction unattended \
  --minimum-assurance none \
  --filesystem inherit \
  --commands allow \
  --network allow
```

Use `--runtime` to distinguish servers that expose the same model. The typed
client and MCP use `selector.runtimeId` for the same selection. Runtime profiles
are user-global; the invocation's working directory selects where tools work.

Pi provides its native coding tools. The worker does not sandbox those tools:
local inference does not imply restricted filesystem access or offline tool
execution. These routes provide assurance `none`; requests for unsupported
restrictions fail before execution. Choose a working directory and permissions
appropriate for the task.

Ready Ollama routes also advertise text-only `steering`. A scripted
wrapper-to-SDK fixture checks that early input waits for route preflight, the
active invocation keeps its original Pi adapter after profile removal, the SDK
acknowledges accepted input, and corrections reach later model requests in
order. This qualifies the input boundary only; it does not show that a live
model consumed or followed an instruction. LM Studio routes remain unqualified
for execution and do not advertise steering.

Relay rechecks the configured runtime and model before starting. A changed
endpoint, model digest, or other bound identity fails explicitly instead of
silently switching to another server or model. The caller decides whether to
refresh discovery and submit another invocation. There is no automatic fallback.

## Interpret failures and evidence

- A stopped server, missing optional Pi SDK, empty inventory, or model without
  reported tool support produces an unavailable route or diagnostic.
- Ollama entries with native remote-model metadata are excluded. Tool support
  and model identity are reported by the server; they are not proof that every
  task or model family will succeed.
- LM Studio loaded models remain unqualified for local execution until locality
  can be established. An unloaded model is not loaded automatically.
- Discovery uses bounded requests and bounded response sizes. A partial inventory
  can contain diagnostics when the server exceeds the discovery deadline.
- Cancellation supervises the Pi worker and its tools. It does not prove that
  an external inference server immediately stopped computing after disconnect.

The regression suite exercises native API fixtures, exact route binding, and
worker behavior. Those checks do not establish the quality of a downloaded model
or qualify every Kimi, GLM, or other model variant. Live local-model qualification
is tracked separately from protocol tests.

## Opt-in live qualification

Use an already installed model and an isolated scratch project. The default
suite does not download one. `gemma4:e4b` (6.6 GB) is the smallest model that
passed this procedure and a reasonable choice for repeating it. Record the exact model tag and digest, runtime and
Relay versions, Pi SDK version, Node version, OS, memory, and model settings.
Keep this record separate from deterministic fixture results.

1. Refresh routes and retain the selected route's JSON, including diagnostics
   and identity evidence. Confirm the runtime's own native configuration uses
   local inference. A loopback URL by itself is insufficient evidence.
2. Run one bounded task that asks the delegate to create `probe.txt` containing
   `before`, read it, replace its contents with `after`, and execute
   `node -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("probe.txt", "utf8").trim(), "after")'`.
   Request a brief report of the observed result. Use the exact discovered
   selector and a caller-chosen timeout with the command above.
3. Retain events and the terminal outcome. Independently inspect `probe.txt`
   and the command's result; assistant text alone does not demonstrate successful
   tool use. Check the runtime's request log or native observation for the exact
   selected model, without copying credentials.
4. For a route advertising continuation, continue the completed invocation with
   a question about its earlier work and inspect the retained conversation
   behavior. For a route advertising steering, send an instruction during a
   controlled long-running tool call and verify that the tool completes and
   the instruction reaches a later processing boundary.
5. In a separate run, cancel during a controlled tool call and verify the
   terminal status, partial output, and process cleanup. Test an invocation
   timeout separately. Report inference-server cancellation only to the extent
   the server exposes evidence; HTTP disconnect is insufficient.
6. Exercise missing-model and stopped-server failures using a dedicated test
   runtime. Check that the caller receives an explicit failure and no alternate
   model request occurs. Restore the test runtime after the check.

Record any model-specific failures or omitted checks. A successful run qualifies
only the tested configuration and task boundaries, not an entire model family.
LM Studio execution qualification must first establish locality; current routes
remain unavailable for these execution steps.

See [the CLI reference](cli.md) for invocation operations and
[adapter support](adapters.md) for capability and assurance boundaries.
