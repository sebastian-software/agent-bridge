import type { JsonValue, RouteDescriptor, StartInvocationRequest, Usage, WorkspaceEffect } from "../contract.js";
import { BridgeError } from "../errors.js";
import { type DiscoveryProbe, discoverManifestRoutes } from "./discovery.js";
import { type CommandSpec, ProcessAdapter, promptFor } from "./process.js";
import type { AdapterEvent, AdapterRunContext } from "./types.js";

const MANIFEST = {
  id: "codex",
  provider: "openai",
  via: "codex",
  command: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  qualifiedVersionRange: ">=0.149.0 <1.0.0",
  authenticationMode: "codex-native",
  models: ["gpt-5.5", "gpt-5.3-codex", "codex-mini-latest"].map((model) => ({
    model,
    efforts: ["low", "medium", "high", "max"],
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "unattended"] as const,
  })),
  qualificationClaim: "Codex CLI exec JSONL contract with native model, sandbox, approval, and workspace mapping.",
  policySupport: {
    filesystem: ["read-only", "workspace-write"],
    commands: ["allow"],
    network: ["allow", "deny"],
    additionalDirectories: ["supported"],
  },
} as const;

function reasoningEffort(value: string): string {
  return value === "max" ? "xhigh" : value;
}

function resolvePolicy(request: StartInvocationRequest): import("./types.js").PolicyResolution {
  const unsupported: string[] = [];
  if (request.requestedPolicy.filesystem === "inherit") {
    unsupported.push("requestedPolicy.filesystem=inherit");
  }
  if (request.requestedPolicy.commands === "deny") {
    unsupported.push("requestedPolicy.commands=deny");
  }
  if (request.requestedPolicy.network === "inherit") {
    unsupported.push("requestedPolicy.network=inherit");
  }
  const controls: Array<Readonly<Record<string, JsonValue>>> = [
    { flag: "--sandbox", value: request.requestedPolicy.filesystem === "read-only" ? "read-only" : "workspace-write" },
    { flag: "-c", value: "approval_policy=never" },
  ];
  if (request.requestedPolicy.network === "allow" || request.requestedPolicy.network === "deny") {
    controls.push({
      flag: "-c",
      value: `sandbox_workspace_write.network_access=${request.requestedPolicy.network === "allow"}`,
    });
  }
  for (const directory of request.requestedPolicy.additionalDirectories ?? []) {
    controls.push({ flag: "--add-dir", value: directory });
  }
  if (request.selector.effort !== undefined) {
    controls.push({ flag: "-c", value: `model_reasoning_effort=${reasoningEffort(request.selector.effort)}` });
  }
  return {
    supported: unsupported.length === 0,
    unsupported,
    effectiveNativePolicy: { adapter: "codex", controls },
  };
}

function sandbox(context: AdapterRunContext): string {
  if (context.request.requestedPolicy.filesystem === "read-only") {
    return "read-only";
  }
  if (context.request.requestedPolicy.filesystem === "workspace-write") {
    return "workspace-write";
  }
  return "workspace-write";
}

function usageFrom(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const numberValue = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
  const inputTokens = numberValue(source.input_tokens);
  const outputTokens = numberValue(source.output_tokens);
  const cacheReadTokens = numberValue(source.cached_input_tokens);
  const cacheWriteTokens = numberValue(source.cache_creation_input_tokens);
  const turns = numberValue(source.turns);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns].every((item) => item === undefined)) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(turns === undefined ? {} : { turns }),
    evidence: "reported",
    source: "codex-jsonl",
  };
}

function fileEffects(item: Record<string, unknown>): readonly WorkspaceEffect[] {
  if (item.type !== "file_change") {
    return [];
  }
  const changes = Array.isArray(item.changes) ? item.changes : [item];
  return changes.flatMap((change): WorkspaceEffect[] => {
    if (typeof change !== "object" || change === null || Array.isArray(change)) {
      return [];
    }
    const source = change as Record<string, unknown>;
    const path = typeof source.path === "string" ? source.path : undefined;
    if (path === undefined || path === "") {
      return [];
    }
    const rawKind =
      typeof source.kind === "string" ? source.kind : typeof source.change === "string" ? source.change : "modified";
    const kind =
      rawKind === "add" || rawKind === "create"
        ? "created"
        : rawKind === "delete" || rawKind === "remove"
          ? "deleted"
          : rawKind === "rename"
            ? "renamed"
            : "modified";
    return [{ path, kind, evidence: "harness-reported" }];
  });
}

export class CodexAdapter extends ProcessAdapter {
  readonly id = "codex";
  readonly #executable: string | undefined;
  readonly #probe: DiscoveryProbe | undefined;

  constructor(options?: { readonly executable?: string; readonly probe?: DiscoveryProbe }) {
    super();
    this.#executable = options?.executable ?? process.env.AGENT_BRIDGE_CODEX_PATH;
    this.#probe = options?.probe;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return discoverManifestRoutes(MANIFEST, {
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(this.#probe === undefined ? {} : { probe: this.#probe }),
    });
  }

  resolvePolicy(request: StartInvocationRequest, _route: RouteDescriptor): import("./types.js").PolicyResolution {
    return resolvePolicy(request);
  }

  protected command(context: AdapterRunContext): CommandSpec {
    if (context.route.executable === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: "Codex executable resolution was not retained for this route.",
        retryable: false,
      });
    }
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--model",
      context.route.canonicalModel ?? context.route.model,
      "--sandbox",
      sandbox(context),
      "--cd",
      context.request.workingDirectory,
      "-c",
      'approval_policy="never"',
      "-",
    ];
    if (context.route.effort !== undefined) {
      args.splice(-1, 0, "-c", `model_reasoning_effort=${reasoningEffort(context.route.effort)}`);
    }
    for (const directory of context.request.requestedPolicy.additionalDirectories ?? []) {
      args.splice(-1, 0, "--add-dir", directory);
    }
    return {
      executable: context.route.executable,
      args,
      stdin: promptFor(context),
      envDenyList: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: import("../contract.js").ObservedIdentity; content: { add(text: string): void } },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const threadId = typeof value.thread_id === "string" ? value.thread_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    const item =
      typeof value.item === "object" && value.item !== null ? (value.item as Record<string, unknown>) : undefined;
    const itemText = item === undefined ? undefined : typeof item.text === "string" ? item.text : undefined;
    if (threadId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined ? {} : { model: { value: model, evidence: "reported", source: "codex-jsonl" } }),
        ...(threadId === undefined
          ? {}
          : { nativeSessionId: { value: threadId, evidence: "reported", source: "codex-jsonl" } }),
      };
    }
    const effects = item === undefined ? [] : fileEffects(item);
    if (itemText !== undefined && item?.type === "agent_message") {
      state.content.add(itemText);
      return {
        category: "output",
        content: [{ type: "text", text: itemText }],
        ...(effects.length === 0 ? {} : { effects }),
        native: value,
      };
    }
    if (effects.length > 0) {
      return { category: "effect", effects, native: value };
    }
    if (item?.type === "reasoning") {
      return { category: "activity", data: { phase: "reasoning" }, native: value };
    }
    if (item?.type === "command_execution") {
      return { category: "activity", data: { phase: "command_execution" }, native: value };
    }
    if (type === "turn.completed") {
      const usage = usageFrom(value.usage);
      return {
        category: usage === undefined ? "lifecycle" : "usage",
        data: { state: "native_result", ...(usage === undefined ? {} : { usage: { ...usage } }) },
        ...(usage === undefined ? {} : { usage }),
        native: value,
      };
    }
    if (type.includes("error") || item?.type === "error") {
      return { category: "diagnostic", native: value };
    }
    return { category: "activity", data: { phase: type }, native: value };
  }
}
