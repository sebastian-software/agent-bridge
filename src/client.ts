import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type {
  EventsResult,
  InvocationEvent,
  InvocationListResult,
  InvocationOutcome,
  InvocationState,
  RouteDescriptor,
  StartInvocationRequest,
  StartInvocationResult,
} from "./contract.js";
import { BridgeError } from "./errors.js";
import { IpcClient } from "./ipc.js";
import { brokerPaths } from "./paths.js";
import { PACKAGE_VERSION } from "./version.js";

const MAX_STARTUP_DIAGNOSTIC_BYTES = 4 * 1024;

export interface InspectionResult {
  readonly schemaVersion: string;
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly callerCorrelationId?: string;
  readonly requested: StartInvocationRequest["selector"];
  readonly resolved: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly eventCount: number;
  readonly lastCursor?: string;
  readonly outcome?: InvocationOutcome;
  readonly next: readonly string[];
}

export interface WaitResult extends InspectionResult {
  readonly waited: boolean;
}

export interface ResultResult {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly outcome: InvocationOutcome;
}

export interface CancelResult {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly accepted: boolean;
  readonly terminal: boolean;
}

export interface BrokerStatus {
  readonly ready?: boolean;
  readonly running: boolean;
  readonly packageVersion?: string;
  readonly startedAt?: string;
  readonly pid?: number;
  readonly platform?: string;
  readonly socketPath: string;
  readonly stateFile?: string;
  readonly logFile?: string;
  readonly idleShutdownMinutes?: number;
  readonly activeInvocations?: number;
  readonly retainedInvocations?: number;
  readonly tombstones?: number;
  readonly diagnosticMode?: boolean;
}

export interface ContractDescription {
  readonly schemaVersion: string;
  readonly operationsVersion: string;
  readonly schemas: readonly Readonly<Record<string, unknown>>[];
  readonly operations: readonly Readonly<Record<string, unknown>>[];
  readonly broker?: Readonly<Record<string, unknown>>;
  readonly retention?: Readonly<Record<string, unknown>>;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface ClientOptions {
  /** Unix socket override; defaults to the standard broker path. */
  readonly socketPath?: string;
  /** Start a user-owned broker automatically when the socket is unavailable. */
  readonly autostart?: boolean;
}

type OperationResultMap = {
  readonly "system.describe": ContractDescription;
  readonly "system.status": BrokerStatus;
  readonly "route.discover": { readonly routes: readonly RouteDescriptor[] };
  readonly "invocation.start": StartInvocationResult;
  readonly "invocation.inspect": InspectionResult;
  readonly "invocation.get": InspectionResult;
  readonly "invocation.result": ResultResult;
  readonly "invocation.wait": WaitResult;
  readonly "invocation.events": EventsResult;
  readonly "invocation.cancel": CancelResult;
  readonly "invocation.list": InvocationListResult;
  readonly "invocation.respond": Readonly<Record<string, unknown>>;
  readonly "system.shutdown": Readonly<Record<string, unknown>>;
};

function brokerVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return "packageVersion" in value && typeof value.packageVersion === "string" ? value.packageVersion : undefined;
}

function activeInvocations(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  return "activeInvocations" in value && typeof value.activeInvocations === "number" ? value.activeInvocations : 0;
}

export class AgentBridgeClient {
  readonly #socketPath: string;
  readonly #autostart: boolean;

  constructor(options: ClientOptions = {}) {
    this.#socketPath = options.socketPath ?? brokerPaths().socketPath;
    this.#autostart = options.autostart ?? true;
  }

  describe(): Promise<ContractDescription> {
    return this.#request("system.describe", {});
  }

  routes(options: { readonly refresh?: boolean } = {}): Promise<{ readonly routes: readonly RouteDescriptor[] }> {
    return this.#request("route.discover", { refresh: options.refresh ?? false });
  }

  start(request: StartInvocationRequest): Promise<StartInvocationResult> {
    return this.#request("invocation.start", request);
  }

  inspect(invocationId: string): Promise<InspectionResult> {
    return this.#request("invocation.inspect", { invocationId });
  }

  get(invocationId: string): Promise<InspectionResult> {
    return this.#request("invocation.get", { invocationId });
  }

  events(
    invocationId: string,
    options: { readonly after?: string; readonly waitMs?: number } = {},
  ): Promise<EventsResult> {
    return this.#request("invocation.events", {
      invocationId,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    });
  }

  async *follow(invocationId: string): AsyncGenerator<InvocationEvent, void, undefined> {
    let after: string | undefined;
    while (true) {
      const page = await this.events(invocationId, { ...(after === undefined ? {} : { after }), waitMs: 30_000 });
      for (const event of page.events) {
        yield event;
      }
      if (page.nextCursor !== undefined) {
        after = page.nextCursor;
      }
      if (page.terminal) {
        return;
      }
    }
  }

  async wait(invocationId: string): Promise<WaitResult> {
    while (true) {
      const result = await this.#request("invocation.wait", { invocationId, timeoutMs: 30_000 });
      if (result.waited) {
        return result;
      }
    }
  }

  result(invocationId: string): Promise<ResultResult> {
    return this.#request("invocation.result", { invocationId });
  }

  cancel(invocationId: string): Promise<CancelResult> {
    return this.#request("invocation.cancel", { invocationId });
  }

  list(
    options: {
      readonly state?: InvocationState;
      readonly callerCorrelationId?: string;
      readonly since?: string;
      readonly limit?: number;
      readonly includeTombstones?: boolean;
    } = {},
  ): Promise<InvocationListResult> {
    return this.#request("invocation.list", {
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.callerCorrelationId === undefined ? {} : { callerCorrelationId: options.callerCorrelationId }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.includeTombstones === undefined ? {} : { includeTombstones: options.includeTombstones }),
    });
  }

  status(): Promise<BrokerStatus> {
    return this.#request("system.status", {}, false).catch((error: unknown) => {
      if (error instanceof BridgeError && error.code === "broker_unavailable") {
        return { running: false, socketPath: this.#socketPath };
      }
      throw error;
    });
  }

  shutdown(force = false): Promise<Readonly<Record<string, unknown>>> {
    return this.#request("system.shutdown", { force });
  }

  execute(operation: string, params: unknown): Promise<unknown> {
    return this.#request(operation as keyof OperationResultMap, params);
  }

  async run(request: StartInvocationRequest): Promise<ResultResult> {
    const started = await this.start(request);
    await this.wait(started.invocationId);
    return this.result(started.invocationId);
  }

  async #request<K extends keyof OperationResultMap>(
    operation: K,
    params: unknown,
    allowAutostart = this.#autostart,
  ): Promise<OperationResultMap[K]> {
    const client = new IpcClient(this.#socketPath);
    try {
      if (operation !== "system.status" && operation !== "system.shutdown") {
        const status = await client.request("system.status", {});
        const version = brokerVersion(status);
        if (version !== undefined && version !== PACKAGE_VERSION) {
          if (activeInvocations(status) > 0) {
            throw new BridgeError({
              code: "broker_unavailable",
              message: `Broker version ${version} is still serving active invocations.`,
              retryable: false,
            });
          }
          await client.request("system.shutdown", {});
          await delay(100);
        }
      }
      return (await client.request(operation, params)) as OperationResultMap[K];
    } catch (error) {
      if (
        !allowAutostart ||
        !(error instanceof BridgeError) ||
        error.code !== "broker_unavailable" ||
        !error.retryable
      ) {
        throw error;
      }
    }

    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cliPath, "broker", "serve"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENT_BRIDGE_DAEMON: "1" },
    });
    let startupStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (Buffer.byteLength(startupStderr, "utf8") < MAX_STARTUP_DIAGNOSTIC_BYTES) {
        startupStderr += chunk.slice(0, MAX_STARTUP_DIAGNOSTIC_BYTES);
      }
    });
    child.stderr?.on("error", () => undefined);
    child.unref();
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await delay(50);
      try {
        return (await client.request(operation, params)) as OperationResultMap[K];
      } catch (error) {
        lastError = error;
        if (!(error instanceof BridgeError) || error.code !== "broker_unavailable") {
          throw error;
        }
      }
    }
    const startupDiagnostic = startupStderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    throw new BridgeError(
      {
        code: "broker_unavailable",
        message: `The broker did not become ready at ${this.#socketPath}.${
          startupDiagnostic === undefined ? "" : ` Startup error: ${startupDiagnostic}`
        }`,
        retryable: true,
      },
      { cause: lastError },
    );
  }
}

export function createClient(options?: ClientOptions): AgentBridgeClient {
  return new AgentBridgeClient(options);
}
