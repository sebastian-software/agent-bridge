import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml, type TomlTable } from "smol-toml";

import type { AdapterConnectionContext } from "../connections.js";
import type {
  JsonValue,
  ObservedIdentity,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";
import type {
  AdapterConnectionRunContext,
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

const CODEX_NAMED_CONTEXT_VERSION = "0.155.1";
const CODEX_SESSION_ENVIRONMENT_DENY_LIST = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"] as const;
const CODEX_NAMED_AUTH_ENVIRONMENT_DENY_LIST = [
  ...CODEX_SESSION_ENVIRONMENT_DENY_LIST,
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_PROFILE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT_ID",
] as const;

async function codexConfigPaths(
  nativeContextPath: string,
  workingDirectory?: string,
): Promise<readonly string[] | undefined> {
  const systemConfigPath =
    process.platform === "win32"
      ? join(process.env.ProgramData ?? "C:\\ProgramData", "OpenAI", "Codex", "config.toml")
      : "/etc/codex/config.toml";
  const paths = [systemConfigPath, join(nativeContextPath, "config.toml")];
  if (workingDirectory !== undefined) {
    const lexicalDirectory = resolve(workingDirectory);
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(lexicalDirectory);
    } catch {
      return undefined;
    }
    for (const root of new Set([lexicalDirectory, canonicalDirectory])) {
      let directory = root;
      paths.push(join(directory, "config.toml"));
      while (true) {
        paths.push(join(directory, ".codex", "config.toml"));
        const parent = dirname(directory);
        if (parent === directory) {
          break;
        }
        directory = parent;
      }
    }
  }
  return [...new Set(paths)];
}

async function unsupportedCodexContextMode(
  nativeContextPath: string,
  workingDirectory?: string,
): Promise<string | undefined> {
  if (process.env.CODEX_PROFILE !== undefined && process.env.CODEX_PROFILE !== "") {
    return "Named Codex connections do not support the inherited CODEX_PROFILE selector. Clear it and use a dedicated CODEX_HOME with native login. The default Codex route is unchanged.";
  }
  const configPaths = await codexConfigPaths(nativeContextPath, workingDirectory);
  if (configPaths === undefined) {
    return "The named Codex working directory cannot be resolved safely. Confirm it exists and retry.";
  }
  for (const configPath of configPaths) {
    let source: string;
    try {
      source = await readFile(configPath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      return "A Codex configuration used by this named connection cannot be inspected safely. Check its permissions and retry.";
    }

    let config: TomlTable;
    try {
      config = parseToml(source);
    } catch {
      return "A Codex configuration used by this named connection is not valid TOML. Fix the configuration or use a native context without it.";
    }
    if (Object.hasOwn(config, "profile")) {
      return "Named Codex connections do not support config.toml profile selection. Remove profile selectors and use a dedicated CODEX_HOME with native login. The default Codex route is unchanged.";
    }
    if (Object.hasOwn(config, "model_provider") && config.model_provider !== "openai") {
      return "Named Codex connections support only Codex's native OpenAI provider. Remove model_provider overrides from the selected context and working directory. The default Codex route is unchanged.";
    }
    if (Object.hasOwn(config, "model_providers")) {
      return "Named Codex connections cannot qualify custom model-provider tables. Remove model_providers tables from the selected context and working directory. The default Codex route is unchanged.";
    }
  }
  return undefined;
}

const MANIFEST = {
  id: "codex",
  provider: "openai",
  via: "codex",
  command: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  qualifiedVersionRange: ">=0.149.0 <1.0.0",
  authenticationMode: "codex-native",
  models: [
    { model: "gpt-5.5", aliases: ["gpt-5"] },
    { model: "gpt-5.3-codex", aliases: ["gpt-5-codex"] },
    { model: "codex-mini-latest", aliases: ["codex-mini"] },
  ].map((model) => ({
    ...model,
    canonicalModel: model.model,
    efforts: ["low", "medium", "high", "max"],
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "unattended"] as const,
  })),
  qualification: {
    qualificationId: "codex-cli-v0-jsonl",
    testedAt: "2026-09-05T22:04:14+02:00",
    harnessVersion: "0.149.0",
    testSuite: "test/adapters.test.ts",
    testCommit: "2473c44fc41befe82847287b13af53245c008a39",
  },
  qualificationClaim:
    "Codex CLI exec JSONL contract with native model, sandbox, approval, and workspace mapping.",
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

function resolvePolicy(request: StartInvocationRequest): PolicyResolution {
  const unsupported: string[] = [];
  if (request.requestedPolicy.commands === "deny") {
    unsupported.push("requestedPolicy.commands=deny");
  }
  if (
    request.requestedPolicy.filesystem === "read-only" &&
    request.requestedPolicy.network === "allow"
  ) {
    unsupported.push("requestedPolicy.network=allow with filesystem=read-only");
  }
  const controls: Array<Readonly<Record<string, JsonValue>>> = [
    {
      flag: "--sandbox",
      value: request.requestedPolicy.filesystem === "read-only" ? "read-only" : "workspace-write",
    },
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
    controls.push({
      flag: "-c",
      value: `model_reasoning_effort=${reasoningEffort(request.selector.effort)}`,
    });
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
  const cacheReadTokens = numberValue(source.cached_input_tokens);
  const cacheWriteTokens = numberValue(source.cache_creation_input_tokens);
  const turns = numberValue(source.turns);
  if (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns].every(
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
      typeof source.kind === "string"
        ? source.kind
        : typeof source.change === "string"
          ? source.change
          : "modified";
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
    this.#executable = options?.executable ?? process.env.HARNESS_RELAY_CODEX_PATH;
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
        "Named Codex connections require an existing readable native configuration directory. Create or select that directory, authenticate Codex there, and retry discovery.",
      );
    }
    const unsupportedMode = await unsupportedCodexContextMode(nativeContext.path);
    if (unsupportedMode !== undefined) {
      return unavailableManifestRoutes(MANIFEST, unsupportedMode);
    }
    return discoverManifestRoutes(MANIFEST, {
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(this.#probe === undefined ? {} : { probe: this.#probe }),
      environment: {
        overrides: { CODEX_HOME: nativeContext.path },
        denyList: CODEX_NAMED_AUTH_ENVIRONMENT_DENY_LIST,
      },
      requiredVersion: CODEX_NAMED_CONTEXT_VERSION,
    });
  }

  protected override async validateConnectionInvocation(
    context: AdapterConnectionRunContext,
  ): Promise<void> {
    const unsupportedMode = await unsupportedCodexContextMode(
      context.connection.nativeContextRef,
      context.request.workingDirectory,
    );
    if (unsupportedMode !== undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: unsupportedMode,
        retryable: false,
        details: { connectionId: context.connection.id },
      });
    }
  }

  resolvePolicy(request: StartInvocationRequest, _route: RouteDescriptor): PolicyResolution {
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
      context.route.nativeModel ?? context.route.model,
      "--sandbox",
      sandbox(context),
      "--cd",
      context.request.workingDirectory,
      "-c",
      'approval_policy="never"',
      "-",
    ];
    if (context.connection !== undefined) {
      args.splice(-1, 0, "-c", 'model_provider="openai"');
    }
    if (context.route.effort !== undefined) {
      args.splice(-1, 0, "-c", `model_reasoning_effort=${reasoningEffort(context.route.effort)}`);
    }
    if (
      context.request.requestedPolicy.network === "allow" ||
      context.request.requestedPolicy.network === "deny"
    ) {
      args.splice(
        -1,
        0,
        "-c",
        `sandbox_workspace_write.network_access=${context.request.requestedPolicy.network === "allow"}`,
      );
    }
    for (const directory of context.request.requestedPolicy.additionalDirectories ?? []) {
      args.splice(-1, 0, "--add-dir", directory);
    }
    return {
      executable: context.route.executable,
      args,
      stdin: promptFor(context),
      ...(context.connection === undefined
        ? { envDenyList: CODEX_SESSION_ENVIRONMENT_DENY_LIST }
        : {
            env: { CODEX_HOME: context.connection.nativeContextRef },
            envDenyList: CODEX_NAMED_AUTH_ENVIRONMENT_DENY_LIST,
          }),
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: {
      identity: ObservedIdentity;
      content: { add: (text: string) => void };
    },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    const threadId = typeof value.thread_id === "string" ? value.thread_id : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    const item =
      typeof value.item === "object" && value.item !== null
        ? (value.item as Record<string, unknown>)
        : undefined;
    const itemText =
      item === undefined ? undefined : typeof item.text === "string" ? item.text : undefined;
    if (threadId !== undefined || model !== undefined) {
      state.identity = {
        ...state.identity,
        ...(model === undefined
          ? {}
          : { model: { value: model, evidence: "reported", source: "codex-jsonl" } }),
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
      const status = typeof value.status === "string" ? value.status : undefined;
      const error =
        typeof value.error === "object" && value.error !== null && !Array.isArray(value.error)
          ? (value.error as Record<string, unknown>)
          : undefined;
      if (status === "failed" || error !== undefined) {
        return {
          category: usage === undefined ? "diagnostic" : "usage",
          data: { state: "native_failed", ...(usage === undefined ? {} : { usage: { ...usage } }) },
          ...(usage === undefined ? {} : { usage }),
          failure: {
            code:
              typeof error?.code === "string"
                ? error.code
                : typeof value.code === "string"
                  ? value.code
                  : "native_error",
            message:
              typeof error?.message === "string"
                ? error.message
                : "Codex reported an unsuccessful turn.",
          },
          native: value,
        };
      }
      return {
        category: usage === undefined ? "lifecycle" : "usage",
        data: { state: "native_result", ...(usage === undefined ? {} : { usage: { ...usage } }) },
        ...(usage === undefined ? {} : { usage }),
        native: value,
      };
    }
    if (type === "error" || type === "turn.failed" || type === "turn.error") {
      const error =
        typeof value.error === "object" && value.error !== null && !Array.isArray(value.error)
          ? (value.error as Record<string, unknown>)
          : undefined;
      return {
        category: "diagnostic",
        data: { state: "native_failed" },
        failure: {
          code:
            typeof error?.code === "string"
              ? error.code
              : typeof value.code === "string"
                ? value.code
                : type,
          message:
            typeof error?.message === "string"
              ? error.message
              : typeof value.message === "string"
                ? value.message
                : "Codex reported an unsuccessful turn.",
        },
        native: value,
      };
    }
    if (item?.type === "error") {
      return {
        category: "diagnostic",
        data: {
          phase: "item_error",
          ...(typeof item.message === "string" ? { message: item.message } : {}),
        },
        native: value,
      };
    }
    return { category: "activity", data: { phase: type }, native: value };
  }
}
