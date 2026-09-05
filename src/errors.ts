export type BridgeErrorCode =
  | "auth_required"
  | "harness_failed"
  | "invalid_request"
  | "invocation_conflict"
  | "invocation_evicted"
  | "invocation_not_active"
  | "invocation_not_found"
  | "protocol_version_mismatch"
  | "route_ambiguous"
  | "route_unavailable"
  | "output_unparseable"
  | "unsupported_operation"
  | "unsupported_capability"
  | "version_unqualified"
  | "broker_unavailable"
  | "internal_error";

export interface BridgeErrorDetail {
  readonly code: BridgeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(detail: BridgeErrorDetail, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "BridgeError";
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.details = detail.details;
  }

  toDetail(): BridgeErrorDetail {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function errorDetail(error: unknown): BridgeErrorDetail {
  if (error instanceof BridgeError) {
    return error.toDetail();
  }

  return {
    code: "internal_error",
    message: "The broker could not complete the operation.",
    retryable: false,
  };
}
