import { getOxlintConfig } from "eslint-config-setup";
import { defineConfig, type OxlintConfig } from "oxlint";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- getOxlintConfig() is not yet typed against oxlint's own OxlintConfig
const config = getOxlintConfig({ node: true }) as OxlintConfig;

config.ignorePatterns = [
  "**/dist/**",
  "coverage/**",
  "node_modules/**",
  // Self-contained spike with its own package.json, lockfile and tsconfig.
  "spikes/**",
];

// The suite runs on node:test, not vitest. The shared config turns the vitest
// rules on for every *.test.ts file, where they report on a runner they do not
// describe, so drop them instead of overriding each one.
for (const override of config.overrides ?? []) {
  for (const rule of Object.keys(override.rules ?? {})) {
    if (rule.startsWith("vitest/")) {
      delete override.rules?.[rule];
    }
  }
}

// agent-bridge was linted with Biome's recommended set before it adopted the
// org standards. The rules below fire throughout the existing, reviewed
// implementation; they are parked here so the gate reports real regressions
// today. Re-enabling them one by one, with the refactors they ask for, is
// follow-up work and not part of the tooling migration.
const legacyBaseline: NonNullable<OxlintConfig["rules"]> = {
  // Size and complexity budgets: the broker, the CLI and the store are
  // long-lived state machines that exceed every limit as written.
  complexity: "off",
  "max-depth": "off",
  "max-lines": "off",
  "max-lines-per-function": "off",
  "max-params": "off",
  "max-statements": "off",
  // Style choices that pervade the existing code base.
  "no-empty-function": "off",
  "no-shadow": "off",
  "unicorn/no-array-callback-reference": "off",
  "unicorn/no-await-expression-member": "off",
  // Promise executors that return the result of the call they subscribe to.
  "no-promise-executor-return": "off",
};

// One entry per source root: oxlint resolves overlapping overrides by pattern
// specificity, so a single combined entry loses against the shared config.
config.overrides = [
  ...(config.overrides ?? []),
  { files: ["src/**/*.ts"], rules: { ...legacyBaseline } },
  { files: ["**/test/**/*.ts"], rules: { ...legacyBaseline } },
  { files: ["**/scripts/**/*.mjs"], rules: { ...legacyBaseline } },
];

export default defineConfig(config);
