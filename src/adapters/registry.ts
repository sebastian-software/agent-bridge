import type { Assurance, EvidenceStatus, ResolvedRoute, RouteDescriptor, StartInvocationRequest } from "../contract.js";
import { BridgeError } from "../errors.js";
import { applyUserModelCatalog, defaultCatalogPath, loadUserModelCatalog } from "../model-catalog.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { FakeAdapter } from "./fake.js";
import { FakeProcessAdapter } from "./fake-process.js";
import type { Adapter } from "./types.js";

const ASSURANCE_RANK: Readonly<Record<Assurance, number>> = {
  none: 0,
  native: 1,
  isolated: 2,
};

const EVIDENCE_RANK: Readonly<Record<EvidenceStatus, number>> = {
  unverified: 0,
  inferred: 1,
  reported: 2,
  verified: 3,
};

const DISCOVERY_TTL_MS = 60_000;

export class AdapterRegistry {
  readonly #adapters: ReadonlyMap<string, Adapter>;
  readonly #catalogPath: string;
  #discoveryCache: { readonly expiresAt: number; readonly routes: readonly RouteDescriptor[] } | undefined;

  constructor(
    adapters: readonly Adapter[] = [
      new FakeAdapter(),
      new FakeProcessAdapter(),
      new ClaudeAdapter(),
      new CodexAdapter(),
    ],
    options?: { readonly catalogPath?: string },
  ) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.#catalogPath = options?.catalogPath ?? defaultCatalogPath();
  }

  adapter(id: string): Adapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Adapter ${id} is not registered.`,
        retryable: false,
      });
    }
    return adapter;
  }

  async discover(options: { readonly refresh?: boolean } = {}): Promise<readonly RouteDescriptor[]> {
    if (options.refresh !== true && this.#discoveryCache !== undefined && this.#discoveryCache.expiresAt > Date.now()) {
      return this.#discoveryCache.routes;
    }
    const routeGroups = await Promise.all([...this.#adapters.values()].map((adapter) => adapter.discover()));
    const catalog = await loadUserModelCatalog(this.#catalogPath);
    const discoveredAt = new Date().toISOString();
    const routes = [...applyUserModelCatalog(routeGroups.flat(), catalog)]
      .map((route) => ({ ...route, discoveredAt }))
      .sort((left, right) => left.routeId.localeCompare(right.routeId));
    this.#discoveryCache = { expiresAt: Date.now() + DISCOVERY_TTL_MS, routes };
    return routes;
  }

  async resolve(request: StartInvocationRequest): Promise<{
    readonly route: ResolvedRoute;
    readonly descriptor: RouteDescriptor;
    readonly effectiveNativePolicy: Readonly<Record<string, import("../contract.js").JsonValue>>;
  }> {
    const routes = await this.discover();
    const evaluated = routes.map((route) => {
      const adapter = this.#adapters.get(route.adapter);
      const policy = adapter?.resolvePolicy?.(request, route) ?? {
        supported: true,
        unsupported: [],
        effectiveNativePolicy: { adapter: route.adapter, controls: [] },
      };
      return { route, policy };
    });
    const candidates = evaluated.filter(({ route, policy }) => {
      const selector = request.selector;
      return (
        route.readiness === "ready" &&
        route.provider === selector.provider &&
        route.model === selector.model &&
        (selector.via === undefined || route.via === selector.via) &&
        (selector.effort === undefined || route.efforts.includes(selector.effort)) &&
        selector.requiredCapabilities.every((capability) => route.capabilities.includes(capability)) &&
        route.interactionStrategies.includes(request.interactionStrategy) &&
        (selector.minimumObservedEvidence === undefined ||
          EVIDENCE_RANK[route.runtimeIdentityEvidence] >= EVIDENCE_RANK[selector.minimumObservedEvidence]) &&
        ASSURANCE_RANK[route.assurance] >= ASSURANCE_RANK[request.requestedPolicy.minimumAssurance] &&
        policy.supported
      );
    });

    if (candidates.length === 0) {
      throw new BridgeError({
        code: "route_unavailable",
        message:
          "No qualified route matches the requested selector, capabilities, interaction strategy, and assurance.",
        retryable: false,
        details: {
          requested: request.selector,
          minimumAssurance: request.requestedPolicy.minimumAssurance,
          candidates: routes,
          unsupportedPolicies: evaluated
            .filter(({ policy }) => !policy.supported)
            .flatMap(({ route, policy }) => policy.unsupported.map((field) => ({ routeId: route.routeId, field }))),
        },
      });
    }
    if (candidates.length > 1) {
      throw new BridgeError({
        code: "route_ambiguous",
        message:
          "More than one qualified route matches the request. Add a via selector or a more specific capability requirement.",
        retryable: false,
        details: { candidates: candidates.map(({ route }) => route) },
      });
    }

    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new BridgeError({
        code: "internal_error",
        message: "Route resolution produced no candidate.",
        retryable: false,
      });
    }
    return {
      descriptor: candidate.route,
      route: {
        routeId: candidate.route.routeId,
        ...(candidate.route.executable === undefined ? {} : { executable: candidate.route.executable }),
        ...(candidate.route.canonicalModel === undefined ? {} : { canonicalModel: candidate.route.canonicalModel }),
        adapter: candidate.route.adapter,
        harnessVersion: candidate.route.harnessVersion,
        authenticationMode: candidate.route.authenticationMode,
        provider: candidate.route.provider,
        model: candidate.route.model,
        ...(request.selector.effort === undefined ? {} : { effort: request.selector.effort }),
        via: candidate.route.via,
        capabilities: candidate.route.capabilities,
        qualification: candidate.route.qualification,
      },
      effectiveNativePolicy: candidate.policy.effectiveNativePolicy,
    };
  }
}
