import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (typeof packageJson.version !== "string" || packageJson.version === "") {
  throw new Error("package.json must contain a version");
}

// The trailing annotation is what release-please's generic updater looks for:
// it rewrites the version literal on that line when it prepares a release, so
// the committed file already matches package.json on the release pull request
// and CI's `version:sync && git diff --exit-code` step stays green.
const versionSource = `export const PACKAGE_VERSION = ${JSON.stringify(packageJson.version)} as const; // x-release-please-version\n`;
const versionPath = "src/version.ts";
const current = await readFile(versionPath, "utf8");
if (current !== versionSource) {
  await writeFile(versionPath, versionSource, "utf8");
}
