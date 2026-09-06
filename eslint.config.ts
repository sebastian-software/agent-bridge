import { getEslintConfig } from "eslint-config-setup";

const config = await getEslintConfig({ node: true, oxlint: true });

config.unshift({
  ignores: [
    "**/dist/**",
    "coverage/**",
    "node_modules/**",
    "pnpm-lock.yaml",
    "**/*.json",
    "**/*.md",
    // Self-contained spike with its own package.json, lockfile and tsconfig.
    "spikes/**",
    // Plain .mjs developer scripts live outside the TypeScript project, so the
    // type-aware rules cannot resolve them; oxlint still covers them.
    "scripts/**",
  ],
});

// agent-bridge was linted with Biome's recommended set before it adopted the
// org standards. The rules below fire throughout the existing, reviewed
// implementation; they are parked here so the gate reports real regressions
// today. Re-enabling them one by one, with the refactors they ask for, is
// follow-up work and not part of the tooling migration.
config.push({
  files: ["src/**/*.ts", "test/**/*.ts"],
  rules: {
    // Size and complexity budgets: the broker, the CLI and the store are
    // long-lived state machines that exceed every limit as written.
    complexity: "off",
    "max-depth": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-params": "off",
    "max-statements": "off",
    "sonarjs/cognitive-complexity": "off",
    // Harness stdout, config files and persisted records arrive as unknown
    // JSON and are narrowed with assertions and defensive checks.
    "@typescript-eslint/no-base-to-string": "off",
    "@typescript-eslint/no-unnecessary-condition": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-type-assertion": "off",
    // Async methods that satisfy an adapter contract without awaiting, and
    // async listeners handed to Node's event emitters.
    "@typescript-eslint/require-await": "off",
    "@typescript-eslint/strict-void-return": "off",
    "no-promise-executor-return": "off",
    // Running a harness in a caller-chosen working directory is what the
    // bridge does; every path it touches is a runtime value by design.
    "security/detect-non-literal-fs-filename": "off",
  },
});

// package.json exposes the compiled dist/src/cli.js as the `agent-bridge` bin.
// Without this mapping node/hashbang sees src/cli.ts as a plain module and its
// autofix strips the shebang (#124); with it the rule requires the shebang on
// exactly the sources that compile to a bin entry.
config.push({
  files: ["src/**/*.ts"],
  rules: {
    "node/hashbang": [
      "error",
      { convertPath: { "src/**/*.ts": ["^src/(.+?)\\.ts$", "dist/src/$1.js"] } },
    ],
  },
});

config.push({
  files: ["test/**/*.ts"],
  rules: {
    // The suite runs on node:test: test() returns a promise nobody awaits,
    // fixtures assert on deliberately loose values, and the sequential env
    // setup is not subject to the races these rules model.
    "@typescript-eslint/no-floating-promises": "off",
    "@typescript-eslint/strict-boolean-expressions": "off",
    "require-atomic-updates": "off",
  },
});

export default config;
