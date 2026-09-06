// Ported from sebastian-software/ferriki (same organization, same rule).
//
// Every third-party action in .github/workflows must be pinned to a full
// 40-character commit SHA with the human-readable version in a trailing
// comment, so a moved tag cannot change what CI executes. Local (`./`) and
// container (`docker://`) references are exempt because they are not tags.
//
// The scan is line-based on purpose: this runs in a job that only checks the
// repository out, with no dependency install, so it cannot pull in a YAML
// parser. To keep that safe it recognizes every shape a `uses` key can take —
// block (`- uses: x`), flow (`- { uses: x }`) and quoted (`"uses": x`) — and
// fails loudly on any `uses` key it cannot classify rather than skipping it.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = join(import.meta.dirname, "..");
const workflowDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(repoRoot, ".github", "workflows");

const USES_KEY = /(?:^|[\s{,])(?:uses|"uses"|'uses')\s*:/;
const BLOCK_USES = /^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:\s*(?<ref>[^\s#]+)\s*(?<rest>.*)$/;
const FLOW_USES = /(?:^|[\s{,])(?:uses|"uses"|'uses')\s*:\s*(?<ref>[^\s,}]+)(?<rest>[^,}]*)/g;
const LINE_COMMENT = /(?:^|\s)(?<comment>#.*)$/;
const PINNED = /^[^\s@]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*\S/;

function unquote(value) {
  return value.replaceAll(/^['"]|['"]$/g, "");
}

// Returns every `uses` value on the line, or null when the line has a `uses`
// key in a shape this scanner does not understand.
function usesReferences(line) {
  const block = BLOCK_USES.exec(line);
  if (block) return [{ ref: unquote(block.groups.ref), rest: block.groups.rest }];

  if (line.includes("{")) {
    // A flow mapping ends before its version comment: `- { uses: x } # v7`
    // puts the comment outside the braces, so the per-reference `rest` stops
    // at the closing brace and never sees it. YAML comments run to the end of
    // the line, so the line's own comment documents every reference on it -
    // append it to each. The inside-the-braces shape a strict YAML parser
    // rejects keeps working through `rest`.
    const comment = LINE_COMMENT.exec(line)?.groups.comment ?? "";
    const flow = [...line.matchAll(FLOW_USES)].map((match) => ({
      ref: unquote(match.groups.ref),
      rest: `${match.groups.rest} ${comment}`,
    }));
    if (flow.length > 0) return flow;
  }

  return null;
}

const files = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/.test(name)).sort();
if (files.length === 0) {
  console.error(`No workflow files found in ${workflowDir}`);
  process.exit(2);
}

const problems = [];
let checked = 0;

for (const file of files) {
  const lines = (await readFile(join(workflowDir, file), "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    if (!USES_KEY.test(line)) continue;

    const location = `${file}:${index + 1}`;
    const references = usesReferences(line);
    if (references === null) {
      problems.push(`${location}: a "uses" key is present but could not be read: ${line.trim()}`);
      continue;
    }

    for (const { ref, rest } of references) {
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      checked += 1;
      if (!PINNED.test(ref))
        problems.push(`${location}: "${ref}" is not pinned to a full 40-character commit SHA`);
      else if (!VERSION_COMMENT.test(rest))
        problems.push(`${location}: "${ref}" is missing the trailing "# <version>" comment`);
    }
  }
}

if (problems.length > 0) {
  console.error("Workflow action pins are not compliant:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `Workflow action pins verified (${checked} references in ${files.length} workflow files)`,
);
