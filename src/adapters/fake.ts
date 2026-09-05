import { setTimeout as delay } from "node:timers/promises";

import type { ObservedIdentity, RouteDescriptor } from "../contract.js";
import type { Adapter, AdapterRunContext, AdapterRunResult } from "./types.js";

const QUALIFIED_AT = "2026-08-27T00:00:00.000Z";

function route(model: string): RouteDescriptor {
  return {
    routeId: `fake:${model}`,
    provider: "agent-bridge",
    model,
    efforts: ["low", "medium", "high"],
    via: "fake",
    adapter: "fake",
    harnessVersion: "1.0.0",
    authenticationMode: "none",
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
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
    provider: { value: "agent-bridge", evidence: "verified", source: "fake-adapter" },
    model: { value: model, evidence: "verified", source: "fake-adapter" },
    harnessVersion: { value: "1.0.0", evidence: "verified", source: "fake-adapter" },
    nativeSessionId: { evidence: "unverified" },
  };
}

export class FakeAdapter implements Adapter {
  readonly id = "fake";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [route("fake-echo"), route("fake-slow"), route("fake-fail")];
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const steps = context.route.model === "fake-slow" ? 40 : 2;
    const stepDelayMs = context.route.model === "fake-slow" ? 100 : 15;

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

    if (context.route.model === "fake-fail") {
      throw new Error("The deterministic fake adapter was asked to fail.");
    }

    await context.emit({
      category: "output",
      content: context.request.input,
      data: { final: true },
    });

    return {
      content: context.request.input,
      artifacts: [],
      effects: [],
      observedIdentity: observedIdentity(context.route.model),
    };
  }
}
