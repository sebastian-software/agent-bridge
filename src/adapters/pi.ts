import type { JsonValue, RouteDescriptor } from "../contract.js";
import type { PiWorkerSessionRequest } from "./pi-protocol.js";
import type { Adapter, AdapterRunContext, AdapterRunResult, PolicyResolution } from "./types.js";

import { BridgeError } from "../errors.js";
import { piContinuationBinding, PiContinuationStore } from "./pi-continuation.js";
import { type PiRuntimeConfiguration, runPiWorkerSession } from "./pi-supervisor.js";

const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export class PiAdapter implements Adapter {
  readonly id = "pi";
  readonly #configuration: PiRuntimeConfiguration;
  readonly #continuations: PiContinuationStore;

  constructor(
    configuration: PiRuntimeConfiguration,
    options?: { readonly continuationStore?: PiContinuationStore },
  ) {
    this.#configuration = configuration;
    this.#continuations = options?.continuationStore ?? new PiContinuationStore();
  }

  // Runtime discovery is intentionally empty until local endpoint/model
  // configuration and live qualification are implemented in later slices.
  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  resolvePolicy(request: AdapterRunContext["request"], _route: RouteDescriptor): PolicyResolution {
    return this.#resolvePolicy(request);
  }

  #resolvePolicy(request: AdapterRunContext["request"]): PolicyResolution {
    const unsupported: string[] = [];
    const policy = request.requestedPolicy;
    if (policy.minimumAssurance !== "none") {
      unsupported.push(`minimumAssurance=${policy.minimumAssurance}`);
    }
    if (policy.filesystem === "workspace-write") {
      unsupported.push("filesystem=workspace-write requires an OS-enforced workspace sandbox");
    }
    if (
      policy.filesystem === "read-only" &&
      this.#configuration.tools.some((tool) => MUTATING_TOOLS.has(tool))
    ) {
      unsupported.push("filesystem=read-only conflicts with enabled mutating Pi tools");
    }
    if (policy.commands === "deny" && this.#configuration.tools.includes("bash")) {
      unsupported.push("commands=deny conflicts with the enabled Pi bash tool");
    }
    if (policy.network === "deny") {
      unsupported.push("network=deny cannot be enforced by the Pi worker or model endpoint");
    }
    if ((policy.additionalDirectories?.length ?? 0) > 0) {
      unsupported.push("additionalDirectories are not supported by this Pi worker");
    }
    const effectiveNativePolicy: Readonly<Record<string, JsonValue>> = {
      runtime: "pi-coding-agent",
      assurance: "none",
      sandbox: "none",
      extensions: "disabled",
      tools: [...this.#configuration.tools],
    };
    return { supported: unsupported.length === 0, unsupported, effectiveNativePolicy };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    if (context.request.interactionStrategy === "orchestrator") {
      throw new BridgeError({
        code: "unsupported_capability",
        message: "The private Pi worker has no qualified orchestrator input channel.",
        retryable: false,
      });
    }
    if (
      context.request.interactionStrategy !== "deny" &&
      context.request.interactionStrategy !== "unattended"
    ) {
      throw new BridgeError({
        code: "unsupported_capability",
        message: "The private Pi worker cannot honor this interaction strategy.",
        retryable: false,
      });
    }
    const policy = this.#resolvePolicy(context.request);
    if (!policy.supported) {
      throw new BridgeError({
        code: "unsupported_capability",
        message: "The private Pi worker cannot enforce the requested policy.",
        retryable: false,
        details: { unsupported: [...policy.unsupported] },
      });
    }
    const isContinuation = context.continuationHandle !== undefined;
    const binding = await piContinuationBinding(context, this.#configuration, {
      requireWorkingDirectory: isContinuation,
    });
    if (context.continuationHandle !== undefined) {
      const retained = await this.#continuations.resume(context.continuationHandle, binding);
      const directory = await this.#continuations.createSessionDirectory();
      try {
        const sessionRequest: PiWorkerSessionRequest = {
          mode: "branch",
          sourceDirectory: retained.directory,
          directory,
          sessionFile: retained.snapshot.sessionFile,
          expectedSessionId: retained.snapshot.sessionId,
          expectedCwd: retained.snapshot.cwd,
          terminalLeafId: retained.snapshot.terminalLeafId,
        };
        const run = await runPiWorkerSession(context, this.#configuration, sessionRequest);
        const nextBinding = await piContinuationBinding(context, this.#configuration, {
          requireWorkingDirectory: true,
        });
        if (nextBinding !== binding) {
          throw new BridgeError({
            code: "continuation_route_changed",
            message:
              "The Pi route, account, policy, or model configuration changed during continuation.",
            retryable: false,
          });
        }
        return {
          ...run.result,
          continuationHandle: await this.#continuations.retain(directory, run.session, binding),
        };
      } catch (error) {
        await this.#continuations.discardSessionDirectory(directory);
        throw error;
      }
    }

    const directory = await this.#continuations.createSessionDirectory();
    try {
      const run = await runPiWorkerSession(context, this.#configuration, {
        mode: "create",
        directory,
      });
      const nextBinding = await piContinuationBinding(context, this.#configuration);
      if (nextBinding !== binding) {
        throw new BridgeError({
          code: "harness_failed",
          message: "The Pi model configuration changed during the invocation.",
          retryable: false,
        });
      }
      return {
        ...run.result,
        continuationHandle: await this.#continuations.retain(directory, run.session, binding),
      };
    } catch (error) {
      await this.#continuations.discardSessionDirectory(directory);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.#continuations.dispose();
  }
}
