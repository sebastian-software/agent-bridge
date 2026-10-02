import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  JsonValue,
  ResolvedRoute,
  RouteDescriptor,
  StartInvocationRequest,
} from "../contract.js";
import type { PiRuntimeConfiguration } from "./pi-supervisor.js";
import type {
  Adapter,
  AdapterInputResult,
  AdapterRunContext,
  AdapterRunResult,
  AdapterSendInputContext,
  PolicyResolution,
} from "./types.js";

import { BridgeError } from "../errors.js";
import {
  discoverLocalRuntime,
  loadLocalRuntimeProfiles,
  type LocalRuntimeInventory,
  type LocalRuntimeModel,
  type LocalRuntimeProfile,
  piRuntimeAvailability,
} from "../local-runtimes.js";
import { defaultCatalogPath } from "../model-catalog.js";
import { LOCAL_BILLING, UNKNOWN_BILLING } from "../route-guidance.js";
import { PiAdapter } from "./pi.js";

const PI_VERSION = "1.0.0";
const PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const MAX_PI_ROUTE_INSTANCES = 256;

type LocalRouteBinding = {
  readonly profile: LocalRuntimeProfile;
  readonly model: LocalRuntimeModel;
  readonly route: RouteDescriptor;
};

type LocalPiInstance = {
  readonly binding: LocalRouteBinding;
  readonly adapter: PiAdapter;
};

type ActivePiInvocation = {
  adapter?: PiAdapter;
  readonly ready: Promise<PiAdapter>;
  readonly resolve: (adapter: PiAdapter) => void;
  readonly reject: (reason: unknown) => void;
};

function asError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Local Pi route setup failed.", { cause: reason });
}

function activePiInvocation(): ActivePiInvocation {
  let resolveReady!: (adapter: PiAdapter) => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<PiAdapter>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch((error: unknown) => error);
  const active: ActivePiInvocation = {
    ready,
    resolve(adapter) {
      active.adapter = adapter;
      resolveReady(adapter);
    },
    reject(reason) {
      rejectReady(asError(reason));
    },
  };
  return active;
}

async function awaitActiveAdapter(
  active: ActivePiInvocation,
  signal: AbortSignal,
): Promise<PiAdapter> {
  signal.throwIfAborted();
  if (active.adapter !== undefined) {
    return active.adapter;
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        asError(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    active.ready.then(
      (adapter) => {
        cleanup();
        resolve(adapter);
      },
      (error: unknown) => {
        cleanup();
        reject(asError(error));
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function stableModelKey(profile: LocalRuntimeProfile, model: LocalRuntimeModel): string {
  return JSON.stringify([
    profile.id,
    profile.revision,
    profile.kind,
    model.id,
    model.digest,
    model.instanceId,
  ]);
}

function routeId(
  profile: LocalRuntimeProfile,
  model: LocalRuntimeModel,
  capabilities: readonly string[] = model.capabilities,
): string {
  const snapshot = JSON.stringify([
    model.id,
    model.canonicalModel,
    model.digest ?? null,
    model.instanceId ?? null,
    model.provider,
    model.providerEvidence,
    model.contextWindow,
    model.supportsTools,
    [...capabilities].toSorted(),
    model.readiness,
  ]);
  const identity = createHash("sha256").update(snapshot).digest("hex").slice(0, 16);
  return `pi:${profile.kind}:${encodeURIComponent(profile.id)}:${profile.revision}:${encodeURIComponent(model.id)}:${identity}`;
}

function statusRoute(
  inventory: LocalRuntimeInventory,
  unavailable: readonly string[],
): RouteDescriptor {
  return {
    routeId: `pi:${inventory.profile.kind}:${encodeURIComponent(inventory.profile.id)}:${inventory.profile.revision}:status`,
    provider: "unknown",
    model: "unavailable",
    efforts: [],
    via: "pi",
    adapter: "pi",
    harnessVersion: PI_VERSION,
    authenticationMode: "none",
    capabilities: [],
    interactionStrategies: ["deny", "unattended"],
    assurance: "none",
    runtimeIdentityEvidence: "unverified",
    readiness: "unavailable",
    qualification: [],
    diagnostics: [...inventory.diagnostics, ...unavailable],
    runtimeId: inventory.profile.id,
    runtimeRevision: inventory.profile.revision,
    inferenceServer: inventory.profile.kind,
  };
}

function descriptor(
  inventory: LocalRuntimeInventory,
  model: LocalRuntimeModel,
  unavailable: readonly string[],
): RouteDescriptor {
  const diagnostics = [...inventory.diagnostics, ...model.diagnostics, ...unavailable];
  const readiness = unavailable.length > 0 ? "unavailable" : model.readiness;
  const capabilities = [
    ...model.capabilities,
    ...(inventory.profile.kind === "ollama" && readiness === "ready" ? ["steering"] : []),
  ];
  return {
    routeId: routeId(inventory.profile, model, capabilities),
    canonicalModel: model.canonicalModel,
    nativeModel: model.id,
    provider: model.provider,
    model: model.id,
    modelVendorEvidence: model.providerEvidence,
    efforts: [],
    via: "pi",
    adapter: "pi",
    harnessVersion: PI_VERSION,
    authenticationMode: "none",
    capabilities,
    interactionStrategies: ["deny", "unattended"],
    assurance: "none",
    runtimeIdentityEvidence: model.identityEvidence,
    readiness,
    qualification: [],
    diagnostics,
    runtimeId: inventory.profile.id,
    runtimeRevision: inventory.profile.revision,
    inferenceServer: inventory.profile.kind,
    ...(model.digest === undefined ? {} : { modelDigest: model.digest }),
    ...(model.instanceId === undefined ? {} : { runtimeInstanceId: model.instanceId }),
    // Only a ready route has established that inference runs on the local server.
    billing: readiness === "ready" ? LOCAL_BILLING : UNKNOWN_BILLING,
  };
}

function piConfiguration(
  binding: LocalRouteBinding,
  modelFiles: PiRuntimeConfiguration["modelFiles"],
): PiRuntimeConfiguration {
  const provider = `relay-local-${binding.profile.kind}-${binding.profile.revision}-${createHash(
    "sha256",
  )
    .update(binding.model.id)
    .digest("hex")
    .slice(0, 12)}`;
  return {
    model: { provider, id: binding.model.id, thinkingLevel: "off" },
    modelFiles,
    tools: PI_TOOLS,
  };
}

function policyResolution(
  request: StartInvocationRequest,
  route: RouteDescriptor,
): PolicyResolution {
  const unsupported: string[] = [];
  const policy = request.requestedPolicy;
  if (policy.minimumAssurance !== "none") {
    unsupported.push(`minimumAssurance=${policy.minimumAssurance}`);
  }
  if (policy.filesystem === "workspace-write") {
    unsupported.push("filesystem=workspace-write requires an OS-enforced workspace sandbox");
  }
  if (policy.filesystem === "read-only") {
    unsupported.push("filesystem=read-only conflicts with enabled mutating Pi tools");
  }
  if (policy.commands === "deny") {
    unsupported.push("commands=deny conflicts with the enabled Pi bash tool");
  }
  if (policy.network === "deny") {
    unsupported.push("network=deny cannot be enforced by the Pi worker or model endpoint");
  }
  if ((policy.additionalDirectories?.length ?? 0) > 0) {
    unsupported.push("additionalDirectories are not supported by this Pi worker");
  }
  const effectiveNativePolicy: Readonly<Record<string, JsonValue>> = {
    runtime: "pi-coding-agent",
    modelRuntime: route.inferenceServer ?? "unknown",
    runtimeId: route.runtimeId ?? "unknown",
    assurance: "none",
    sandbox: "none",
    extensions: "disabled",
    tools: [...PI_TOOLS],
  };
  return { supported: unsupported.length === 0, unsupported, effectiveNativePolicy };
}

function sameModelSnapshot(left: LocalRuntimeModel, right: LocalRuntimeModel): boolean {
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.providerEvidence === right.providerEvidence &&
    left.digest === right.digest &&
    left.instanceId === right.instanceId &&
    left.contextWindow === right.contextWindow &&
    left.supportsTools === right.supportsTools &&
    left.readiness === right.readiness &&
    left.canonicalModel === right.canonicalModel &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
}

function routeUnavailable(message: string): BridgeError {
  return new BridgeError({ code: "route_unavailable", message, retryable: false });
}

export class LocalPiAdapter implements Adapter {
  readonly id = "pi";
  readonly #configPath: string;
  readonly #currentBindings = new Map<string, LocalRouteBinding>();
  readonly #instances = new Map<string, Promise<LocalPiInstance>>();
  readonly #activeAdapters = new Map<string, ActivePiInvocation>();
  #privateRoot: string | undefined;
  #privateRootPromise: Promise<string> | undefined;

  constructor(options: { readonly configPath?: string } = {}) {
    this.#configPath = options.configPath ?? defaultCatalogPath();
  }

  async discoveryCacheKey(): Promise<string> {
    return JSON.stringify(await loadLocalRuntimeProfiles(this.#configPath));
  }

  async discover(): Promise<readonly RouteDescriptor[]> {
    const profiles = await loadLocalRuntimeProfiles(this.#configPath);
    const unavailable = await piRuntimeAvailability();
    const inventories = await Promise.all(
      profiles.map(async (profile) => discoverLocalRuntime(profile)),
    );
    this.#currentBindings.clear();
    const routes: RouteDescriptor[] = [];
    for (const inventory of inventories) {
      if (inventory.models.length === 0) {
        routes.push(statusRoute(inventory, unavailable));
        continue;
      }
      for (const model of inventory.models) {
        const route = descriptor(inventory, model, unavailable);
        routes.push(route);
        this.#currentBindings.set(stableModelKey(inventory.profile, model), {
          profile: inventory.profile,
          model,
          route,
        });
      }
    }
    return routes;
  }

  resolvePolicy(request: StartInvocationRequest, route: RouteDescriptor): PolicyResolution {
    return policyResolution(request, route);
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    if (this.#activeAdapters.has(context.invocationId)) {
      throw new BridgeError({
        code: "internal_error",
        message: "A local Pi invocation with this ID is already active.",
        retryable: false,
      });
    }
    const active = activePiInvocation();
    this.#activeAdapters.set(context.invocationId, active);
    try {
      context.signal.throwIfAborted();
      const binding = this.#bindingForRoute(context.route);
      if (binding === undefined) {
        throw routeUnavailable(
          "The selected local runtime route is no longer in the current discovery snapshot.",
        );
      }
      await this.#verifyCurrentRoute(binding, context.signal);
      const instance = await this.#instance(binding);
      active.resolve(instance.adapter);
      const result = await instance.adapter.run({
        ...context,
        ...(context.reportPartial === undefined
          ? {}
          : {
              reportPartial: (partial) =>
                context.reportPartial?.(normalizePartialIdentity(binding, partial)),
            }),
      });
      return {
        ...result,
        observedIdentity: normalizeObservedIdentity(binding, result.observedIdentity),
      };
    } catch (error) {
      active.reject(error);
      throw error;
    } finally {
      if (this.#activeAdapters.get(context.invocationId) === active) {
        this.#activeAdapters.delete(context.invocationId);
      }
    }
  }

  async sendInput(context: AdapterSendInputContext): Promise<AdapterInputResult> {
    const active = this.#activeAdapters.get(context.invocationId);
    if (active === undefined) {
      throw routeUnavailable("The local Pi invocation is no longer active for input.");
    }
    const adapter = await awaitActiveAdapter(active, context.signal);
    return adapter.sendInput(context);
  }

  async dispose(): Promise<void> {
    const instances = await Promise.allSettled(this.#instances.values());
    await Promise.all(
      instances.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.adapter.dispose()] : [],
      ),
    );
    this.#instances.clear();
    for (const active of this.#activeAdapters.values()) {
      active.reject(new Error("The local Pi adapter was disposed."));
    }
    this.#activeAdapters.clear();
    if (this.#privateRoot !== undefined) {
      await rm(this.#privateRoot, { recursive: true, force: true });
      this.#privateRoot = undefined;
    }
  }

  #bindingForRoute(route: ResolvedRoute): LocalRouteBinding | undefined {
    if (
      route.runtimeId === undefined ||
      route.runtimeRevision === undefined ||
      route.inferenceServer === undefined
    ) {
      return undefined;
    }
    const modelId = route.nativeModel ?? route.model;
    const key = JSON.stringify([
      route.runtimeId,
      route.runtimeRevision,
      route.inferenceServer,
      modelId,
      route.modelDigest,
      route.runtimeInstanceId,
    ]);
    const binding = this.#currentBindings.get(key);
    if (binding === undefined) {
      return undefined;
    }
    const aliasRouteId = `${binding.route.routeId}:alias:${encodeURIComponent(route.model)}`;
    return route.routeId === binding.route.routeId || route.routeId === aliasRouteId
      ? binding
      : undefined;
  }

  async #verifyCurrentRoute(binding: LocalRouteBinding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const [profiles, unavailable] = await Promise.all([
      loadLocalRuntimeProfiles(this.#configPath),
      piRuntimeAvailability(),
    ]);
    if (unavailable.length > 0) {
      throw routeUnavailable(unavailable.join(" "));
    }
    const currentProfile = profiles.find((profile) => profile.id === binding.profile.id);
    if (currentProfile?.revision !== binding.profile.revision) {
      throw routeUnavailable(
        "The selected local runtime profile changed or was removed after route discovery. Refresh routes and select the current runtime explicitly.",
      );
    }
    const inventory = await discoverLocalRuntime(currentProfile, signal);
    signal.throwIfAborted();
    if (inventory.models.length === 0 && inventory.diagnostics.length > 0) {
      // A stopped or unreachable server reports why; that beats claiming a changed model.
      throw routeUnavailable(inventory.diagnostics.join(" "));
    }
    const currentModel = inventory.models.find(
      (model) =>
        model.id === binding.model.id &&
        model.digest === binding.model.digest &&
        model.instanceId === binding.model.instanceId,
    );
    if (currentModel === undefined || !sameModelSnapshot(binding.model, currentModel)) {
      throw routeUnavailable(
        "The selected local model, digest, or loaded instance changed after route discovery. Refresh routes and select the current model explicitly.",
      );
    }
    if (currentModel.readiness !== "ready") {
      throw routeUnavailable(
        currentModel.diagnostics.join(" ") || "The selected local model is no longer ready.",
      );
    }
  }

  async #instance(binding: LocalRouteBinding): Promise<LocalPiInstance> {
    const key = binding.route.routeId;
    let pending = this.#instances.get(key);
    if (pending === undefined) {
      if (this.#instances.size >= MAX_PI_ROUTE_INSTANCES) {
        throw routeUnavailable(
          `This broker has reached its ${MAX_PI_ROUTE_INSTANCES}-route local Pi configuration limit. Restart the broker to clear retained local route state.`,
        );
      }
      pending = this.#createInstance(binding);
      this.#instances.set(key, pending);
    }
    return pending;
  }

  async #createInstance(binding: LocalRouteBinding): Promise<LocalPiInstance> {
    const privateRoot = await this.#ensurePrivateRoot();
    const directory = join(
      privateRoot,
      createHash("sha256").update(binding.route.routeId).digest("hex").slice(0, 32),
    );
    await mkdir(directory, { mode: 0o700 });
    const modelFiles: PiRuntimeConfiguration["modelFiles"] = {
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-store.json"),
    };
    const configuration = piConfiguration(binding, modelFiles);
    const modelProvider = configuration.model.provider;
    await Promise.all([
      writeFile(modelFiles.authPath, "{}", { encoding: "utf8", mode: 0o600 }),
      writeFile(modelFiles.modelsStorePath, "{}", { encoding: "utf8", mode: 0o600 }),
      writeFile(
        modelFiles.modelsPath,
        JSON.stringify({
          providers: {
            [modelProvider]: {
              baseUrl: `${binding.profile.endpoint}/v1`,
              api: "openai-completions",
              apiKey: "local",
              models: [
                {
                  id: binding.model.id,
                  name: binding.model.canonicalModel,
                  contextWindow: binding.model.contextWindow,
                  maxTokens: Math.min(8192, binding.model.contextWindow),
                  supportsTools: binding.model.supportsTools,
                },
              ],
            },
          },
        }),
        { encoding: "utf8", mode: 0o600 },
      ),
    ]);
    const adapter = new PiAdapter(configuration);
    return { binding, adapter };
  }

  async #ensurePrivateRoot(): Promise<string> {
    if (this.#privateRoot !== undefined) {
      return this.#privateRoot;
    }
    this.#privateRootPromise ??= mkdtemp(join(tmpdir(), "harness-relay-local-pi-"));
    this.#privateRoot = await this.#privateRootPromise;
    return this.#privateRoot;
  }
}

function normalizeObservedIdentity(
  binding: LocalRouteBinding,
  identity: AdapterRunResult["observedIdentity"],
): AdapterRunResult["observedIdentity"] {
  const source =
    binding.profile.kind === "ollama" ? "ollama-model-catalog" : "lm-studio-model-catalog";
  return {
    ...identity,
    provider: {
      ...(binding.model.provider === "unknown" ? {} : { value: binding.model.provider }),
      evidence: binding.model.providerEvidence,
      source,
    },
  };
}

function normalizePartialIdentity(
  binding: LocalRouteBinding,
  partial: Partial<AdapterRunResult>,
): Partial<AdapterRunResult> {
  return partial.observedIdentity === undefined
    ? partial
    : {
        ...partial,
        observedIdentity: normalizeObservedIdentity(binding, partial.observedIdentity),
      };
}
