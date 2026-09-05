import { readFile } from "node:fs/promises";
import { BridgeError } from "./errors.js";
import { defaultCatalogPath } from "./model-catalog.js";

export type ConfigSource = "default" | "config" | "env" | "cli";

export interface BrokerConfigValues {
  readonly retentionCompletedDays: number;
  readonly retentionMaxBytes: number;
  readonly diagnosticMode: boolean;
  readonly idleShutdownMinutes: number;
  readonly effectsMaxFiles: number;
  readonly effectsMaxBytes: number;
  readonly terminationGraceMs: number;
}

export interface BrokerConfig extends BrokerConfigValues {
  readonly sources: Readonly<Record<keyof BrokerConfigValues, ConfigSource>>;
  readonly configPath: string;
}

export const DEFAULT_BROKER_CONFIG: BrokerConfigValues = {
  retentionCompletedDays: 7,
  retentionMaxBytes: 1_073_741_824,
  diagnosticMode: false,
  idleShutdownMinutes: 30,
  effectsMaxFiles: 10_000,
  effectsMaxBytes: 256 * 1024 * 1024,
  terminationGraceMs: 2_000,
};

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new BridgeError({
    code: "invalid_request",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${field} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    invalid(`${field} must be a boolean.`);
  }
  return value;
}

function envNumber(name: string, minimum: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return numberValue(value, name, minimum);
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  invalid(`${name} must be true or false.`);
}

function sourceValues(root: Record<string, unknown>, configPath: string): Partial<BrokerConfigValues> {
  const source = root.broker === undefined ? root : object(root.broker, "config.broker");
  const retention = source.retention === undefined ? {} : object(source.retention, "config.broker.retention");
  const effects = source.effects === undefined ? {} : object(source.effects, "config.broker.effects");
  return {
    ...(retention.completedDays === undefined
      ? {}
      : { retentionCompletedDays: numberValue(retention.completedDays, `${configPath}: retention.completedDays`, 0) }),
    ...(retention.maxBytes === undefined
      ? {}
      : { retentionMaxBytes: numberValue(retention.maxBytes, `${configPath}: retention.maxBytes`, 1) }),
    ...(source.diagnosticMode === undefined
      ? {}
      : { diagnosticMode: booleanValue(source.diagnosticMode, `${configPath}: diagnosticMode`) }),
    ...(source.idleShutdownMinutes === undefined
      ? {}
      : { idleShutdownMinutes: numberValue(source.idleShutdownMinutes, `${configPath}: idleShutdownMinutes`, 0) }),
    ...(effects.maxFiles === undefined
      ? {}
      : { effectsMaxFiles: numberValue(effects.maxFiles, `${configPath}: effects.maxFiles`, 1) }),
    ...(effects.maxBytes === undefined
      ? {}
      : { effectsMaxBytes: numberValue(effects.maxBytes, `${configPath}: effects.maxBytes`, 1) }),
    ...(source.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: numberValue(source.terminationGraceMs, `${configPath}: terminationGraceMs`, 1) }),
  };
}

export async function loadBrokerConfig(cli: Partial<BrokerConfigValues> = {}): Promise<BrokerConfig> {
  const configPath = defaultCatalogPath();
  let fileValues: Partial<BrokerConfigValues> = {};
  try {
    const text = await readFile(configPath, "utf8");
    try {
      fileValues = sourceValues(object(JSON.parse(text) as unknown, "config"), configPath);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      invalid(`Config file ${configPath} is not valid JSON.`);
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        { code: "invalid_request", message: `Config file ${configPath} could not be read.`, retryable: false },
        { cause: error },
      );
    }
  }

  const environment: { -readonly [Key in keyof BrokerConfigValues]?: BrokerConfigValues[Key] } = {};
  const retentionCompletedDays = envNumber("AGENT_BRIDGE_RETENTION_COMPLETED_DAYS", 0);
  const retentionMaxBytes = envNumber("AGENT_BRIDGE_RETENTION_MAX_BYTES", 1);
  const diagnosticMode = envBoolean("AGENT_BRIDGE_DIAGNOSTIC_MODE");
  const idleShutdownMinutes = envNumber("AGENT_BRIDGE_IDLE_SHUTDOWN_MINUTES", 0);
  const effectsMaxFiles = envNumber("AGENT_BRIDGE_EFFECTS_MAX_FILES", 1);
  const effectsMaxBytes = envNumber("AGENT_BRIDGE_EFFECTS_MAX_BYTES", 1);
  const terminationGraceMs = envNumber("AGENT_BRIDGE_TERMINATION_GRACE_MS", 1);
  if (retentionCompletedDays !== undefined) environment.retentionCompletedDays = retentionCompletedDays;
  if (retentionMaxBytes !== undefined) environment.retentionMaxBytes = retentionMaxBytes;
  if (diagnosticMode !== undefined) environment.diagnosticMode = diagnosticMode;
  if (idleShutdownMinutes !== undefined) environment.idleShutdownMinutes = idleShutdownMinutes;
  if (effectsMaxFiles !== undefined) environment.effectsMaxFiles = effectsMaxFiles;
  if (effectsMaxBytes !== undefined) environment.effectsMaxBytes = effectsMaxBytes;
  if (terminationGraceMs !== undefined) environment.terminationGraceMs = terminationGraceMs;
  const values = { ...DEFAULT_BROKER_CONFIG, ...fileValues, ...environment, ...cli };
  const sources = Object.fromEntries(
    (Object.keys(DEFAULT_BROKER_CONFIG) as (keyof BrokerConfigValues)[]).map((key) => [
      key,
      cli[key] !== undefined
        ? "cli"
        : environment[key] !== undefined
          ? "env"
          : fileValues[key] !== undefined
            ? "config"
            : "default",
    ]),
  ) as Record<keyof BrokerConfigValues, ConfigSource>;
  for (const [key, value] of Object.entries(values)) {
    const minimum =
      key === "retentionCompletedDays" || key === "idleShutdownMinutes" ? 0 : key === "diagnosticMode" ? undefined : 1;
    if (key === "diagnosticMode") {
      booleanValue(value, key);
    } else {
      numberValue(value, key, minimum ?? 1);
    }
  }
  return { ...values, sources, configPath };
}

export function brokerConfigFromValues(values: Partial<BrokerConfigValues> = {}): BrokerConfig {
  const merged = { ...DEFAULT_BROKER_CONFIG, ...values };
  const sources = Object.fromEntries(
    (Object.keys(DEFAULT_BROKER_CONFIG) as (keyof BrokerConfigValues)[]).map((key) => [key, "default"]),
  ) as Record<keyof BrokerConfigValues, ConfigSource>;
  return { ...merged, sources, configPath: defaultCatalogPath() };
}
