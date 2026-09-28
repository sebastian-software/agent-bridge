import type { JsonValue, RouteDescriptor } from "../contract.js";
import type { Adapter, AdapterRunContext, AdapterRunResult, PolicyResolution } from "./types.js";

import { BridgeError } from "../errors.js";
import { type PiRuntimeConfiguration, runPiWorker } from "./pi-supervisor.js";

const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export class PiAdapter implements Adapter {
  readonly id = "pi";
  readonly #configuration: PiRuntimeConfiguration;

  constructor(configuration: PiRuntimeConfiguration) {
    this.#configuration = configuration;
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
    return runPiWorker(context, this.#configuration);
  }
}
