import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { EvidenceStatus } from "./contract.js";

import { BridgeError } from "./errors.js";

export type LocalRuntimeKind = "lm-studio" | "ollama";

export type LocalRuntimeProfile = {
  readonly id: string;
  readonly kind: LocalRuntimeKind;
  readonly endpoint: string;
  readonly revision: string;
};

/** Where a model runtime reports that inference for a model takes place. */
export type InferenceLocation = "local" | "remote";

export type LocalRuntimeModel = {
  readonly id: string;
  /** Absent when the runtime's metadata does not establish where inference runs. */
  readonly inferenceLocation?: InferenceLocation;
  /** The model name on the remote host, for a model the runtime forwards there. */
  readonly remoteModel?: string;
  readonly provider: string;
  readonly providerEvidence: EvidenceStatus;
  readonly digest?: string;
  readonly instanceId?: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly capabilities: readonly string[];
  /**
   * Thinking levels the server accepts as `reasoning_effort`, lowest first.
   * `none` turns thinking off; the empty list means only the server default.
   */
  readonly efforts: readonly string[];
  readonly readiness: "ready" | "unavailable" | "unqualified";
  readonly diagnostics: readonly string[];
  readonly identityEvidence: EvidenceStatus;
  readonly canonicalModel: string;
};

export type LocalRuntimeInventory = {
  readonly profile: LocalRuntimeProfile;
  readonly serverVersion?: string;
  readonly models: readonly LocalRuntimeModel[];
  readonly diagnostics: readonly string[];
};

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 3000;
const INVENTORY_TIMEOUT_MS = 10_000;
const MAX_RUNTIME_PROFILES = 16;
const MAX_OLLAMA_MODELS = 64;
const MODEL_SHOW_CONCURRENCY = 4;
/** The only remote host whose Ollama models become routes: Ollama's own cloud. */
const OLLAMA_CLOUD_HOST = "https://ollama.com";

function invalidConfig(message: string): never {
  throw new BridgeError({
    code: "invalid_request",
    message,
    retryable: false,
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function loopbackEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalidConfig(`${field} must be a loopback HTTP endpoint.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfig(`${field} must be a loopback HTTP endpoint.`);
  }
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, "").toLowerCase();
  const ipv4Loopback =
    isIP(hostname) === 4 && Number.parseInt(hostname.split(".")[0] ?? "", 10) === 127;
  const ipv6Loopback = isIP(hostname) === 6 && hostname === "::1";
  if (
    url.protocol !== "http:" ||
    (hostname !== "localhost" && !ipv4Loopback && !ipv6Loopback) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    invalidConfig(
      `${field} must use plain HTTP on localhost, 127.0.0.0/8, or ::1 without credentials, a path, query, or fragment.`,
    );
  }
  if (hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.origin;
}

function profileRevision(profile: Omit<LocalRuntimeProfile, "revision">): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
}

function parseProfile(value: unknown, index: number): Omit<LocalRuntimeProfile, "revision"> {
  const field = `config.localRuntimes[${index}]`;
  const source = object(value);
  if (source === undefined) {
    invalidConfig(`${field} must be an object.`);
  }
  const unexpectedKeys = Object.keys(source).filter(
    (key) => !["id", "kind", "endpoint"].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    invalidConfig(`${field} contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
  }
  if (typeof source.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(source.id)) {
    invalidConfig(
      `${field}.id must start with a letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }
  if (source.kind !== "ollama" && source.kind !== "lm-studio") {
    invalidConfig(`${field}.kind must be ollama or lm-studio.`);
  }
  return {
    id: source.id,
    kind: source.kind,
    endpoint: loopbackEndpoint(source.endpoint, `${field}.endpoint`),
  };
}

export function parseLocalRuntimeProfiles(
  value: unknown,
  path = "config.json",
): readonly LocalRuntimeProfile[] {
  const root = object(value);
  if (root === undefined) {
    invalidConfig(`Config file ${path} must contain a JSON object.`);
  }
  if (root.localRuntimes === undefined) {
    return [];
  }
  if (!Array.isArray(root.localRuntimes)) {
    invalidConfig(`${path}: localRuntimes must be an array.`);
  }
  if (root.localRuntimes.length > MAX_RUNTIME_PROFILES) {
    invalidConfig(`${path}: localRuntimes supports at most ${MAX_RUNTIME_PROFILES} profiles.`);
  }
  const parsed = root.localRuntimes.map((profile, index) => parseProfile(profile, index));
  const ids = new Set<string>();
  for (const profile of parsed) {
    if (ids.has(profile.id)) {
      invalidConfig(`${path}: local runtime profile id ${profile.id} is duplicated.`);
    }
    ids.add(profile.id);
  }
  return parsed.map((profile) => ({ ...profile, revision: profileRevision(profile) }));
}

export async function loadLocalRuntimeProfiles(
  path: string,
): Promise<readonly LocalRuntimeProfile[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Config file ${path} could not be read.`,
        retryable: false,
      },
      { cause: error },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch (error) {
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Config file ${path} is not valid JSON.`,
        retryable: false,
      },
      { cause: error },
    );
  }
  return parseLocalRuntimeProfiles(decoded, path);
}

function hasRemoteOllamaFields(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "remote_host") || Object.hasOwn(value, "remote_model");
}

/** The cloud model name when an entry names exactly Ollama's cloud host and one remote model. */
function ollamaCloudModel(value: Record<string, unknown>): string | undefined {
  const host = value.remote_host;
  const model = value.remote_model;
  if (typeof host !== "string" || typeof model !== "string" || model === "") {
    return undefined;
  }
  try {
    const url = new URL(host);
    const plain =
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/");
    return plain && url.origin === OLLAMA_CLOUD_HOST ? model : undefined;
  } catch {
    return undefined;
  }
}

type OllamaSignIn = "signed-in" | "signed-out" | "unknown";

/**
 * Ask the local Ollama server whether it is signed in to ollama.com. Only the
 * status code is used: the response body carries account details or a sign-in
 * link, and neither belongs in a route.
 */
async function ollamaSignIn(
  profile: LocalRuntimeProfile,
  signal: AbortSignal,
): Promise<OllamaSignIn> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  try {
    const response = await fetch(new URL("/api/me", `${profile.endpoint}/`), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: requestSignal,
    });
    await response.body?.cancel().catch((error: unknown) => error);
    if (response.ok) {
      return "signed-in";
    }
    return response.status === 401 ? "signed-out" : "unknown";
  } catch {
    return "unknown";
  }
}

async function boundedJsonRequest(
  profile: LocalRuntimeProfile,
  pathname: string,
  signal: AbortSignal,
  body?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  try {
    const response = await fetch(new URL(pathname, `${profile.endpoint}/`), {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch((error: unknown) => error);
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("empty response body");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch((error: unknown) => error);
        throw new Error("response exceeded the 2 MiB limit");
      }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Local runtime discovery exceeded its ${INVENTORY_TIMEOUT_MS} ms deadline.`, {
        cause: error,
      });
    }
    if (requestSignal.aborted) {
      throw new Error(`${pathname} request timed out after ${REQUEST_TIMEOUT_MS} ms.`, {
        cause: error,
      });
    }
    if (error instanceof Error && error.message.startsWith("HTTP ")) {
      throw new Error(`${pathname} returned ${error.message}.`, { cause: error });
    }
    if (error instanceof Error && error.message.includes("2 MiB")) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new TypeError(`${pathname} did not return valid JSON.`, { cause: error });
    }
    throw new Error(`${pathname} could not be reached or returned an invalid response.`, {
      cause: error,
    });
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Levels Pi can request without clamping them to a neighbor. */
const PI_EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Map Ollama's reported thinking values to efforts. `false` becomes `none`;
 * `true` only toggles thinking on and adds nothing. A level Pi cannot request
 * exactly is left out rather than approximated.
 */
function ollamaEfforts(show: Record<string, unknown>): readonly string[] {
  const values = object(show.thinking)?.values;
  if (!Array.isArray(values)) {
    return [];
  }
  const efforts: string[] = [];
  for (const value of values) {
    const effort =
      value === false
        ? "none"
        : typeof value === "string" && PI_EFFORT_LEVELS.has(value)
          ? value
          : undefined;
    if (effort !== undefined && !efforts.includes(effort)) {
      efforts.push(effort);
    }
  }
  return efforts;
}

function ollamaContextWindow(show: Record<string, unknown>): number {
  const modelInfo = object(show.model_info);
  for (const [key, value] of Object.entries(modelInfo ?? {})) {
    if (key.endsWith(".context_length")) {
      const contextWindow = positiveInteger(value);
      if (contextWindow !== undefined) {
        return contextWindow;
      }
    }
  }
  return 8192;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = Array.from<R | undefined>({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await callback(item);
    }
  });
  await Promise.all(workers);
  return results as readonly R[];
}

async function discoverOllama(
  profile: LocalRuntimeProfile,
  signal: AbortSignal,
): Promise<LocalRuntimeInventory> {
  let versionPayload: unknown;
  let tagsPayload: unknown;
  try {
    [versionPayload, tagsPayload] = await Promise.all([
      boundedJsonRequest(profile, "/api/version", signal),
      boundedJsonRequest(profile, "/api/tags", signal),
    ]);
  } catch (error) {
    return {
      profile,
      models: [],
      diagnostics: [
        `Ollama profile ${profile.id} is unavailable at ${profile.endpoint}: ${error instanceof Error ? error.message : "request failed"}. Start Ollama or update the configured loopback endpoint.`,
      ],
    };
  }
  const version = object(versionPayload)?.version;
  const tags = object(tagsPayload)?.models;
  if (typeof version !== "string" || version === "" || !Array.isArray(tags)) {
    return {
      profile,
      models: [],
      diagnostics: [
        `Ollama profile ${profile.id} did not return the expected /api/version and /api/tags responses. Check that the endpoint is an Ollama server.`,
      ],
    };
  }
  if (tags.length > MAX_OLLAMA_MODELS) {
    return {
      profile,
      serverVersion: version,
      models: [],
      diagnostics: [
        `Ollama profile ${profile.id} reported more than ${MAX_OLLAMA_MODELS} models; discovery was bounded.`,
      ],
    };
  }
  const diagnostics: string[] = [];
  const entries = tags.flatMap((value) => {
    const tag = object(value);
    if (tag === undefined) {
      diagnostics.push("Ollama returned a malformed model entry; that entry was skipped.");
      return [];
    }
    const remoteModel = hasRemoteOllamaFields(tag) ? ollamaCloudModel(tag) : undefined;
    if (hasRemoteOllamaFields(tag) && remoteModel === undefined) {
      const id = typeof tag.name === "string" ? tag.name : "an unnamed model";
      diagnostics.push(
        `Ollama model ${id} forwards to a remote model that is not a complete ${OLLAMA_CLOUD_HOST} cloud entry and was excluded from routes.`,
      );
      return [];
    }
    const id = typeof tag.name === "string" ? tag.name : tag.model;
    const digest = tag.digest;
    if (typeof id !== "string" || id === "" || typeof digest !== "string" || digest === "") {
      diagnostics.push(
        "Ollama returned a model without an exact name or digest; that entry was skipped.",
      );
      return [];
    }
    return [{ id, digest, remoteModel }];
  });
  // Cloud models run only for a server signed in to ollama.com; local models never need it.
  const signIn = entries.some((entry) => entry.remoteModel !== undefined)
    ? await ollamaSignIn(profile, signal)
    : undefined;
  const models = await mapConcurrent(
    entries,
    MODEL_SHOW_CONCURRENCY,
    async ({ id, digest, remoteModel }) => {
      if (signal.aborted) {
        return;
      }
      try {
        const showPayload = await boundedJsonRequest(profile, "/api/show", signal, { model: id });
        const show = object(showPayload);
        if (show === undefined) {
          throw new TypeError("/api/show did not return an object");
        }
        if (remoteModel === undefined && hasRemoteOllamaFields(show)) {
          diagnostics.push(
            `Ollama model ${id} exposed remote_host or remote_model in /api/show and was excluded from local routes.`,
          );
          return;
        }
        if (
          remoteModel !== undefined &&
          hasRemoteOllamaFields(show) &&
          ollamaCloudModel(show) !== remoteModel
        ) {
          diagnostics.push(
            `Ollama /api/show named a different remote model for ${id}; that entry was skipped.`,
          );
          return;
        }
        if (
          (typeof show.name === "string" && show.name !== id) ||
          (typeof show.model === "string" && show.model !== id)
        ) {
          diagnostics.push(
            `Ollama /api/show returned a different model identity for ${id}; that entry was skipped.`,
          );
          return;
        }
        const capabilities = Array.isArray(show.capabilities)
          ? show.capabilities.filter((entry): entry is string => typeof entry === "string")
          : [];
        const tools = capabilities.includes("tools");
        const signInProblem =
          remoteModel === undefined || signIn === "signed-in"
            ? undefined
            : signIn === "signed-out"
              ? `Ollama is not signed in to ollama.com, which cloud model ${id} requires. Run ollama signin, then refresh route discovery.`
              : `Ollama did not confirm a sign-in to ollama.com for cloud model ${id}. Check that this Ollama version supports cloud models and that it is signed in.`;
        return {
          id,
          inferenceLocation: remoteModel === undefined ? ("local" as const) : ("remote" as const),
          ...(remoteModel === undefined ? {} : { remoteModel }),
          provider: "unknown",
          providerEvidence: "unverified" as const,
          digest,
          contextWindow: ollamaContextWindow(show),
          efforts: ollamaEfforts(show),
          supportsTools: tools,
          capabilities: [
            "core.input.text",
            "core.output.text",
            "core.streaming.events",
            "continuation",
            ...(tools ? ["core.tools"] : []),
          ],
          readiness: !tools
            ? ("unqualified" as const)
            : signInProblem === undefined
              ? ("ready" as const)
              : ("unavailable" as const),
          diagnostics: [
            ...(tools
              ? []
              : [
                  "Ollama /api/show did not report the tools capability; this model is not selectable for coding-agent execution.",
                ]),
            ...(signInProblem === undefined ? [] : [signInProblem]),
          ],
          identityEvidence: "reported" as const,
          canonicalModel: id,
        } satisfies LocalRuntimeModel;
      } catch (error) {
        diagnostics.push(
          `Ollama model ${id} could not be verified with /api/show: ${error instanceof Error ? error.message : "request failed"}.`,
        );
      }
    },
  );
  const discovered = models.flatMap((model) => (model === undefined ? [] : [model]));
  if (signal.aborted) {
    diagnostics.push(
      `Ollama profile ${profile.id} model discovery stopped at the ${INVENTORY_TIMEOUT_MS} ms deadline.`,
    );
  }
  if (discovered.length === 0 && diagnostics.length === 0) {
    diagnostics.push(
      `Ollama profile ${profile.id} has no models in /api/tags. Pull a model separately, then refresh route discovery.`,
    );
  }
  return { profile, serverVersion: version, models: discovered, diagnostics };
}

async function discoverLmStudio(
  profile: LocalRuntimeProfile,
  signal: AbortSignal,
): Promise<LocalRuntimeInventory> {
  let payload: unknown;
  try {
    payload = await boundedJsonRequest(profile, "/api/v1/models", signal);
  } catch (error) {
    return {
      profile,
      models: [],
      diagnostics: [
        `LM Studio profile ${profile.id} is unavailable at ${profile.endpoint}: ${error instanceof Error ? error.message : "request failed"}. Start the local server and check its configured loopback endpoint.`,
      ],
    };
  }
  const entries = object(payload)?.models;
  if (!Array.isArray(entries)) {
    return {
      profile,
      models: [],
      diagnostics: [
        `LM Studio profile ${profile.id} did not return a models array from /api/v1/models. Check that the endpoint is an LM Studio REST API server.`,
      ],
    };
  }
  const diagnostics: string[] = [];
  const models: LocalRuntimeModel[] = [];
  for (const value of entries) {
    const entry = object(value);
    if (entry === undefined || typeof entry.key !== "string" || entry.key === "") {
      diagnostics.push("LM Studio returned a malformed model entry; that entry was skipped.");
      continue;
    }
    if (entry.type !== "llm") {
      diagnostics.push(
        `LM Studio model ${entry.key} is not an LLM and was excluded from coding-agent routes.`,
      );
      continue;
    }
    const publisher =
      typeof entry.publisher === "string" && entry.publisher !== "" ? entry.publisher : "unknown";
    const publisherEvidence: EvidenceStatus = publisher === "unknown" ? "unverified" : "reported";
    const instances = Array.isArray(entry.loaded_instances)
      ? entry.loaded_instances.flatMap((instance) => {
          const record = object(instance);
          return record !== undefined && typeof record.id === "string" && record.id !== ""
            ? [record]
            : [];
        })
      : [];
    const trainedForToolUse = object(entry.capabilities)?.trained_for_tool_use === true;
    if (instances.length === 0) {
      models.push({
        id: entry.key,
        provider: publisher,
        providerEvidence: publisherEvidence,
        contextWindow: 8192,
        supportsTools: trainedForToolUse,
        capabilities: [
          "core.input.text",
          "core.output.text",
          "core.streaming.events",
          "continuation",
          ...(trainedForToolUse ? ["core.tools"] : []),
        ],
        readiness: "unavailable",
        diagnostics: [
          "The model is listed but has no loaded instance. Load it in LM Studio and refresh route discovery.",
        ],
        identityEvidence: "reported",
        canonicalModel: entry.key,
        efforts: [],
      });
      continue;
    }
    for (const instance of instances) {
      const instanceId = instance.id as string;
      const contextWindow =
        positiveInteger(object(instance.config)?.context_length) ??
        positiveInteger(entry.max_context_length) ??
        8192;
      models.push({
        id: instanceId,
        provider: publisher,
        providerEvidence: publisherEvidence,
        instanceId,
        contextWindow,
        supportsTools: trainedForToolUse,
        capabilities: [
          "core.input.text",
          "core.output.text",
          "core.streaming.events",
          "continuation",
          ...(trainedForToolUse ? ["core.tools"] : []),
        ],
        readiness: "unqualified",
        diagnostics: [
          "LM Studio reports this model as loaded, but LM Link can route localhost inference to a remote device; local execution is not established by this metadata.",
          ...(trainedForToolUse
            ? []
            : ["LM Studio did not report trained_for_tool_use=true for this model instance."]),
        ],
        identityEvidence: "reported",
        canonicalModel: entry.key,
        efforts: [],
      });
    }
  }
  if (models.length === 0 && diagnostics.length === 0) {
    diagnostics.push(`LM Studio profile ${profile.id} returned no LLM models from /api/v1/models.`);
  }
  return { profile, models, diagnostics };
}

export async function discoverLocalRuntime(
  profile: LocalRuntimeProfile,
  parentSignal?: AbortSignal,
): Promise<LocalRuntimeInventory> {
  const deadline = AbortSignal.timeout(INVENTORY_TIMEOUT_MS);
  const signal = parentSignal === undefined ? deadline : AbortSignal.any([parentSignal, deadline]);
  return profile.kind === "ollama"
    ? discoverOllama(profile, signal)
    : discoverLmStudio(profile, signal);
}

export async function piRuntimeAvailability(): Promise<readonly string[]> {
  if (process.platform === "win32") {
    return [
      "Local Pi routes require POSIX process-group supervision and are unavailable on Windows.",
    ];
  }
  const [majorText, minorText, patchText] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const nodeTooOld = major < 22 || (major === 22 && minor < 19);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    nodeTooOld
  ) {
    return ["Pi 1.0.0 requires Node.js 22.19.0 or later."];
  }
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    const metadata = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", resolved)), "utf8"),
    ) as unknown;
    const version = object(metadata)?.version;
    if (version !== "1.0.0") {
      return [
        `The installed optional Pi SDK is version ${String(version ?? "unknown")}; local routes require 1.0.0.`,
      ];
    }
  } catch {
    return [
      "The optional Pi SDK dependency is not installed. Reinstall harness-relay with optional dependencies enabled.",
    ];
  }
  return [];
}
