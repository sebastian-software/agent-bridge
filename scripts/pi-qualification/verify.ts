import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate environment before importing Pi: no host credentials, plugins, or settings.
const root = await mkdtemp(join(tmpdir(), "relay-pi-qualification-"));
try {
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "unexpected-provider",
      defaultModel: "unexpected-model",
      retry: { enabled: true },
    }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("scenarios.ts", import.meta.url)), root],
    {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        TMPDIR: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
      stdio: "inherit",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, "Pi qualification child must finish successfully within 45 seconds");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
