import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";

import type { InteractionStrategy, RouteDescriptor } from "../contract.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_500;

export interface AdapterModelManifest {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly capabilities: readonly string[];
  readonly interactionStrategies: readonly InteractionStrategy[];
}

export interface AdapterManifest {
  readonly id: string;
  readonly provider: string;
  readonly via: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly authArgs: readonly string[];
  readonly qualifiedMajor: number;
  readonly authenticationMode: string;
  readonly models: readonly AdapterModelManifest[];
  readonly qualificationClaim: string;
}

export interface DiscoveryProbe {
  readonly findExecutable?: (command: string) => Promise<string | undefined>;
  readonly readVersion?: (executable: string, args: readonly string[]) => Promise<string | undefined>;
  readonly checkAuthentication?: (executable: string, args: readonly string[]) => Promise<boolean>;
}

export function parseVersion(value: string | undefined): { readonly major: number; readonly value: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)/.exec(value);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return { major: Number(match[1]), value: match[0].trim() };
}

async function findExecutable(command: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("which", [command], { timeout: PROBE_TIMEOUT_MS });
    const executable = result.stdout.trim().split("\n").at(0);
    return executable === undefined || executable === "" ? undefined : executable;
  } catch {
    return undefined;
  }
}

async function readVersion(executable: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync(executable, [...args], { timeout: PROBE_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return output === "" ? undefined : output;
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
      return error.stdout.trim() || undefined;
    }
    return undefined;
  }
}

async function checkAuthentication(executable: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync(executable, [...args], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverManifestRoutes(
  manifest: AdapterManifest,
  options?: { readonly executable?: string; readonly probe?: DiscoveryProbe },
): Promise<readonly RouteDescriptor[]> {
  const probe = options?.probe ?? {};
  const executable = options?.executable
    ?? await (probe.findExecutable ?? findExecutable)(manifest.command);
  if (executable === undefined || !(await isExecutable(executable))) {
    return manifest.models.map((model) => ({
      routeId: `${manifest.id}:${model.model}`,
      ...(executable === undefined ? {} : { executable }),
      provider: manifest.provider,
      model: model.model,
      efforts: model.efforts,
      via: manifest.via,
      adapter: manifest.id,
      harnessVersion: "unknown",
      authenticationMode: manifest.authenticationMode,
      capabilities: model.capabilities,
      interactionStrategies: model.interactionStrategies,
      assurance: "native",
      runtimeIdentityEvidence: "unverified",
      readiness: "unavailable",
      qualification: [],
      diagnostics: [`Executable ${manifest.command} was not found or is not executable.`],
    }));
  }

  const versionOutput = await (probe.readVersion ?? readVersion)(executable, manifest.versionArgs);
  const version = parseVersion(versionOutput);
  if (version === undefined || version.major !== manifest.qualifiedMajor) {
    return manifest.models.map((model) => ({
      routeId: `${manifest.id}:${model.model}`,
      executable,
      provider: manifest.provider,
      model: model.model,
      efforts: model.efforts,
      via: manifest.via,
      adapter: manifest.id,
      harnessVersion: version?.value ?? "unknown",
      authenticationMode: manifest.authenticationMode,
      capabilities: model.capabilities,
      interactionStrategies: model.interactionStrategies,
      assurance: "native",
      runtimeIdentityEvidence: "unverified",
      readiness: "unqualified",
      qualification: [],
      diagnostics: [`Installed ${manifest.command} version is outside the qualified major version ${manifest.qualifiedMajor}.`],
    }));
  }

  const authenticated = await (probe.checkAuthentication ?? checkAuthentication)(executable, manifest.authArgs);
  return manifest.models.map((model) => ({
    routeId: `${manifest.id}:${model.model}`,
    executable,
    provider: manifest.provider,
    model: model.model,
    efforts: model.efforts,
    via: manifest.via,
    adapter: manifest.id,
    harnessVersion: version.value,
    authenticationMode: manifest.authenticationMode,
    capabilities: model.capabilities,
    interactionStrategies: model.interactionStrategies,
    assurance: "native",
    runtimeIdentityEvidence: "unverified",
    readiness: authenticated ? "ready" : "unavailable",
    qualification: [{
      qualificationId: `${manifest.id}-major-${manifest.qualifiedMajor}`,
      testedAt: "2026-09-05T00:00:00.000Z",
      claim: manifest.qualificationClaim,
    }],
    diagnostics: authenticated
      ? ["Authentication status probe succeeded; readiness remains provisional until an invocation succeeds."]
      : [`${manifest.command} authentication status could not be verified without starting a paid invocation.`],
  }));
}
