// Ported from sebastian-software/ferriki (same organization, same rule).
//
// Contract test for the workflow pin check. Every case here is a shape that
// previously slipped through a naive line scan, so the checker must keep
// rejecting it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const checker = join(import.meta.dirname, "check-workflow-pins.mjs");
const pinned = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

const cases = [
  {
    name: "block form with a full SHA and a version comment",
    workflow: `jobs:\n  a:\n    steps:\n      - uses: ${pinned} # v7\n`,
    status: 0,
  },
  {
    name: "flow mapping form",
    workflow: `jobs:\n  a:\n    steps:\n      - { uses: actions/checkout@v5, with: { fetch-depth: 0 } }\n`,
    status: 1,
    expect: "is not pinned",
  },
  {
    name: "quoted key form",
    workflow: `jobs:\n  a:\n    steps:\n      - "uses": actions/checkout@v5\n`,
    status: 1,
    expect: "is not pinned",
  },
  {
    name: "floating tag",
    workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n`,
    status: 1,
    expect: "is not pinned",
  },
  {
    name: "SHA without a version comment",
    workflow: `jobs:\n  a:\n    steps:\n      - uses: ${pinned}\n`,
    status: 1,
    expect: "is missing the trailing",
  },
  {
    name: "unreadable uses key",
    workflow: `jobs:\n  a:\n    steps:\n      - uses:\n          ${pinned}\n`,
    status: 1,
    expect: "could not be read",
  },
  {
    name: "local and container references are exempt",
    workflow:
      "jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup\n      - uses: docker://alpine:3\n",
    status: 0,
  },
];

const root = await mkdtemp(join(tmpdir(), "agent-bridge-pin-check-"));
try {
  for (const testCase of cases) {
    const directory = await mkdtemp(join(root, "workflows-"));
    await writeFile(join(directory, "ci.yml"), testCase.workflow);
    const result = spawnSync(process.execPath, [checker, directory], { encoding: "utf8" });
    assert.equal(
      result.status,
      testCase.status,
      `${testCase.name}: expected exit ${testCase.status}, got ${result.status}\n${result.stdout}${result.stderr}`,
    );
    if (testCase.expect)
      assert.match(
        result.stderr,
        new RegExp(testCase.expect),
        `${testCase.name}: unexpected output\n${result.stderr}`,
      );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`Workflow pin check contract verified (${cases.length} cases)`);
