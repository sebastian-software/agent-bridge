import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type PiRuntimeModelFiles = {
  readonly authPath: string;
  readonly modelsPath: string;
  readonly modelsStorePath: string;
};

export type PiRuntimeConfigurationFailureCode =
  | "pi_command_config_unsupported"
  | "pi_config_unavailable";

const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;
const COMMAND_VALUE_ERROR = "Pi runtime configuration contains an unsupported shell-command value.";
const CONFIG_READ_ERROR = "Pi runtime configuration could not be inspected safely.";

export class PiRuntimeConfigurationError extends Error {
  readonly code: PiRuntimeConfigurationFailureCode;

  constructor(code: PiRuntimeConfigurationFailureCode) {
    super(code === "pi_command_config_unsupported" ? COMMAND_VALUE_ERROR : CONFIG_READ_ERROR);
    this.name = "PiRuntimeConfigurationError";
    this.code = code;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function unavailable(): never {
  throw new PiRuntimeConfigurationError("pi_config_unavailable");
}

function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

// Match the JSON-with-comments/trailing-commas syntax accepted by Pi's ModelConfig loader.
function stripModelComments(content: string): string {
  return content
    .replaceAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) => (match.startsWith('"') ? match : ""))
    .replaceAll(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu,
      (match, tail: string | undefined) => tail ?? (match.startsWith('"') ? match : ""),
    );
}

async function readJsonFile(path: string, allowComments: boolean): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    unavailable();
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_FILE_BYTES) {
      unavailable();
    }

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_CONFIG_FILE_BYTES) {
      unavailable();
    }

    const text = stripBom(buffer.subarray(0, bytesRead).toString("utf8"));
    return JSON.parse(allowComments ? stripModelComments(text) : text) as unknown;
  } catch (error) {
    if (error instanceof PiRuntimeConfigurationError) {
      throw error;
    }
    unavailable();
  } finally {
    await file.close().catch(() => null);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCommandValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("!");
}

function headersContainCommand(value: unknown): boolean {
  const headers = record(value);
  return headers !== undefined && Object.values(headers).some(isCommandValue);
}

function authContainsCommand(value: unknown): boolean {
  const credentials = record(value);
  if (credentials === undefined) {
    return false;
  }
  return Object.values(credentials).some((credentialValue) => {
    const credential = record(credentialValue);
    return credential?.type === "api_key" && isCommandValue(credential.key);
  });
}

function providerContainsCommand(value: unknown): boolean {
  const provider = record(value);
  if (provider === undefined) {
    return false;
  }
  if (isCommandValue(provider.apiKey) || headersContainCommand(provider.headers)) {
    return true;
  }
  if (
    Array.isArray(provider.models) &&
    provider.models.some((modelValue) => headersContainCommand(record(modelValue)?.headers))
  ) {
    return true;
  }
  const overrides = record(provider.modelOverrides);
  return (
    overrides !== undefined &&
    Object.values(overrides).some((override) => headersContainCommand(record(override)?.headers))
  );
}

function modelsContainCommand(value: unknown): boolean {
  const providers = record(record(value)?.providers);
  return providers !== undefined && Object.values(providers).some(providerContainsCommand);
}

function modelStoreContainsCommand(value: unknown): boolean {
  const providers = record(value);
  if (providers === undefined) {
    return false;
  }
  return Object.values(providers).some((entryValue) => {
    const entry = record(entryValue);
    return (
      Array.isArray(entry?.models) &&
      entry.models.some((modelValue) => headersContainCommand(record(modelValue)?.headers))
    );
  });
}

function rejectCommandValues(containsCommand: boolean): void {
  if (containsCommand) {
    throw new PiRuntimeConfigurationError("pi_command_config_unsupported");
  }
}

function parseAuthStorageContent(content: string | undefined): unknown {
  if (content === undefined || content.length === 0) {
    return {};
  }
  try {
    return JSON.parse(stripBom(content)) as unknown;
  } catch {
    unavailable();
  }
}

/** Reject Pi auth.json command values while the SDK's own file lock is held. */
export function assertPiAuthStorageContentSafe(content: string | undefined): void {
  const parsed = parseAuthStorageContent(content);
  if (record(parsed) === undefined) {
    unavailable();
  }
  rejectCommandValues(authContainsCommand(parsed));
}

/** Scan one provider as returned by the pinned SDK's immutable ModelConfig snapshot. */
function assertPiProviderConfigurationSafe(provider: unknown): void {
  if (record(provider) === undefined) {
    unavailable();
  }
  rejectCommandValues(providerContainsCommand(provider));
}

/**
 * Validate the actual ModelConfig instance loaded by Pi 0.87.1. ModelRuntime.config is an
 * internal SDK field, so fail closed if its pinned accessors are absent or change shape.
 */
export function assertPiLoadedModelConfigurationSafe(configuration: unknown): void {
  const config = record(configuration);
  const getError = config?.getError;
  const getProviderIds = config?.getProviderIds;
  const getProvider = config?.getProvider;
  if (
    config === undefined ||
    typeof getError !== "function" ||
    typeof getProviderIds !== "function" ||
    typeof getProvider !== "function"
  ) {
    unavailable();
  }

  let configError: unknown;
  let providerIds: unknown;
  try {
    configError = getError.call(configuration);
    providerIds = getProviderIds.call(configuration);
  } catch {
    unavailable();
  }
  if (configError !== undefined && configError !== null && configError !== "") {
    unavailable();
  }
  if (
    !Array.isArray(providerIds) ||
    providerIds.some((providerId) => typeof providerId !== "string" || providerId.length === 0)
  ) {
    unavailable();
  }

  for (const providerId of providerIds) {
    let provider: unknown;
    try {
      provider = getProvider.call(configuration, providerId);
    } catch {
      unavailable();
    }
    assertPiProviderConfigurationSafe(provider);
  }
}

/** Validate the exact configuration snapshot on Pi ModelRuntime before its first request. */
export function assertPiModelRuntimeConfigurationSafe(runtime: unknown): void {
  const runtimeRecord = record(runtime);
  if (runtimeRecord === undefined || !("config" in runtimeRecord)) {
    unavailable();
  }
  assertPiLoadedModelConfigurationSafe(runtimeRecord.config);
}

/** Reject shell values across every explicit Pi config file before SDK code can resolve them. */
export async function assertPiRuntimeConfigurationSafe(files: PiRuntimeModelFiles): Promise<void> {
  const auth = await readJsonFile(files.authPath, false);
  if (auth !== null && record(auth) === undefined) {
    unavailable();
  }
  rejectCommandValues(authContainsCommand(auth));

  const models = await readJsonFile(files.modelsPath, true);
  if (models !== null && record(models) === undefined) {
    unavailable();
  }
  rejectCommandValues(modelsContainCommand(models));

  const modelStore = await readJsonFile(files.modelsStorePath, false);
  if (modelStore !== null && record(modelStore) === undefined) {
    unavailable();
  }
  rejectCommandValues(modelStoreContainsCommand(modelStore));
}
