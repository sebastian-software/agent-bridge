import type { JsonValue, RouteDescriptor } from "../contract.js";
import { BridgeError } from "../errors.js";
import { discoverManifestRoutes, type DiscoveryProbe } from "./discovery.js";
import { ProcessAdapter, promptFor, type CommandSpec } from "./process.js";
import type { AdapterEvent, AdapterRunContext } from "./types.js";

const MANIFEST = {
  id: "codex",
  provider: "openai",
  via: "codex",
  command: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  qualifiedMajor: 0,
  authenticationMode: "codex-native",
  models: ["gpt-5.5", "gpt-5.3-codex", "codex-mini-latest"].map((model) => ({
    model,
    efforts: ["low", "medium", "high", "max"],
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "unattended"] as const,
  })),
  qualificationClaim: "Codex CLI exec JSONL contract with native model, sandbox, approval, and workspace mapping.",
} as const;

function sandbox(context: AdapterRunContext): string {
  if (context.request.requestedPolicy.filesystem === "read-only") {
    return "read-only";
  }
  if (context.request.requestedPolicy.filesystem === "workspace-write") {
    return "workspace-write";
  }
  return "workspace-write";
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
      context.route.model,
      "--sandbox",
      sandbox(context),
      "--cd",
      context.request.workingDirectory,
      "-c",
      'approval_policy="never"',
      promptFor(context),
    ];
    for (const directory of context.request.requestedPolicy.additionalDirectories ?? []) {
      args.splice(-1, 0, "--add-dir", directory);
    }
    return { executable: context.route.executable, args };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: import("../contract.js").ObservedIdentity; content: { add(text: string): void } },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const threadId = typeof value.thread_id === "string" ? value.thread_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    const item = typeof value.item === "object" && value.item !== null ? value.item as Record<string, unknown> : undefined;
    const itemText = item === undefined ? undefined : typeof item.text === "string" ? item.text : undefined;
    if (threadId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined ? {} : { model: { value: model, evidence: "reported", source: "codex-jsonl" } }),
        ...(threadId === undefined ? {} : { nativeSessionId: { value: threadId, evidence: "reported", source: "codex-jsonl" } }),
      };
    }
    if (itemText !== undefined && (item?.type === "agent_message" || type === "item.completed")) {
      state.content.add(itemText);
      return { category: "output", content: [{ type: "text", text: itemText }], native: value };
    }
    if (type === "turn.completed") {
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    if (type.includes("error") || item?.type === "error") {
      return { category: "diagnostic", native: value };
    }
    return { category: "activity", data: { phase: type }, native: value };
  }
}
