import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { brokerConfigFromValues, DEFAULT_BROKER_CONFIG, loadBrokerConfig } from "../src/config.js";

test("broker config exposes safe defaults and preserves explicit overrides", () => {
  const config = brokerConfigFromValues({ diagnosticMode: true, effectsMaxFiles: 42 });
  assert.equal(config.retentionCompletedDays, DEFAULT_BROKER_CONFIG.retentionCompletedDays);
  assert.equal(config.diagnosticMode, true);
  assert.equal(config.effectsMaxFiles, 42);
  assert.equal(config.sources.diagnosticMode, "default");
  assert.equal(config.configPath.endsWith("agent-bridge/config.json"), true);
});

test("broker config applies CLI over environment over config file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-config-"));
  const path = join(root, "config.json");
  const previousPath = process.env.AGENT_BRIDGE_CONFIG_PATH;
  const previousBytes = process.env.AGENT_BRIDGE_RETENTION_MAX_BYTES;
  try {
    await writeFile(
      path,
      JSON.stringify({ broker: { retention: { maxBytes: 100 }, diagnosticMode: true } }),
      "utf8",
    );
    process.env.AGENT_BRIDGE_CONFIG_PATH = path;
    process.env.AGENT_BRIDGE_RETENTION_MAX_BYTES = "200";
    const config = await loadBrokerConfig({ retentionMaxBytes: 300 });
    assert.equal(config.retentionMaxBytes, 300);
    assert.equal(config.sources.retentionMaxBytes, "cli");
    assert.equal(config.diagnosticMode, true);
    assert.equal(config.sources.diagnosticMode, "config");
  } finally {
    if (previousPath === undefined) delete process.env.AGENT_BRIDGE_CONFIG_PATH;
    else process.env.AGENT_BRIDGE_CONFIG_PATH = previousPath;
    if (previousBytes === undefined) delete process.env.AGENT_BRIDGE_RETENTION_MAX_BYTES;
    else process.env.AGENT_BRIDGE_RETENTION_MAX_BYTES = previousBytes;
    await rm(root, { recursive: true, force: true });
  }
});
