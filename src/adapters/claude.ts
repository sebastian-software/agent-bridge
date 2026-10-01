import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterConnectionContext } from "../connections.js";
import type {
  JsonValue,
  ObservedIdentity,
  RequestedPolicy,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";
import type {
  AdapterConnectionRunContext,
  AdapterContinuationHandle,
  AdapterEvent,
  AdapterRunContext,
  PolicyResolution,
} from "./types.js";

import { BridgeError } from "../errors.js";
import {
  discoverManifestRoutes,
  type DiscoveryProbe,
  unavailableManifestRoutes,
} from "./discovery.js";
import { inspectNativeContextDirectory } from "./environment.js";
import { type CommandSpec, ProcessAdapter, promptFor } from "./process.js";

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

const CLAUDE_NAMED_CONTEXT_VERSION = "2.1.282";
// `--resume <id> --fork-session` was verified against 2.1.282: a fork keeps the
// session context, gets a new session ID, and leaves the original file unchanged.
const CLAUDE_CONTINUATION_VERSION_RANGE = ">=2.1.282 <3.0.0";
const CLAUDE_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLAUDE_NAMED_AUTH_ENVIRONMENT_DENY_LIST = [
  ...CLAUDE_SESSION_ENVIRONMENT_DENY_LIST,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

function settingsRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function unsupportedClaudeNamedSettings(path: string): Promise<string | undefined> {
  let source: string;
  try {
    source = await readFile(join(path, "settings.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    return "The selected Claude settings cannot be inspected safely. Check their permissions and retry.";
  }
  let settings: unknown;
  try {
    settings = JSON.parse(source) as unknown;
  } catch {
    return "The selected Claude settings are not valid JSON. Fix settings.json before using this named connection.";
  }
  const parsed = settingsRecord(settings);
  if (parsed === undefined) {
    return "The selected Claude settings must be a JSON object to qualify this named connection.";
  }
  if (Object.hasOwn(parsed, "apiKeyHelper")) {
    return "Named Claude connections do not support apiKeyHelper authentication. Use native login in the selected configuration directory.";
  }
  if (Object.hasOwn(parsed, "env")) {
    const environment = settingsRecord(parsed.env);
    if (environment === undefined || Object.keys(environment).length > 0) {
      return "Named Claude connections cannot qualify environment overrides in settings.json. Remove the env block and use native login in the selected configuration directory.";
    }
  }
  return undefined;
}

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
  versionCapabilities: [
    { range: CLAUDE_CONTINUATION_VERSION_RANGE, capabilities: ["continuation"] },
  ],
} as const;

function permissionModeFor(
  strategy: StartInvocationRequest["interactionStrategy"],
  policy: RequestedPolicy,
): string {
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

function resolvePolicy(request: StartInvocationRequest): PolicyResolution {
  const unsupported: string[] = [];
  if (
    request.requestedPolicy.network !== undefined &&
    request.requestedPolicy.network !== "inherit"
  ) {
    unsupported.push("requestedPolicy.network");
  }
  const controls: Array<Readonly<Record<string, JsonValue>>> = [
    {
      flag: "--permission-mode",
      value: permissionModeFor(request.interactionStrategy, request.requestedPolicy),
    },
  ];
  if (request.interactionStrategy === "orchestrator") {
    controls.push({ flag: "--input-format", value: "stream-json" });
    controls.push({ flag: "--permission-prompt-tool", value: "stdio" });
  }
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

function resumedSession(handle: AdapterContinuationHandle): string {
  if (!CLAUDE_SESSION_ID.test(handle.reference)) {
    throw new BridgeError({
      code: "continuation_unavailable",
      message: "The retained Claude session reference is not a native session ID.",
      retryable: false,
    });
  }
  return handle.reference;
}

function commandArgs(context: AdapterRunContext): readonly string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    context.route.nativeModel ?? context.route.model,
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
  if (context.continuationHandle !== undefined) {
    // A fork gives every continuation its own branch and leaves the original intact.
    args.push("--resume", resumedSession(context.continuationHandle), "--fork-session");
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

function numberValue(candidate: unknown): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function usageFrom(value: unknown): undefined | Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const inputTokens = numberValue(source.input_tokens);
  const outputTokens = numberValue(source.output_tokens);
  const cacheReadTokens = numberValue(source.cache_read_input_tokens);
  const cacheWriteTokens = numberValue(source.cache_creation_input_tokens);
  const costUsd = numberValue(source.total_cost_usd);
  const turns = numberValue(source.num_turns);
  if (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, turns].every(
      (item) => item === undefined,
    )
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

function messageBlocks(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const message = (value as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

function toolUseEffect(
  block: unknown,
): { readonly toolUseId: string; readonly effect: WorkspaceEffect } | undefined {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return undefined;
  }
  const source = block as Record<string, unknown>;
  if (
    source.type !== "tool_use" ||
    typeof source.id !== "string" ||
    !["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(String(source.name))
  ) {
    return undefined;
  }
  const input =
    typeof source.input === "object" && source.input !== null && !Array.isArray(source.input)
      ? (source.input as Record<string, unknown>)
      : {};
  const path = [input.file_path, input.path, input.notebook_path].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  );
  return path === undefined
    ? undefined
    : { toolUseId: source.id, effect: { path, kind: "modified", evidence: "harness-reported" } };
}

function toolResultIsDenied(block: Record<string, unknown>): boolean {
  if (block.is_error === true || block.is_denied === true || block.error === true) {
    return true;
  }
  const content =
    typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .filter(
              (part): part is { text: string } =>
                typeof part === "object" &&
                part !== null &&
                !Array.isArray(part) &&
                typeof (part as Record<string, unknown>).text === "string",
            )
            .map((part) => part.text)
            .join(" ")
        : "";
  return /(?:permission|user).*(?:denied|rejected)|denied|rejected|not allowed/i.test(content);
}

function confirmedToolEffects(
  value: Record<string, JsonValue>,
  state: { pendingEffects?: Map<string, WorkspaceEffect> },
): readonly WorkspaceEffect[] {
  const pendingEffects = state.pendingEffects;
  if (pendingEffects === undefined) {
    return [];
  }
  return messageBlocks(value).flatMap((block): WorkspaceEffect[] => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return [];
    }
    const source = block as Record<string, unknown>;
    if (source.type !== "tool_result" || typeof source.tool_use_id !== "string") {
      return [];
    }
    const effect = pendingEffects.get(source.tool_use_id);
    pendingEffects.delete(source.tool_use_id);
    return effect === undefined || toolResultIsDenied(source) ? [] : [effect];
  });
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
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string",
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
    this.#executable = options?.executable ?? process.env.HARNESS_RELAY_CLAUDE_PATH;
    this.#probe = options?.probe;
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    return discoverManifestRoutes(MANIFEST, {
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(this.#probe === undefined ? {} : { probe: this.#probe }),
    });
  }

  async discoverConnection(
    connection: AdapterConnectionContext,
  ): Promise<readonly RouteDescriptor[]> {
    const nativeContext = await inspectNativeContextDirectory(connection.nativeContextRef);
    if (nativeContext === undefined) {
      return unavailableManifestRoutes(
        MANIFEST,
        "Named Claude connections require an existing readable native configuration directory. Create or select that directory, authenticate Claude Code there, and retry discovery.",
      );
    }
    const unsupportedSettings = await unsupportedClaudeNamedSettings(nativeContext.path);
    if (unsupportedSettings !== undefined) {
      return unavailableManifestRoutes(MANIFEST, unsupportedSettings);
    }
    return discoverManifestRoutes(MANIFEST, {
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(this.#probe === undefined ? {} : { probe: this.#probe }),
      environment: {
        overrides: { CLAUDE_CONFIG_DIR: nativeContext.path },
        denyList: CLAUDE_NAMED_AUTH_ENVIRONMENT_DENY_LIST,
      },
      authenticationArgs: ["--setting-sources", "user", ...MANIFEST.authArgs],
      requiredVersion: CLAUDE_NAMED_CONTEXT_VERSION,
    });
  }

  protected override async validateConnectionInvocation(
    context: AdapterConnectionRunContext,
  ): Promise<void> {
    const unsupportedSettings = await unsupportedClaudeNamedSettings(
      context.connection.nativeContextRef,
    );
    if (unsupportedSettings !== undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: unsupportedSettings,
        retryable: false,
        details: { connectionId: context.connection.id },
      });
    }
  }

  resolvePolicy(request: StartInvocationRequest, _route: RouteDescriptor): PolicyResolution {
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
      args: [
        ...(context.connection === undefined ? [] : ["--setting-sources", "user"]),
        ...commandArgs(context),
      ],
      stdin: initialInput(context),
      ...(context.request.interactionStrategy === "orchestrator" ? { keepStdinOpen: true } : {}),
      ...(context.connection === undefined
        ? {
            envDenyList: CLAUDE_SESSION_ENVIRONMENT_DENY_LIST,
          }
        : {
            env: { CLAUDE_CONFIG_DIR: context.connection.nativeContextRef },
            envDenyList: CLAUDE_NAMED_AUTH_ENVIRONMENT_DENY_LIST,
          }),
    };
  }

  protected override continuationHandleFor(
    context: AdapterRunContext,
    identity: ObservedIdentity,
  ): AdapterContinuationHandle | undefined {
    const sessionId = identity.nativeSessionId.value;
    if (
      !context.route.capabilities.includes("continuation") ||
      sessionId === undefined ||
      !CLAUDE_SESSION_ID.test(sessionId)
    ) {
      return undefined;
    }
    return {
      reference: sessionId,
      expiresAt: new Date(Date.now() + CLAUDE_CONTINUATION_TTL_MS).toISOString(),
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: {
      identity: ObservedIdentity;
      content: { add: (text: string) => void; setFinal: (text: string) => void };
      pendingEffects?: Map<string, WorkspaceEffect>;
    },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    if (sessionId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined
          ? {}
          : { model: { value: model, evidence: "reported", source: "claude-stream" } }),
        ...(sessionId === undefined
          ? {}
          : {
              nativeSessionId: { value: sessionId, evidence: "reported", source: "claude-stream" },
            }),
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
    if (type === "user") {
      const effects = confirmedToolEffects(value, state);
      return effects.length === 0 ? undefined : { category: "effect", effects };
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
      const pendingEffects = state.pendingEffects ?? new Map<string, WorkspaceEffect>();
      state.pendingEffects ??= pendingEffects;
      for (const block of blocks) {
        const captured = toolUseEffect(block);
        if (captured !== undefined) {
          pendingEffects.set(captured.toolUseId, captured.effect);
        }
      }
      if (text !== undefined) {
        state.content.add(text);
        return {
          category: "output",
          content: [{ type: "text", text }],
          native: value,
        };
      }
      return undefined;
    }
    if (type === "result") {
      const text = typeof value.result === "string" ? value.result : undefined;
      const isError =
        value.is_error === true ||
        (typeof value.subtype === "string" && value.subtype.startsWith("error_"));
      if (!isError && text !== undefined && text.trim() !== "") {
        state.content.setFinal(text);
      }
      const usage = usageFrom({
        ...(typeof value.usage === "object" && value.usage !== null && !Array.isArray(value.usage)
          ? value.usage
          : {}),
        total_cost_usd: value.total_cost_usd,
        num_turns: value.num_turns,
      });
      const successMarker = !isError && text !== undefined && text.trim() !== "";
      return {
        category: usage === undefined ? "lifecycle" : "usage",
        data: {
          state: successMarker ? "native_result" : isError ? "native_failed" : "native_incomplete",
          ...(usage === undefined ? {} : { usage: { ...usage } }),
        },
        ...(usage === undefined ? {} : { usage }),
        ...(isError
          ? {
              failure: {
                code: typeof value.subtype === "string" ? value.subtype : "native_error",
                message:
                  typeof value.result === "string"
                    ? value.result
                    : "Claude reported an unsuccessful result.",
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
