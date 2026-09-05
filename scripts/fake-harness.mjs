#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const scenario = option("--scenario", "success");
const text = option("--text", "fake harness output");
const cwd = option("--cwd", process.cwd());
const model = option("--model", "fake-echo");

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

if (!["success", "failure", "timeout", "malformed", "truncated", "effects", "cancel", "identity-absent", "slow"].includes(scenario)) {
  console.error(`unknown scenario: ${scenario}`);
  process.exitCode = 2;
} else {
  emit({ type: "init", provider: "agent-bridge", model: scenario === "identity-absent" ? undefined : model, harnessVersion: "1.0.0" });
  emit({ type: "progress", step: 1, total: scenario === "slow" ? 8 : 2 });

  if (scenario === "malformed") {
    process.stdout.write("this is not json\n");
    process.exitCode = 0;
  } else if (scenario === "truncated") {
    process.stdout.write(JSON.stringify({ type: "assistant", text }));
    process.exitCode = 0;
  } else if (scenario === "failure") {
    emit({ type: "diagnostic", message: "fake harness failure" });
    process.exitCode = 7;
  } else if (scenario === "effects") {
    await mkdir(cwd, { recursive: true });
    const created = join(cwd, "fake-created.txt");
    const renamed = join(cwd, "fake-renamed.txt");
    await writeFile(created, text, "utf8");
    await rename(created, renamed);
    emit({ type: "effect", path: renamed, kind: "renamed" });
    emit({ type: "assistant", text });
    emit({ type: "result", status: "completed", usage: { inputTokens: 1, outputTokens: 1 } });
  } else if (scenario === "timeout" || scenario === "cancel") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if (scenario === "slow") {
    for (let step = 2; step <= 8; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      emit({ type: "progress", step, total: 8 });
    }
    emit({ type: "assistant", text });
    emit({ type: "result", status: "completed", usage: { inputTokens: 1, outputTokens: 1 } });
  } else {
    emit({ type: "assistant", text });
    emit({ type: "result", status: "completed", usage: { inputTokens: 1, outputTokens: 1 } });
  }
}
