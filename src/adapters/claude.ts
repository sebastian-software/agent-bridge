import type { JsonValue, RouteDescriptor } from "../contract.js";
import { BridgeError } from "../errors.js";
import { discoverManifestRoutes, type DiscoveryProbe } from "./discovery.js";
import { ProcessAdapter, promptFor, type CommandSpec } from "./process.js";
import type { AdapterEvent, AdapterRunContext } from "./types.js";

const MANIFEST = {
  id: "claude",
  provider: "anthropic",
  via: "claude-code",
  command: "claude",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  qualifiedMajor: 2,
  authenticationMode: "claude-native",
  models: ["opus", "sonnet", "haiku"].map((model) => ({
    model,
    efforts: ["low", "medium", "high", "max"],
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "unattended"] as const,
  })),
  qualificationClaim: "Claude Code v2 native print-mode stream-json contract with model, effort, and permission mapping.",
} as const;

function permissionMode(context: AdapterRunContext): string {
  if (context.request.interactionStrategy === "deny") {
    return "dontAsk";
  }
  if (context.request.requestedPolicy.filesystem === "read-only") {
    return "plan";
  }
  return "acceptEdits";
}

function commandArgs(context: AdapterRunContext): readonly string[] {
  const args = [
    "-p",
    promptFor(context),
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    context.route.model,
    "--permission-mode",
    permissionMode(context),
  ];
  if (context.route.effort !== undefined) {
    args.push("--effort", context.route.effort);
  }
  for (const directory of context.request.requestedPolicy.additionalDirectories ?? []) {
    args.push("--add-dir", directory);
  }
  if (context.request.requestedPolicy.commands === "deny") {
    args.push("--disallowedTools", "Bash");
  }
  return args;
}

function textFromMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return undefined;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter((part): part is { text: string } => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text === "" ? undefined : text;
}

export class ClaudeAdapter extends ProcessAdapter {
  readonly id = "claude";
  readonly #executable: string | undefined;
  readonly #probe: DiscoveryProbe | undefined;

  constructor(options?: { readonly executable?: string; readonly probe?: DiscoveryProbe }) {
    super();
    this.#executable = options?.executable ?? process.env.AGENT_BRIDGE_CLAUDE_PATH;
    this.#probe = options?.probe;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return discoverManifestRoutes(MANIFEST, {
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(this.#probe === undefined ? {} : { probe: this.#probe }),
    });
  }

  protected command(context: AdapterRunContext): CommandSpec {
    const executable = context.route.executable;
    if (executable === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: "Claude executable resolution was not retained for this route.",
        retryable: false,
      });
    }
    return { executable, args: commandArgs(context) };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: import("../contract.js").ObservedIdentity; content: { add(text: string): void } },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    if (sessionId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined ? {} : { model: { value: model, evidence: "reported", source: "claude-stream" } }),
        ...(sessionId === undefined ? {} : { nativeSessionId: { value: sessionId, evidence: "reported", source: "claude-stream" } }),
      };
    }
    if (type === "assistant") {
      const text = textFromMessage(value.message);
      if (text !== undefined) {
        state.content.add(text);
        return { category: "output", content: [{ type: "text", text }], native: value };
      }
    }
    if (type === "result") {
      const text = typeof value.result === "string" ? value.result : undefined;
      if (text !== undefined) {
        state.content.add(text);
        return { category: "output", content: [{ type: "text", text }], native: value };
      }
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    if (type === "system") {
      return { category: "activity", data: { phase: "native_system" }, native: value };
    }
    if (type.includes("error") || type === "diagnostic") {
      return { category: "diagnostic", native: value };
    }
    return { category: "activity", data: { phase: type }, native: value };
  }
}
