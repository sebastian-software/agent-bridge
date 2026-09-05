import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "test", "scripts"];
const extensions = new Set([".ts", ".mjs"]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path));
    } else if (extensions.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files;
}

const files = (await Promise.all(roots.map(filesUnder))).flat().sort();
const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (!source.endsWith("\n")) {
    failures.push(`${file}: missing final newline`);
  }
  if (/[^\S\r\n]+$/m.test(source)) {
    failures.push(`${file}: trailing whitespace`);
  }
  if (file.endsWith(".mjs")) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch {
      failures.push(`${file}: Node syntax check failed`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
