import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "harness-relay-package-smoke-"));
const packageDirectory = join(temporaryRoot, "package");
const installationDirectory = join(temporaryRoot, "installation");
const emptyBinDirectory = join(temporaryRoot, "empty-bin");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

try {
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(installationDirectory, { recursive: true }),
    mkdir(emptyBinDirectory, { recursive: true }),
  ]);
  run("pnpm", ["pack", "--pack-destination", packageDirectory]);
  const archives = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "packing must produce exactly one installable archive");
  const archivePath = join(packageDirectory, archives[0]);
  run(
    "npm",
    [
      "install",
      "--prefix",
      installationDirectory,
      "--omit=optional",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archivePath,
    ],
    { env: { ...process.env, npm_config_cache: join(temporaryRoot, "npm-cache") } },
  );

  const installedPackage = join(installationDirectory, "node_modules", "harness-relay");
  const piPackage = join(
    installationDirectory,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  await assert.rejects(access(piPackage), { code: "ENOENT" });
  await import(pathToFileURL(join(installedPackage, "dist/src/index.js")).href);

  const cliPath = join(installedPackage, "dist/src/cli.js");
  const cliEnvironment = {
    ...process.env,
    HOME: temporaryRoot,
    PATH: emptyBinDirectory,
  };
  assert.match(run(process.execPath, [cliPath, "help"], { env: cliEnvironment }), /Usage:/);
  assert.match(
    run(process.execPath, [cliPath, "--version"], { env: cliEnvironment }),
    /\d+\.\d+\.\d+/,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = emptyBinDirectory;
  try {
    const claudeModule = await import(
      pathToFileURL(join(installedPackage, "dist/src/adapters/claude.js")).href
    );
    const codexModule = await import(
      pathToFileURL(join(installedPackage, "dist/src/adapters/codex.js")).href
    );
    const [claudeRoutes, codexRoutes] = await Promise.all([
      new claudeModule.ClaudeAdapter().discover(),
      new codexModule.CodexAdapter().discover(),
    ]);
    assert.ok(claudeRoutes.length > 0, "Claude route discovery must remain available");
    assert.ok(codexRoutes.length > 0, "Codex route discovery must remain available");
    assert.ok(claudeRoutes.every((route) => route.readiness === "unavailable"));
    assert.ok(codexRoutes.every((route) => route.readiness === "unavailable"));
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }

  process.stdout.write("Package smoke passed with optional dependencies omitted.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
