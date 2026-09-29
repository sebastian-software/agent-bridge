import type { ContentPart } from "../contract.js";
import type { AdapterInputResult } from "./types.js";

import { BridgeError } from "../errors.js";
import {
  MAX_PI_PENDING_STEERING_BYTES,
  MAX_PI_PENDING_STEERING_INPUTS,
  MAX_PI_STEERING_INPUT_BYTES,
  type PiSteeringMessage,
} from "./pi-protocol.js";

export type { PiSteeringMessage } from "./pi-protocol.js";

type PendingSteeringInput = {
  readonly message: PiSteeringMessage;
  readonly bytes: number;
  readonly resolve: (result: AdapterInputResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  sent: boolean;
  settled: boolean;
};

function abortError(): Error {
  const error = new Error("The Pi input delivery was aborted.");
  error.name = "AbortError";
  return error;
}

function closedError(): BridgeError {
  return new BridgeError({
    code: "invocation_not_active",
    message: "The Pi invocation is no longer accepting input.",
    retryable: false,
  });
}

function textInput(content: readonly ContentPart[]): string {
  if (content.length === 0 || content.some((part) => part.type !== "text")) {
    throw new BridgeError({
      code: "unsupported_capability",
      message: "Pi steering accepts text input only.",
      retryable: false,
    });
  }
  const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length === 0 || bytes > MAX_PI_STEERING_INPUT_BYTES) {
    throw new BridgeError({
      code: "invalid_request",
      message: "Pi steering input must contain text within the 64 KiB limit.",
      retryable: false,
    });
  }
  return text;
}

/** Invocation-scoped bridge between Adapter.sendInput and one supervised worker. */
export class PiSteeringPort {
  readonly #pending = new Map<string, PendingSteeringInput>();
  readonly #queue: PendingSteeringInput[] = [];
  readonly #closedAckIds = new Set<string>();
  #sender: ((message: PiSteeringMessage) => Promise<void>) | undefined;
  #drain: Promise<void> | undefined;
  #pendingBytes = 0;
  #accepting = true;
  #closed = false;

  async send(
    inputId: string,
    content: readonly ContentPart[],
    signal: AbortSignal,
  ): Promise<AdapterInputResult> {
    if (this.#closed || !this.#accepting || signal.aborted) {
      throw signal.aborted ? abortError() : closedError();
    }
    if (inputId.length === 0 || inputId.length > 128) {
      throw new BridgeError({
        code: "invalid_request",
        message: "The Pi input ID is invalid.",
        retryable: false,
      });
    }
    if (this.#pending.has(inputId)) {
      throw new BridgeError({
        code: "invocation_conflict",
        message: "The Pi worker already has a pending input with this ID.",
        retryable: false,
      });
    }
    const text = textInput(content);
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      this.#pending.size >= MAX_PI_PENDING_STEERING_INPUTS ||
      this.#pendingBytes + bytes > MAX_PI_PENDING_STEERING_BYTES
    ) {
      throw new BridgeError({
        code: "invocation_conflict",
        message: "The Pi worker input queue is full.",
        retryable: true,
      });
    }

    let resolve!: (result: AdapterInputResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<AdapterInputResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const message = { inputId, text };
    const entry = {
      message,
      bytes,
      resolve,
      reject,
      signal,
      onAbort: () => {
        this.#abortEntry(inputId);
      },
      sent: false,
      settled: false,
    } satisfies PendingSteeringInput;
    this.#pending.set(inputId, entry);
    this.#queue.push(entry);
    this.#pendingBytes += bytes;
    signal.addEventListener("abort", entry.onAbort, { once: true });
    if (signal.aborted) {
      entry.onAbort();
    } else {
      this.#scheduleDrain();
    }
    return result;
  }

  setSender(sender: (message: PiSteeringMessage) => Promise<void>): void {
    if (this.#closed || this.#sender !== undefined) {
      throw new Error("The Pi steering transport is already closed or connected.");
    }
    this.#sender = sender;
    this.#scheduleDrain();
  }

  acknowledge(inputId: string, accepted: boolean, message?: string): boolean {
    if (this.#closed) {
      return this.#closedAckIds.delete(inputId);
    }
    const entry = this.#pending.get(inputId);
    if (!entry?.sent) {
      return false;
    }
    this.#pending.delete(inputId);
    this.#pendingBytes -= entry.bytes;
    entry.signal.removeEventListener("abort", entry.onAbort);
    if (!entry.settled) {
      entry.settled = true;
      if (accepted) {
        entry.resolve({ boundary: "next-supported-boundary" });
      } else {
        entry.reject(new Error(message ?? "The Pi SDK did not accept the steering input."));
      }
    }
    return true;
  }

  async seal(): Promise<void> {
    this.#accepting = false;
    this.#scheduleDrain();
    await this.#drain;
  }

  close(error: Error = closedError()): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#accepting = false;
    this.#queue.length = 0;
    for (const [inputId, entry] of this.#pending) {
      if (entry.sent) {
        this.#closedAckIds.add(inputId);
      }
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
    }
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  #abortEntry(inputId: string): void {
    const entry = this.#pending.get(inputId);
    if (entry === undefined || entry.settled) {
      return;
    }
    entry.settled = true;
    entry.reject(abortError());
    if (!entry.sent) {
      this.#pending.delete(inputId);
      this.#pendingBytes -= entry.bytes;
      entry.signal.removeEventListener("abort", entry.onAbort);
      const index = this.#queue.indexOf(entry);
      if (index !== -1) {
        this.#queue.splice(index, 1);
      }
    }
  }

  #scheduleDrain(): void {
    if (this.#closed || this.#sender === undefined || this.#drain !== undefined) {
      return;
    }
    const drain = this.#drainQueue();
    this.#drain = drain;
    void drain
      .catch((error: unknown) => {
        this.close(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (this.#drain === drain) {
          this.#drain = undefined;
        }
        if (!this.#closed && this.#queue.length > 0) {
          this.#scheduleDrain();
        }
      });
  }

  async #drainQueue(): Promise<void> {
    while (!this.#closed && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (entry === undefined) {
        continue;
      }
      if (entry.settled) {
        this.#pending.delete(entry.message.inputId);
        this.#pendingBytes -= entry.bytes;
        entry.signal.removeEventListener("abort", entry.onAbort);
        continue;
      }
      entry.sent = true;
      await this.#sender?.(entry.message);
    }
  }
}
