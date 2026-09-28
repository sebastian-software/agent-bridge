import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

const BRIDGE_INTERNAL_ENVIRONMENT_PREFIXES = ["HARNESS_RELAY_", "AGENT_BRIDGE_"] as const;

export type NativeContextDirectory = {
  /** The path spelling to pass to the native harness. */
  readonly path: string;
  /** Paths the harness may report after resolving a symlink. */
  readonly privatePaths: readonly string[];
};

export function childEnvironment(
  overrides?: NodeJS.ProcessEnv,
  denyList: readonly string[] = [],
): NodeJS.ProcessEnv {
  const denied = new Set(denyList);
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      ([key]) =>
        !BRIDGE_INTERNAL_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !denied.has(key),
    ),
  );
}

export async function inspectNativeContextDirectory(
  reference: string,
): Promise<NativeContextDirectory | undefined> {
  const path =
    reference === "~"
      ? homedir()
      : reference.startsWith(`~${sep}`)
        ? join(homedir(), reference.slice(2))
        : reference;
  if (!isAbsolute(path)) {
    return undefined;
  }
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return undefined;
    }
    await access(path, constants.R_OK);
    const canonicalPath = await realpath(path);
    return {
      path,
      privatePaths: [...new Set([reference, path, canonicalPath])],
    };
  } catch {
    return undefined;
  }
}

export function redactNativeContextText(text: string, references: readonly string[]): string {
  const replacements = references
    .filter((reference) => reference !== "")
    .flatMap((reference) => [reference, encodeURI(reference), encodeURIComponent(reference)])
    .filter((reference, index, all) => all.indexOf(reference) === index)
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const reference of replacements) {
    result = result.replaceAll(reference, "[redacted native context]");
  }
  return result;
}

function redactNativeContextValue(value: unknown, references: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactNativeContextText(value, references);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => redactNativeContextValue(item, references));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries: Array<[string, unknown]> = Object.entries(record).map(([key, item]) => [
      redactNativeContextText(key, references),
      redactNativeContextValue(item, references),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function redactNativeContextData<T>(value: T, references: readonly string[]): T {
  return redactNativeContextValue(value, references) as T;
}
