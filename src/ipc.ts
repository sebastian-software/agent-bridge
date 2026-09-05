import { appendFile, lstat, mkdir, chmod, rename, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { Broker } from "./broker.js";
import { IPC_PROTOCOL_VERSION, parseOperationRequest, type OperationResponse } from "./contract.js";
import { BridgeError, errorDetail, type BridgeErrorCode } from "./errors.js";
import { ensurePrivateDirectory } from "./paths.js";

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_LOG_BYTES = 1_048_576;

const BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set<BridgeErrorCode>([
  "invalid_request",
  "invocation_conflict",
  "invocation_evicted",
  "invocation_not_active",
  "invocation_not_found",
  "protocol_version_mismatch",
  "route_ambiguous",
  "route_unavailable",
  "auth_required",
  "harness_failed",
  "output_unparseable",
  "unsupported_capability",
  "version_unqualified",
  "unsupported_operation",
  "broker_unavailable",
  "internal_error",
]);

function remoteErrorCode(code: unknown): BridgeErrorCode {
  return typeof code === "string" && BRIDGE_ERROR_CODES.has(code)
    ? code as BridgeErrorCode
    : "internal_error";
}

function brokerUnavailable(message: string, cause?: unknown): BridgeError {
  return new BridgeError({
    code: "broker_unavailable",
    message,
    retryable: true,
  }, cause === undefined ? undefined : { cause });
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export class BrokerServer {
  readonly #broker: Broker;
  readonly #socketPath: string;
  readonly #runtimeDirectory: string;
  readonly #idleShutdownMs: number;
  readonly #logFile: string;
  #idleTimer: NodeJS.Timeout | undefined;
  #lastRequestAt = Date.now();
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #stopPromise: Promise<void> | undefined;
  #resolveClosed: (() => void) | undefined;
  readonly #closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(broker: Broker, socketPath: string, runtimeDirectory = dirname(socketPath), idleShutdownMinutes = 0, logFile?: string) {
    this.#broker = broker;
    this.#socketPath = socketPath;
    this.#runtimeDirectory = runtimeDirectory;
    this.#idleShutdownMs = idleShutdownMinutes * 60 * 1000;
    this.#logFile = logFile ?? `${dirname(socketPath)}/broker.log`;
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  async start(): Promise<void> {
    await ensurePrivateDirectory(this.#runtimeDirectory, "runtime");
    await mkdir(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    try {
      const existing = await lstat(this.#socketPath);
      if (!existing.isSocket()) {
        throw new BridgeError({
          code: "broker_unavailable",
          message: `Refusing to replace non-socket path: ${this.#socketPath}`,
          retryable: false,
        });
      }
      if (await socketAcceptsConnections(this.#socketPath)) {
        throw new BridgeError({
          code: "broker_unavailable",
          message: `A broker is already listening at ${this.#socketPath}.`,
          retryable: false,
        });
      }
      await unlink(this.#socketPath);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#socketPath);
    });
    await chmod(this.#socketPath, 0o600);
    await this.#writeLog(`broker started pid=${String(process.pid)}`);
    this.#scheduleIdleCheck();
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    await this.#writeLog(`broker stopping pid=${String(process.pid)}`);
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#broker.close();
    try {
      const existing = await lstat(this.#socketPath);
      if (existing.isSocket()) {
        await unlink(this.#socketPath);
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    this.#resolveClosed?.();
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let received = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > MAX_MESSAGE_BYTES) {
        handled = true;
        this.#send(socket, {
          id: "unknown",
          ok: false,
          error: {
            code: "invalid_request",
            message: "The IPC request exceeds the one-MiB limit.",
            retryable: false,
          },
        });
        return;
      }
      const newline = received.indexOf("\n");
      if (newline === -1) {
        return;
      }
      handled = true;
      const line = received.slice(0, newline);
      this.#handle(line).then(
        ({ response, shutdown }) => this.#send(socket, response, shutdown),
        (error: unknown) => this.#send(socket, {
          id: "unknown",
          ok: false,
          error: errorDetail(error),
        }, false),
      );
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => this.#sockets.delete(socket));
  }

  async #handle(line: string): Promise<{ readonly response: OperationResponse; readonly shutdown: boolean }> {
    this.#lastRequestAt = Date.now();
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      throw new BridgeError({
        code: "invalid_request",
        message: "The IPC request is not valid JSON.",
        retryable: false,
      }, { cause: error });
    }
    let request;
    try {
      request = parseOperationRequest(decoded);
    } catch (error) {
      const id = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        && "id" in decoded && typeof decoded.id === "string"
        ? decoded.id
        : "unknown";
      return {
        response: { id, ok: false, error: errorDetail(error) },
        shutdown: false,
      };
    }
    try {
      const result = await this.#broker.execute(request.operation, request.params);
      return {
        response: { id: request.id, ok: true, result },
        shutdown: request.operation === "system.shutdown",
      };
    } catch (error) {
      return {
        response: { id: request.id, ok: false, error: errorDetail(error) },
        shutdown: false,
      };
    }
  }

  #send(socket: Socket, response: OperationResponse, shutdown = false): void {
    socket.end(`${JSON.stringify(response)}\n`, () => {
      if (shutdown) {
        this.stop().catch((error: unknown) => {
          process.emitWarning(`Failed to stop broker: ${error instanceof Error ? error.message : "unknown error"}`);
        });
      }
    });
  }

  #scheduleIdleCheck(): void {
    if (this.#idleShutdownMs <= 0) {
      return;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      const active = this.#broker.status().activeInvocations;
      if (active === 0 && Date.now() - this.#lastRequestAt >= this.#idleShutdownMs) {
        this.stop().catch((error: unknown) => {
          process.emitWarning(`Failed to stop idle broker: ${error instanceof Error ? error.message : "unknown error"}`);
        });
        return;
      }
      this.#scheduleIdleCheck();
    }, Math.max(100, this.#idleShutdownMs));
    this.#idleTimer.unref();
  }

  async #writeLog(message: string): Promise<void> {
    try {
      await mkdir(dirname(this.#logFile), { recursive: true, mode: 0o700 });
      try {
        const info = await stat(this.#logFile);
        if (info.size >= MAX_LOG_BYTES) {
          await rename(this.#logFile, `${this.#logFile}.1`).catch(() => undefined);
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
          return;
        }
      }
      await appendFile(this.#logFile, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Logging must never prevent the broker from serving requests.
    }
  }
}

export class IpcClient {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  async request(operation: string, params: unknown): Promise<unknown> {
    const id = `req_${crypto.randomUUID()}`;
    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      let received = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ protocolVersion: IPC_PROTOCOL_VERSION, id, operation, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (Buffer.byteLength(received, "utf8") > MAX_MESSAGE_BYTES * 8) {
          socket.destroy();
          reject(brokerUnavailable("The broker response exceeds the eight-MiB client limit."));
        }
      });
      socket.once("end", () => {
        try {
          resolve(JSON.parse(received.trim()) as unknown);
        } catch (error) {
          reject(brokerUnavailable("The broker returned an invalid JSON response.", error));
        }
      });
      socket.once("error", (error) => reject(brokerUnavailable(`Cannot connect to broker at ${this.#socketPath}.`, error)));
      socket.setTimeout(35_000, () => {
        socket.destroy();
        reject(brokerUnavailable("The broker request timed out."));
      });
    });

    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw brokerUnavailable("The broker response envelope is invalid.");
    }
    if (!("id" in response) || response.id !== id || !("ok" in response) || typeof response.ok !== "boolean") {
      throw brokerUnavailable("The broker response identity is invalid.");
    }
    if (response.ok) {
      if (!("result" in response)) {
        throw brokerUnavailable("The broker success response has no result.");
      }
      return response.result;
    }
    if (!("error" in response) || typeof response.error !== "object" || response.error === null) {
      throw brokerUnavailable("The broker error response is invalid.");
    }
    const remote = response.error;
    const message = "message" in remote && typeof remote.message === "string"
      ? remote.message
      : "The broker returned an unspecified error.";
    const retryable = "retryable" in remote && typeof remote.retryable === "boolean" && remote.retryable;
    const details = "details" in remote && typeof remote.details === "object" && remote.details !== null && !Array.isArray(remote.details)
      ? remote.details as Readonly<Record<string, unknown>>
      : undefined;
    throw new BridgeError({
      code: remoteErrorCode("code" in remote ? remote.code : undefined),
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    });
  }
}
