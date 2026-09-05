import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { captureWorkspaceSnapshot, observeWorkspaceEffects } from "../src/effects.js";

const execFile = promisify(execFileCallback);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFile("git", ["-C", root, ...args]);
}

test("Git observation reports creates, modifications, deletes, renames, and ignores", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-effects-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Agent Bridge Test");
    await git(root, "config", "user.email", "agent-bridge-test@example.invalid");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
    await writeFile(join(root, "deleted.txt"), "delete me\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await git(root, "add", ".gitignore", "tracked.txt", "deleted.txt");
    await git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");

    const before = await captureWorkspaceSnapshot(root);
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    await rename(join(root, "deleted.txt"), join(root, "renamed.txt"));
    await writeFile(join(root, "created.txt"), "created\n", "utf8");
    const after = await captureWorkspaceSnapshot(root);
    const observation = await observeWorkspaceEffects(before, after);

    assert.equal(observation.complete, true);
    assert.deepEqual(observation.effects, [
      { path: "created.txt", kind: "created", evidence: "git-status" },
      { path: "tracked.txt", kind: "modified", evidence: "git-status" },
      { path: "renamed.txt", previousPath: "deleted.txt", kind: "renamed", evidence: "git-status" },
    ]);
    assert.ok(!observation.effects.some((effect) => effect.path === "ignored.txt"));
    assert.equal(await readFile(join(root, "renamed.txt"), "utf8"), "delete me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git directories report incomplete observation instead of claiming no effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-effects-non-git-"));
  try {
    await mkdir(join(root, "nested"));
    const snapshot = await captureWorkspaceSnapshot(root);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.diagnostics.length > 0);
    const observation = await observeWorkspaceEffects(snapshot, snapshot);
    assert.equal(observation.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
