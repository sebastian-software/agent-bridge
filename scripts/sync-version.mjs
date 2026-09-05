import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (typeof packageJson.version !== "string" || packageJson.version === "") {
  throw new Error("package.json must contain a version");
}

const versionSource = `export const PACKAGE_VERSION = ${JSON.stringify(packageJson.version)} as const;\n`;
const versionPath = "src/version.ts";
const current = await readFile(versionPath, "utf8");
if (current !== versionSource) {
  await writeFile(versionPath, versionSource, "utf8");
}
