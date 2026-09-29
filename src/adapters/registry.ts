import type {
  Assurance,
  EvidenceStatus,
  JsonValue,
  ResolvedRoute,
  RouteDescriptor,
  StartInvocationRequest,
} from "../contract.js";
import type { Adapter, PolicyResolution } from "./types.js";

import {
  adapterConnectionContext,
  type AdapterConnectionContext,
  defaultConnectionsPath,
  type HarnessConnection,
  type HarnessConnectionSummary,
  loadUserConnections,
  summarizeConnection,
} from "../connections.js";
import { BridgeError } from "../errors.js";
import {
  applyUserModelCatalog,
  defaultCatalogPath,
  loadUserModelCatalog,
} from "../model-catalog.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { inspectNativeContextDirectory, redactNativeContextData } from "./environment.js";
import { FakeProcessAdapter } from "./fake-process.js";
import { FakeAdapter } from "./fake.js";
import { GrokAdapter } from "./grok.js";
import { LocalPiAdapter } from "./local-pi.js";

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

type DiscoveryOptions = {
  readonly refresh?: boolean;
  readonly connectionId?: string;
};

type DiscoverySnapshot = {
  readonly routes: readonly RouteDescriptor[];
  readonly executionExecutables: ReadonlyMap<string, string>;
};

type DiscoveryCache = {
  readonly expiresAt: number;
  readonly configurationKey: string;
  readonly snapshot: DiscoverySnapshot;
};

function connectionRevisionKey(id: string, revision: string): string {
  return `${id}@${revision}`;
}

export class AdapterRegistry {
  readonly #adapters: ReadonlyMap<string, Adapter>;
  readonly #catalogPath: string;
  readonly #connectionsPath: string;
  #discoveryCache: DiscoveryCache | undefined;

  constructor(
    adapters?: readonly Adapter[],
    options?: { readonly catalogPath?: string; readonly connectionsPath?: string },
  ) {
    this.#catalogPath = options?.catalogPath ?? defaultCatalogPath();
    this.#connectionsPath = options?.connectionsPath ?? defaultConnectionsPath();
    this.#adapters = new Map(
      (
        adapters ?? [
          new FakeAdapter(),
          new FakeProcessAdapter(),
          new ClaudeAdapter(),
          new CodexAdapter(),
          new LocalPiAdapter({ configPath: this.#catalogPath }),
          new GrokAdapter(),
        ]
      ).map((adapter) => [adapter.id, adapter]),
    );
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

  get connectionsPath(): string {
    return this.#connectionsPath;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#adapters.values()].flatMap((adapter) =>
        adapter.dispose === undefined ? [] : [adapter.dispose()],
      ),
    );
  }

  async discover(options: DiscoveryOptions = {}): Promise<readonly RouteDescriptor[]> {
    const connections = await loadUserConnections(this.#connectionsPath);
    return (await this.#discoverSnapshot(connections, options)).routes;
  }

  async resolve(
    request: StartInvocationRequest,
    options: { readonly refresh?: boolean } = {},
  ): Promise<{
    readonly route: ResolvedRoute;
    readonly descriptor: RouteDescriptor;
    readonly effectiveNativePolicy: Readonly<Record<string, JsonValue>>;
    readonly connectionContext?: AdapterConnectionContext;
  }> {
    const connections = await loadUserConnections(this.#connectionsPath);
    const connectionId = request.selector.connectionId;
    const selectedConnection =
      connectionId === undefined ? undefined : this.#findConnection(connectionId, connections);
    const snapshot = await this.#discoverSnapshot(
      connections,
      connectionId === undefined
        ? options.refresh === true
          ? { refresh: true }
          : {}
        : { connectionId },
    );
    const routes = snapshot.routes;
    const evaluated = routes.map((route) => {
      const adapter = this.#adapters.get(route.adapter);
      const policy: PolicyResolution = adapter?.resolvePolicy?.(request, route) ?? {
        supported: true,
        unsupported: [],
        effectiveNativePolicy: { adapter: route.adapter, controls: [] },
      };
      return { route, policy };
    });
    const candidates = evaluated.filter(({ route, policy }) => {
      const selector = request.selector;
      return (
        route.connectionId === selector.connectionId &&
        (selector.runtimeId === undefined || route.runtimeId === selector.runtimeId) &&
        route.readiness === "ready" &&
        route.provider === selector.provider &&
        route.model === selector.model &&
        (selector.via === undefined || route.via === selector.via) &&
        (selector.effort === undefined || route.efforts.includes(selector.effort)) &&
        selector.requiredCapabilities.every((capability) =>
          route.capabilities.includes(capability),
        ) &&
        route.interactionStrategies.includes(request.interactionStrategy) &&
        (selector.minimumObservedEvidence === undefined ||
          EVIDENCE_RANK[route.runtimeIdentityEvidence] >=
            EVIDENCE_RANK[selector.minimumObservedEvidence]) &&
        ASSURANCE_RANK[route.assurance] >=
          ASSURANCE_RANK[request.requestedPolicy.minimumAssurance] &&
        policy.supported
      );
    });

    if (candidates.length === 0) {
      throw new BridgeError({
        code: "route_unavailable",
        message:
          "No qualified route matches the requested selector, connection, capabilities, interaction strategy, and assurance.",
        retryable: false,
        details: {
          requested: request.selector,
          minimumAssurance: request.requestedPolicy.minimumAssurance,
          candidates: routes,
          ...(selectedConnection === undefined
            ? {}
            : { connection: summarizeConnection(selectedConnection) }),
          unsupportedPolicies: evaluated
            .filter(({ policy }) => !policy.supported)
            .flatMap(({ route, policy }) =>
              policy.unsupported.map((field) => ({ routeId: route.routeId, field })),
            ),
        },
      });
    }
    if (candidates.length > 1) {
      throw new BridgeError({
        code: "route_ambiguous",
        message:
          "More than one qualified route matches the request. Add a connectionId, runtimeId, via selector, or a more specific capability requirement.",
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
    const executionExecutable = snapshot.executionExecutables.get(candidate.route.routeId);
    return {
      descriptor: candidate.route,
      route: {
        routeId: candidate.route.routeId,
        ...(candidate.route.executable === undefined
          ? {}
          : { executable: candidate.route.executable }),
        ...(candidate.route.canonicalModel === undefined
          ? {}
          : { canonicalModel: candidate.route.canonicalModel }),
        ...(candidate.route.nativeModel === undefined
          ? {}
          : { nativeModel: candidate.route.nativeModel }),
        adapter: candidate.route.adapter,
        harnessVersion: candidate.route.harnessVersion,
        authenticationMode: candidate.route.authenticationMode,
        provider: candidate.route.provider,
        model: candidate.route.model,
        ...(candidate.route.modelVendorEvidence === undefined
          ? {}
          : { modelVendorEvidence: candidate.route.modelVendorEvidence }),
        ...(request.selector.effort === undefined ? {} : { effort: request.selector.effort }),
        via: candidate.route.via,
        ...(candidate.route.connectionId === undefined
          ? {}
          : { connectionId: candidate.route.connectionId }),
        ...(candidate.route.connectionRevision === undefined
          ? {}
          : { connectionRevision: candidate.route.connectionRevision }),
        ...(candidate.route.runtimeId === undefined
          ? {}
          : { runtimeId: candidate.route.runtimeId }),
        ...(candidate.route.runtimeRevision === undefined
          ? {}
          : { runtimeRevision: candidate.route.runtimeRevision }),
        ...(candidate.route.inferenceServer === undefined
          ? {}
          : { inferenceServer: candidate.route.inferenceServer }),
        ...(candidate.route.modelDigest === undefined
          ? {}
          : { modelDigest: candidate.route.modelDigest }),
        ...(candidate.route.runtimeInstanceId === undefined
          ? {}
          : { runtimeInstanceId: candidate.route.runtimeInstanceId }),
        capabilities: candidate.route.capabilities,
        qualification: candidate.route.qualification,
      },
      effectiveNativePolicy: candidate.policy.effectiveNativePolicy,
      ...(selectedConnection === undefined
        ? {}
        : {
            connectionContext: {
              ...adapterConnectionContext(selectedConnection),
              ...(executionExecutable === undefined ? {} : { executable: executionExecutable }),
            },
          }),
    };
  }

  async #discoverSnapshot(
    connections: readonly HarnessConnection[],
    options: DiscoveryOptions,
  ): Promise<DiscoverySnapshot> {
    const [adapterKeys, catalog] = await Promise.all([
      Promise.all(
        [...this.#adapters.values()].map(
          async (adapter) => [adapter.id, await adapter.discoveryCacheKey?.()] as const,
        ),
      ),
      loadUserModelCatalog(this.#catalogPath),
    ]);
    const configurationKey = JSON.stringify({ connections, adapterKeys, catalog });
    if (options.connectionId !== undefined) {
      const connection = this.#findConnection(options.connectionId, connections);
      return this.#discoverOneConnection(connection, connections);
    }

    if (
      options.refresh !== true &&
      this.#discoveryCache !== undefined &&
      this.#discoveryCache.expiresAt > Date.now() &&
      this.#discoveryCache.configurationKey === configurationKey
    ) {
      return this.#discoveryCache.snapshot;
    }

    const defaultGroups = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => adapter.discover()),
    );
    const connectionGroups = await Promise.all(
      connections.map(async (connection) => {
        try {
          return await this.#connectionRoutes(connection, false);
        } catch {
          // A named account probe must not prevent the ordinary default login from working.
          return [];
        }
      }),
    );
    const discoveredAt = new Date().toISOString();
    const discoveredRoutes = [...defaultGroups, ...connectionGroups].flat();
    const routes = [...applyUserModelCatalog(discoveredRoutes, catalog)]
      .map((route) => ({ ...route, discoveredAt }))
      .sort((left, right) => left.routeId.localeCompare(right.routeId));
    const snapshot = await this.#finalizeDiscoverySnapshot(routes, connections);
    this.#discoveryCache = {
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
      configurationKey,
      snapshot,
    };
    return snapshot;
  }

  async #discoverOneConnection(
    connection: HarnessConnection,
    connections: readonly HarnessConnection[],
  ): Promise<DiscoverySnapshot> {
    let routes: readonly RouteDescriptor[];
    try {
      routes = await this.#connectionRoutes(connection, true);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw this.#connectionProbeError(connection, connections);
    }
    const catalog = await loadUserModelCatalog(this.#catalogPath);
    const discoveredAt = new Date().toISOString();
    const discovered = applyUserModelCatalog(routes, catalog)
      .map((route) => ({ ...route, discoveredAt }))
      .sort((left, right) => left.routeId.localeCompare(right.routeId));
    return this.#finalizeDiscoverySnapshot(discovered, connections);
  }

  async #finalizeDiscoverySnapshot(
    routes: readonly RouteDescriptor[],
    connections: readonly HarnessConnection[],
  ): Promise<DiscoverySnapshot> {
    const privateReferences = new Map<string, readonly string[]>();
    await Promise.all(
      connections.map(async (connection) => {
        const nativeContext = await inspectNativeContextDirectory(connection.nativeContextRef);
        privateReferences.set(
          connectionRevisionKey(connection.id, connection.revision),
          nativeContext?.privatePaths ?? [connection.nativeContextRef],
        );
      }),
    );
    const contextReferences = [...new Set([...privateReferences.values()].flat())];
    const executionExecutables = new Map<string, string>();
    const sanitizedRoutes = routes.map((route) => {
      if (route.connectionId === undefined || route.connectionRevision === undefined) {
        return route;
      }
      if (route.executable !== undefined) {
        executionExecutables.set(route.routeId, route.executable);
      }
      return redactNativeContextData(route, contextReferences);
    });
    return { routes: sanitizedRoutes, executionExecutables };
  }

  async #connectionRoutes(
    connection: HarnessConnection,
    required: boolean,
  ): Promise<readonly RouteDescriptor[]> {
    const adapter = this.#adapters.get(connection.harness);
    if (adapter?.discoverConnection === undefined || adapter.runConnection === undefined) {
      if (required) {
        throw this.#unsupportedConnectionError(connection);
      }
      return [];
    }
    const context = adapterConnectionContext(connection);
    try {
      const routes = await adapter.discoverConnection(context);
      const summary = summarizeConnection(connection);
      return routes.map((route) => {
        return {
          ...route,
          routeId: `${route.routeId}:connection:${connection.id}@${connection.revision}`,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          ...(summary.purpose === undefined ? {} : { connectionPurpose: summary.purpose }),
        };
      });
    } catch {
      if (!required) {
        throw new Error("Named connection discovery failed.");
      }
      throw this.#connectionProbeError(connection, [connection]);
    }
  }

  #findConnection(
    connectionId: string,
    connections: readonly HarnessConnection[],
  ): HarnessConnection {
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (connection === undefined) {
      throw new BridgeError({
        code: "route_unavailable",
        message: `Named connection ${connectionId} is not registered. Register it or choose a listed connection.`,
        retryable: false,
        details: {
          connectionId,
          availableConnections: this.#summaries(connections),
        },
      });
    }
    return connection;
  }

  #unsupportedConnectionError(connection: HarnessConnection): BridgeError {
    return new BridgeError({
      code: "route_unavailable",
      message: `Harness ${connection.harness} does not have a qualified discovery and execution path for named connections.`,
      retryable: false,
      details: { connection: summarizeConnection(connection) },
    });
  }

  #connectionProbeError(
    connection: HarnessConnection,
    connections: readonly HarnessConnection[],
  ): BridgeError {
    return new BridgeError({
      code: "route_unavailable",
      message: `Named connection ${connection.id} could not be discovered in its native context. Check that the native context is available and choose it explicitly.`,
      retryable: false,
      details: {
        connection: summarizeConnection(connection),
        availableConnections: this.#summaries(connections),
      },
    });
  }

  #summaries(connections: readonly HarnessConnection[]): readonly HarnessConnectionSummary[] {
    return connections.map(summarizeConnection);
  }
}
