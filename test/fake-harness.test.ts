import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const harnessPath = join(process.cwd(), "scripts", "fake-harness.mjs");

function events(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("fake harness emits a deterministic native-style success stream", async () => {
  const result = await execFile(process.execPath, [harnessPath, "--scenario", "success", "--text", "hello"]);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    events(result.stdout).map((event) => event.type),
    ["init", "progress", "assistant", "result"],
  );
  assert.equal(events(result.stdout).at(-1)?.status, "completed");
});

test("fake harness exposes failure and malformed-output scenarios", async () => {
  await assert.rejects(
    execFile(process.execPath, [harnessPath, "--scenario", "failure"]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 7,
  );
  const malformed = await execFile(process.execPath, [harnessPath, "--scenario", "malformed"]);
  assert.throws(() => events(malformed.stdout), SyntaxError);
});

test("fake harness writes and renames files in the requested workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-fake-"));
  try {
    await execFile(process.execPath, [harnessPath, "--scenario", "effects", "--cwd", root, "--text", "changed"]);
    assert.equal(await readFile(join(root, "fake-renamed.txt"), "utf8"), "changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fake harness can be cancelled while it is hanging", async () => {
  const child = spawn(process.execPath, [harnessPath, "--scenario", "cancel"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.ok(exit.code === 143 || exit.signal === "SIGTERM");
});
