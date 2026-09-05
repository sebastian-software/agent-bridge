import type {
  JsonValue,
  RequestedPolicy,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";
import { BridgeError } from "../errors.js";
import { type DiscoveryProbe, discoverManifestRoutes } from "./discovery.js";
import { type CommandSpec, ProcessAdapter, promptFor } from "./process.js";
import type { AdapterEvent, AdapterRunContext } from "./types.js";

export const CLAUDE_SESSION_ENVIRONMENT_DENY_LIST = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

const MANIFEST = {
  id: "claude",
  provider: "anthropic",
  via: "claude-code",
  command: "claude",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  qualifiedVersionRange: ">=2.1.0 <3.0.0",
  authenticationMode: "claude-native",
  models: [
    {
      model: "claude-opus-4-8",
      aliases: ["opus", "claude-opus-4-8"],
    },
    {
      model: "claude-sonnet-5",
      aliases: ["sonnet", "claude-sonnet-5"],
    },
    {
      model: "claude-haiku-4-5-20251001",
      aliases: ["haiku", "claude-haiku-4-5"],
    },
  ].map((model) => ({
    ...model,
    canonicalModel: model.model,
    efforts: ["low", "medium", "high", "max"],
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "orchestrator", "unattended"] as const,
  })),
  qualification: {
    qualificationId: "claude-code-v2-stream-json",
    testedAt: "2026-09-05T22:04:14+02:00",
    harnessVersion: "2.1.0",
    testSuite: "test/adapters.test.ts",
    testCommit: "2473c44fc41befe82847287b13af53245c008a39",
  },
  qualificationClaim:
    "Claude Code v2 native print-mode stream-json contract with model, effort, and permission mapping.",
  policySupport: {
    filesystem: ["read-only", "workspace-write"],
    commands: ["allow", "deny"],
    network: ["inherit"],
    additionalDirectories: ["supported"],
  },
} as const;

function permissionModeFor(strategy: StartInvocationRequest["interactionStrategy"], policy: RequestedPolicy): string {
  if (strategy === "deny") {
    return "dontAsk";
  }
  if (strategy === "orchestrator") {
    return "default";
  }
  if (policy.filesystem === "read-only") {
    return "plan";
  }
  return "acceptEdits";
}

function permissionMode(context: AdapterRunContext): string {
  return permissionModeFor(context.request.interactionStrategy, context.request.requestedPolicy);
}

function resolvePolicy(request: StartInvocationRequest): import("./types.js").PolicyResolution {
  const unsupported: string[] = [];
  if (request.requestedPolicy.filesystem === "inherit") {
    unsupported.push("requestedPolicy.filesystem=inherit");
  }
  if (request.requestedPolicy.network !== undefined && request.requestedPolicy.network !== "inherit") {
    unsupported.push("requestedPolicy.network");
  }
  const controls: Array<Readonly<Record<string, JsonValue>>> = [
    { flag: "--permission-mode", value: permissionModeFor(request.interactionStrategy, request.requestedPolicy) },
  ];
  if (request.requestedPolicy.commands === "deny") {
    controls.push({ flag: "--disallowedTools", value: ["Bash"] });
  }
  for (const directory of request.requestedPolicy.additionalDirectories ?? []) {
    controls.push({ flag: "--add-dir", value: directory });
  }
  return {
    supported: unsupported.length === 0,
    unsupported,
    effectiveNativePolicy: { adapter: "claude", controls },
  };
}

function commandArgs(context: AdapterRunContext): readonly string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    context.route.canonicalModel ?? context.route.model,
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
  if (context.request.interactionStrategy === "orchestrator") {
    args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");
  }
  return args;
}

function initialInput(context: AdapterRunContext): string {
  const prompt = promptFor(context);
  if (context.request.interactionStrategy !== "orchestrator") {
    return prompt;
  }
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
    session_id: null,
  })}\n`;
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
  const cacheReadTokens = numberValue(source.cache_read_input_tokens);
  const cacheWriteTokens = numberValue(source.cache_creation_input_tokens);
  const costUsd = numberValue(source.total_cost_usd);
  const turns = numberValue(source.num_turns);
  if (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, turns].every((item) => item === undefined)
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(turns === undefined ? {} : { turns }),
    ...(costUsd === undefined ? {} : { costUsd }),
    evidence: "reported",
    source: "claude-stream",
  };
}

function effectFromTool(block: unknown): WorkspaceEffect | undefined {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return undefined;
  }
  const source = block as Record<string, unknown>;
  if (source.type !== "tool_use" || !["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(String(source.name))) {
    return undefined;
  }
  const input =
    typeof source.input === "object" && source.input !== null && !Array.isArray(source.input)
      ? (source.input as Record<string, unknown>)
      : {};
  const path = [input.file_path, input.path, input.notebook_path].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  );
  return path === undefined ? undefined : { path, kind: "modified", evidence: "harness-reported" };
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
    .filter(
      (part): part is { text: string } =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string",
    )
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

  resolvePolicy(request: StartInvocationRequest, _route: RouteDescriptor): import("./types.js").PolicyResolution {
    return resolvePolicy(request);
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
    return {
      executable,
      args: commandArgs(context),
      stdin: initialInput(context),
      ...(context.request.interactionStrategy === "orchestrator" ? { keepStdinOpen: true } : {}),
      envDenyList: CLAUDE_SESSION_ENVIRONMENT_DENY_LIST,
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: {
      identity: import("../contract.js").ObservedIdentity;
      content: { add(text: string): void; setFinal(text: string): void };
    },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    if (sessionId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined ? {} : { model: { value: model, evidence: "reported", source: "claude-stream" } }),
        ...(sessionId === undefined
          ? {}
          : { nativeSessionId: { value: sessionId, evidence: "reported", source: "claude-stream" } }),
      };
    }
    if (type === "control_request") {
      const request =
        typeof value.request === "object" && value.request !== null && !Array.isArray(value.request)
          ? (value.request as Record<string, unknown>)
          : {};
      const requestId = typeof value.request_id === "string" ? value.request_id : undefined;
      const subtype = typeof request.subtype === "string" ? request.subtype : undefined;
      if (requestId !== undefined && subtype === "can_use_tool") {
        const toolName = typeof request.tool_name === "string" ? request.tool_name : undefined;
        const prompt =
          typeof request.message === "string"
            ? request.message
            : toolName === undefined
              ? "Claude requested permission to continue."
              : `Claude requests permission to use ${toolName}.`;
        return {
          category: "input_required",
          inputRequest: {
            requestId,
            kind: "permission",
            prompt,
            ...(toolName === undefined ? {} : { toolName }),
            ...(request.input === undefined ? {} : { input: request.input as JsonValue }),
          },
          native: value,
        };
      }
    }
    if (type === "assistant") {
      const text = textFromMessage(value.message);
      const blocks =
        typeof value.message === "object" &&
        value.message !== null &&
        "content" in value.message &&
        Array.isArray(value.message.content)
          ? value.message.content
          : [];
      const effects = blocks.map(effectFromTool).filter((effect): effect is WorkspaceEffect => effect !== undefined);
      if (text !== undefined) {
        return {
          category: "output",
          content: [{ type: "text", text }],
          ...(effects.length === 0 ? {} : { effects }),
          native: value,
        };
      }
      if (effects.length > 0) {
        return { category: "effect", effects, native: value };
      }
    }
    if (type === "result") {
      const text = typeof value.result === "string" ? value.result : undefined;
      if (text !== undefined) {
        state.content.setFinal(text);
      }
      const usage = usageFrom({
        ...(typeof value.usage === "object" && value.usage !== null ? value.usage : {}),
        total_cost_usd: value.total_cost_usd,
        num_turns: value.num_turns,
      });
      const isError =
        value.is_error === true || (typeof value.subtype === "string" && value.subtype.startsWith("error_"));
      return {
        category: usage === undefined ? "lifecycle" : "usage",
        data: { state: "native_result", ...(usage === undefined ? {} : { usage: { ...usage } }) },
        ...(usage === undefined ? {} : { usage }),
        ...(isError
          ? {
              failure: {
                code: typeof value.subtype === "string" ? value.subtype : "native_error",
                message: typeof value.result === "string" ? value.result : "Claude reported an unsuccessful result.",
              },
            }
          : {}),
        native: value,
      };
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
