import type {
  ContentPart,
  EventCategory,
  InputRequest,
  InputResponse,
  JsonValue,
  ObservedIdentity,
  ResolvedRoute,
  RouteDescriptor,
  StartInvocationRequest,
  Usage,
  WorkspaceEffect,
} from "../contract.js";

export interface AdapterEvent {
  readonly category: EventCategory;
  readonly content?: readonly ContentPart[];
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly native?: Readonly<Record<string, JsonValue>>;
  readonly effects?: readonly WorkspaceEffect[];
  readonly usage?: Usage;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly inputRequest?: InputRequest;
}

export interface AdapterRunContext {
  readonly invocationId: string;
  readonly request: StartInvocationRequest;
  readonly route: ResolvedRoute;
  readonly signal: AbortSignal;
  readonly emit: (event: AdapterEvent) => Promise<void>;
  readonly reportPartial?: (result: Partial<AdapterRunResult>) => void;
  readonly awaitInput?: (requestId: string, signal?: AbortSignal) => Promise<Pick<InputResponse, "decision">>;
  readonly terminationGraceMs?: number;
}

export interface AdapterRunResult {
  readonly content: readonly ContentPart[];
  readonly artifacts: readonly ContentPart[];
  readonly effects: readonly WorkspaceEffect[];
  readonly observedIdentity: ObservedIdentity;
  readonly usage?: Usage;
}

export interface PolicyResolution {
  readonly supported: boolean;
  readonly unsupported: readonly string[];
  readonly effectiveNativePolicy: Readonly<Record<string, JsonValue>>;
}

export interface Adapter {
  readonly id: string;
  discover(): Promise<readonly RouteDescriptor[]>;
  run(context: AdapterRunContext): Promise<AdapterRunResult>;
  resolvePolicy?(request: StartInvocationRequest, route: RouteDescriptor): PolicyResolution;
}
