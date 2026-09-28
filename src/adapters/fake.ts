import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { ContentPart, ObservedIdentity, RouteDescriptor } from "../contract.js";
import { BridgeError } from "../errors.js";
import type {
  Adapter,
  AdapterContinuationHandle,
  AdapterRunContext,
  AdapterRunResult,
  AdapterSendInputContext,
} from "./types.js";

const QUALIFIED_AT = "2026-08-27T00:00:00.000Z";

function route(model: string): RouteDescriptor {
  const dialogueCapabilities =
    model === "fake-slow"
      ? ["steering", "continuation"]
      : model === "fake-question"
        ? ["questions"]
        : model === "fake-echo"
          ? ["continuation"]
          : [];
  return {
    routeId: `fake:${model}`,
    provider: "harness-relay",
    model,
    efforts: ["low", "medium", "high"],
    via: "fake",
    adapter: "fake",
    harnessVersion: "1.0.0",
    authenticationMode: "none",
    capabilities: [
      "core.input.text",
      "core.output.text",
      "core.streaming.events",
      ...dialogueCapabilities,
    ],
    interactionStrategies: ["deny", "orchestrator", "unattended"],
    assurance: "none",
    runtimeIdentityEvidence: "verified",
    readiness: "ready",
    qualification: [
      {
        qualificationId: `fake-${model}-v1`,
        testedAt: QUALIFIED_AT,
        claim: "Deterministic in-process fixture for contract and lifecycle tests.",
      },
    ],
    diagnostics: ["Test fixture only; it does not call an external model."],
  };
}

function observedIdentity(model: string): ObservedIdentity {
  return {
    provider: { value: "harness-relay", evidence: "verified", source: "fake-adapter" },
    model: { value: model, evidence: "verified", source: "fake-adapter" },
    harnessVersion: { value: "1.0.0", evidence: "verified", source: "fake-adapter" },
    nativeSessionId: { evidence: "unverified" },
  };
}

export class FakeAdapter implements Adapter {
  readonly id = "fake";
  readonly #active = new Map<string, { readonly input: ContentPart[] }>();
  readonly #continuations = new Map<string, readonly ContentPart[]>();

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [route("fake-echo"), route("fake-slow"), route("fake-fail"), route("fake-question")];
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const previous = this.#continuationInput(context.continuationHandle);
    const session = { input: [] as ContentPart[] };
    this.#active.set(context.invocationId, session);
    const steps = context.route.model === "fake-slow" ? 40 : 2;
    const stepDelayMs = context.route.model === "fake-slow" ? 100 : 15;

    try {
      if (context.route.model === "fake-question") {
        await context.emit({
          category: "input_required",
          inputRequest: {
            requestId: "fake-question-1",
            kind: "question",
            prompt: "Which directory should the fake delegate inspect?",
          },
        });
        if (context.awaitAnswer === undefined) {
          throw new Error("The fake question route requires a caller answer handler.");
        }
        session.input.push(...(await context.awaitAnswer("fake-question-1", context.signal)));
      } else {
        for (let index = 1; index <= steps; index += 1) {
          await delay(stepDelayMs, undefined, { signal: context.signal });
          await context.emit({
            category: "activity",
            data: {
              phase: "fake-work",
              step: index,
              totalSteps: steps,
            },
          });
        }
      }

      if (context.route.model === "fake-fail") {
        throw new Error("The deterministic fake adapter was asked to fail.");
      }

      const content = [...previous, ...context.request.input, ...session.input];
      await context.emit({
        category: "output",
        content,
        data: { final: true },
      });
      const continuationHandle = context.route.capabilities.includes("continuation")
        ? this.#createContinuation(content)
        : undefined;

      return {
        content,
        artifacts: [],
        effects: [],
        observedIdentity: observedIdentity(context.route.model),
        ...(continuationHandle === undefined ? {} : { continuationHandle }),
      };
    } finally {
      this.#active.delete(context.invocationId);
    }
  }

  async sendInput(
    context: AdapterSendInputContext,
  ): Promise<{ readonly boundary: "next-supported-boundary" }> {
    if (context.signal.aborted) {
      throw new DOMException("The invocation is no longer active.", "AbortError");
    }
    const session = this.#active.get(context.invocationId);
    if (session === undefined) {
      throw new BridgeError({
        code: "invocation_not_active",
        message: `Invocation ${context.invocationId} no longer has an active fake session.`,
        retryable: false,
      });
    }
    session.input.push(...context.content);
    return { boundary: "next-supported-boundary" };
  }

  #continuationInput(handle: AdapterContinuationHandle | undefined): readonly ContentPart[] {
    if (handle === undefined) {
      return [];
    }
    const content = this.#continuations.get(handle.reference);
    if (content === undefined) {
      throw new BridgeError({
        code: "continuation_expired",
        message: "The fake delegate session is no longer retained by its adapter.",
        retryable: false,
      });
    }
    return content;
  }

  #createContinuation(content: readonly ContentPart[]): AdapterContinuationHandle | undefined {
    const reference = randomUUID();
    this.#continuations.set(reference, content);
    return { reference };
  }
}
