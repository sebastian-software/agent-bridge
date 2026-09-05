import { join } from "node:path";

import type { JsonValue, ObservedIdentity, RouteDescriptor, Usage, WorkspaceEffect } from "../contract.js";
import { type CommandSpec, type ContentAccumulator, ProcessAdapter, promptFor } from "./process.js";
import type { AdapterEvent, AdapterRunContext } from "./types.js";

const SCENARIOS = [
  "success",
  "failure",
  "timeout",
  "malformed",
  "truncated",
  "effects",
  "cancel",
  "identity-absent",
  "slow",
  "exit-before-read",
] as const;

function route(model: string): RouteDescriptor {
  return {
    routeId: `fake-process:${model}`,
    provider: "agent-bridge",
    model,
    efforts: ["high"],
    via: "fake-process",
    adapter: "fake-process",
    executable: process.execPath,
    harnessVersion: "1.0.0",
    authenticationMode: "none",
    capabilities: ["core.input.text", "core.output.text", "core.streaming.events"],
    interactionStrategies: ["deny", "unattended"],
    assurance: "none",
    runtimeIdentityEvidence: "verified",
    readiness: "ready",
    qualification: [
      {
        qualificationId: `fake-process-${model}-v1`,
        testedAt: "2026-08-27T00:00:00.000Z",
        claim: "Broker process-supervision fixture backed by the deterministic fake harness.",
      },
    ],
    diagnostics: ["Test fixture only; it does not call an external model."],
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const inputTokens = numberValue(source.inputTokens);
  const outputTokens = numberValue(source.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    evidence: "reported",
    source: "fake-process",
  };
}

export class FakeProcessAdapter extends ProcessAdapter {
  readonly id = "fake-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return SCENARIOS.map(route);
  }

  protected command(context: AdapterRunContext): CommandSpec {
    const harness = process.env.AGENT_BRIDGE_FAKE_HARNESS_PATH ?? join(process.cwd(), "scripts", "fake-harness.mjs");
    if (context.route.model === "exit-before-read") {
      return {
        executable: process.execPath,
        args: [harness, "--scenario", context.route.model, "--cwd", context.request.workingDirectory],
        stdin: promptFor(context),
      };
    }
    return {
      executable: process.execPath,
      args: [
        harness,
        "--scenario",
        context.route.model,
        "--text",
        promptFor(context),
        "--cwd",
        context.request.workingDirectory,
      ],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined {
    const type = typeof value.type === "string" ? value.type : "unknown";
    if (value.provider === "agent-bridge" || value.model !== undefined || value.harnessVersion !== undefined) {
      state.identity = {
        ...state.identity,
        ...(typeof value.provider === "string"
          ? { provider: { value: value.provider, evidence: "reported", source: "fake-process" } }
          : {}),
        ...(typeof value.model === "string"
          ? { model: { value: value.model, evidence: "reported", source: "fake-process" } }
          : {}),
        ...(typeof value.harnessVersion === "string"
          ? { harnessVersion: { value: value.harnessVersion, evidence: "reported", source: "fake-process" } }
          : {}),
      };
    }
    if (type === "progress") {
      return {
        category: "activity",
        data: { phase: "fake-process", ...(typeof value.step === "number" ? { step: value.step } : {}) },
        native: value,
      };
    }
    if (type === "diagnostic") {
      return {
        category: "diagnostic",
        data: { message: typeof value.message === "string" ? value.message : "fake diagnostic" },
        native: value,
      };
    }
    if (type === "effect") {
      const path = typeof value.path === "string" ? value.path : undefined;
      if (path === undefined) {
        return undefined;
      }
      const effect: WorkspaceEffect = {
        path,
        kind: value.kind === "renamed" ? "renamed" : "modified",
        evidence: "harness-reported",
      };
      return { category: "effect", effects: [effect], native: value };
    }
    if (type === "assistant") {
      const text = typeof value.text === "string" ? value.text : undefined;
      if (text === undefined) {
        return undefined;
      }
      state.content.add(text);
      return { category: "output", content: [{ type: "text", text }], native: value };
    }
    if (type === "result") {
      const reportedUsage = usage(value.usage);
      return {
        category: reportedUsage === undefined ? "lifecycle" : "usage",
        ...(reportedUsage === undefined ? {} : { usage: reportedUsage }),
        data: { state: "native_result" },
        native: value,
      };
    }
    return type === "init" ? { category: "lifecycle", native: value } : undefined;
  }
}
