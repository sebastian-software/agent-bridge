import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

import type { WorkspaceEffect } from "./contract.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;

interface FileFingerprint {
  readonly size: number;
  readonly modifiedAt: number;
  readonly mode: number;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: ReadonlyMap<string, FileFingerprint>;
  readonly complete: boolean;
  readonly diagnostics: readonly string[];
}

export interface EffectObservation {
  readonly effects: readonly WorkspaceEffect[];
  readonly complete: boolean;
  readonly diagnostics: readonly string[];
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

function pathsFromNulSeparated(value: string): readonly string[] {
  return value.split("\0").filter((path) => path !== "");
}

function statusRenames(value: string): ReadonlyMap<string, string> {
  const tokens = pathsFromNulSeparated(value);
  const renames = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (status === undefined) {
      continue;
    }
    const path = status.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && tokens[index + 1] !== undefined) {
      renames.set(path, tokens[index + 1] as string);
      index += 1;
    }
  }
  return renames;
}

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  let listed: string;
  try {
    listed = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  } catch (error) {
    return {
      root,
      files: new Map(),
      complete: false,
      diagnostics: [`Git workspace snapshot could not be read: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  }

  const files = new Map<string, FileFingerprint>();
  const diagnostics: string[] = [];
  let complete = true;
  let bytes = 0;
  const paths = pathsFromNulSeparated(listed);
  if (paths.length > MAX_FILES) {
    complete = false;
    diagnostics.push(`Workspace snapshot exceeded the ${MAX_FILES}-file limit.`);
  }
  for (const relativePath of paths.slice(0, MAX_FILES)) {
    let info;
    try {
      info = await lstat(`${root}/${relativePath}`);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        continue;
      }
      complete = false;
      diagnostics.push(`Could not stat workspace path ${relativePath}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    bytes += info.size;
    if (bytes > MAX_BYTES) {
      complete = false;
      diagnostics.push(`Workspace snapshot exceeded the ${MAX_BYTES}-byte limit.`);
      break;
    }
    files.set(relativePath, {
      size: info.size,
      modifiedAt: info.mtimeMs,
      mode: info.mode,
    });
  }
  return { root, files, complete, diagnostics };
}

export async function observeWorkspaceEffects(
  before: WorkspaceSnapshot | undefined,
  after: WorkspaceSnapshot,
): Promise<EffectObservation> {
  if (before === undefined) {
    return {
      effects: [],
      complete: false,
      diagnostics: ["No before-snapshot was available for this invocation."],
    };
  }
  const effects: WorkspaceEffect[] = [];
  const allPaths = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldFile = before.files.get(path);
    const newFile = after.files.get(path);
    if (oldFile === undefined && newFile !== undefined) {
      effects.push({ path, kind: "created", evidence: "git-status" });
    } else if (oldFile !== undefined && newFile === undefined) {
      effects.push({ path, kind: "deleted", evidence: "git-status" });
    } else if (oldFile !== undefined && newFile !== undefined && (
      oldFile.size !== newFile.size || oldFile.modifiedAt !== newFile.modifiedAt || oldFile.mode !== newFile.mode
    )) {
      effects.push({ path, kind: "modified", evidence: "git-status" });
    }
  }

  const deleted = effects.filter((effect) => effect.kind === "deleted");
  const created = effects.filter((effect) => effect.kind === "created");
  for (const oldEffect of deleted) {
    const oldFingerprint = before.files.get(oldEffect.path);
    const match = created.find((newEffect) => {
      const newFingerprint = after.files.get(newEffect.path);
      return oldFingerprint !== undefined && newFingerprint !== undefined
        && oldFingerprint.size === newFingerprint.size
        && oldFingerprint.modifiedAt === newFingerprint.modifiedAt
        && oldFingerprint.mode === newFingerprint.mode;
    });
    if (match === undefined) {
      continue;
    }
    const oldIndex = effects.indexOf(oldEffect);
    const newIndex = effects.indexOf(match);
    effects.splice(Math.max(oldIndex, newIndex), 1);
    effects.splice(Math.min(oldIndex, newIndex), 1);
    effects.push({ path: match.path, previousPath: oldEffect.path, kind: "renamed", evidence: "git-status" });
  }

  try {
    const status = await git(after.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const renames = statusRenames(status);
    for (const [oldPath, newPath] of renames) {
      const oldIndex = effects.findIndex((effect) => effect.path === oldPath && effect.kind === "deleted");
      const newIndex = effects.findIndex((effect) => effect.path === newPath && effect.kind === "created");
      if (oldIndex !== -1 && newIndex !== -1) {
        effects.splice(Math.max(oldIndex, newIndex), 1);
        effects.splice(Math.min(oldIndex, newIndex), 1);
        effects.push({ path: newPath, previousPath: oldPath, kind: "renamed", evidence: "git-status" });
      }
    }
  } catch (error) {
    return {
      effects,
      complete: false,
      diagnostics: [...before.diagnostics, ...after.diagnostics, `Git status could not be read: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  }
  return {
    effects,
    complete: before.complete && after.complete,
    diagnostics: [...before.diagnostics, ...after.diagnostics],
  };
}
