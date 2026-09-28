import type { AdapterConnectionContext } from "../connections.js";
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

export type AdapterEvent = {
  readonly category: Exclude<
    EventCategory,
    | "input_accepted"
    | "input_answered"
    | "input_delivered"
    | "input_delivery_failed"
    | "input_expired"
  >;
  readonly content?: readonly ContentPart[];
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly native?: Readonly<Record<string, JsonValue>>;
  readonly effects?: readonly WorkspaceEffect[];
  readonly usage?: Usage;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly inputRequest?: InputRequest;
};

export type AdapterRunContext = {
  readonly invocationId: string;
  readonly request: StartInvocationRequest;
  readonly route: ResolvedRoute;
  /** Adapter-owned native context from a predecessor invocation, never caller supplied. */
  readonly continuationHandle?: AdapterContinuationHandle;
  readonly signal: AbortSignal;
  readonly emit: (event: AdapterEvent) => Promise<void>;
  readonly reportPartial?: (result: Partial<AdapterRunResult>) => void;
  readonly awaitInput?: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<Pick<InputResponse, "decision">>;
  readonly awaitAnswer?: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<readonly ContentPart[]>;
  readonly terminationGraceMs?: number;
};

export type AdapterConnectionRunContext = {
  readonly connection: AdapterConnectionContext;
} & AdapterRunContext;

export type AdapterContinuationHandle = {
  /** Opaque, non-secret native session reference owned and interpreted by the adapter. */
  readonly reference: string;
  readonly expiresAt?: string;
};

export type AdapterSendInputContext = {
  readonly invocationId: string;
  readonly route: ResolvedRoute;
  readonly inputId: string;
  readonly content: readonly ContentPart[];
  readonly signal: AbortSignal;
};

export type AdapterInputResult = {
  /** Boundary acknowledged by the native session; this does not prove model consumption. */
  readonly boundary: "active-turn" | "next-supported-boundary";
};

export type AdapterRunResult = {
  readonly content: readonly ContentPart[];
  readonly artifacts: readonly ContentPart[];
  readonly effects: readonly WorkspaceEffect[];
  readonly observedIdentity: ObservedIdentity;
  readonly continuationHandle?: AdapterContinuationHandle;
  readonly usage?: Usage;
};

export type PolicyResolution = {
  readonly supported: boolean;
  readonly unsupported: readonly string[];
  readonly effectiveNativePolicy: Readonly<Record<string, JsonValue>>;
};

export type Adapter = {
  readonly id: string;
  readonly discover: () => Promise<readonly RouteDescriptor[]>;
  readonly run: (context: AdapterRunContext) => Promise<AdapterRunResult>;
  /** Present only when discovery and execution both apply the named native context. */
  readonly discoverConnection?: (
    connection: AdapterConnectionContext,
  ) => Promise<readonly RouteDescriptor[]>;
  readonly runConnection?: (context: AdapterConnectionRunContext) => Promise<AdapterRunResult>;
  readonly sendInput?: (context: AdapterSendInputContext) => Promise<AdapterInputResult>;
  readonly resolvePolicy?: (
    request: StartInvocationRequest,
    route: RouteDescriptor,
  ) => PolicyResolution;
};
