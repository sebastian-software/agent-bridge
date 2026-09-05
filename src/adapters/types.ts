import type {
  ContentPart,
  EventCategory,
  JsonValue,
  ObservedIdentity,
  ResolvedRoute,
  RouteDescriptor,
  StartInvocationRequest,
  WorkspaceEffect,
} from "../contract.js";

export interface AdapterEvent {
  readonly category: EventCategory;
  readonly content?: readonly ContentPart[];
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly native?: Readonly<Record<string, JsonValue>>;
}

export interface AdapterRunContext {
  readonly invocationId: string;
  readonly request: StartInvocationRequest;
  readonly route: ResolvedRoute;
  readonly signal: AbortSignal;
  readonly emit: (event: AdapterEvent) => Promise<void>;
}

export interface AdapterRunResult {
  readonly content: readonly ContentPart[];
  readonly artifacts: readonly ContentPart[];
  readonly effects: readonly WorkspaceEffect[];
  readonly observedIdentity: ObservedIdentity;
}

export interface Adapter {
  readonly id: string;
  discover(): Promise<readonly RouteDescriptor[]>;
  run(context: AdapterRunContext): Promise<AdapterRunResult>;
}
