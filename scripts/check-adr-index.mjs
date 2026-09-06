// Keeps docs/adr/README.md honest: the table must list every decision record in
// docs/adr/ exactly once, in ascending order, and every record's heading must
// carry the number of its file name.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const adrDirectory = join(import.meta.dirname, "..", "docs", "adr");
const indexName = "README.md";

const problems = [];

function recordNumbers() {
  const numbers = [];
  for (const file of readdirSync(adrDirectory).sort()) {
    if (file === indexName || !file.endsWith(".md")) {
      continue;
    }
    const named = /^(\d{4})-[\da-z-]+\.md$/.exec(file);
    if (named === null) {
      problems.push(`${file}: expected the file name NNNN-short-slug.md`);
      continue;
    }
    const number = named[1];
    numbers.push(number);
    const heading = /^# ADR-(\d{4}): \S/m.exec(readFileSync(join(adrDirectory, file), "utf8"));
    if (heading === null) {
      problems.push(`${file}: expected a heading "# ADR-${number}: <decision>"`);
    } else if (heading[1] !== number) {
      problems.push(`${file}: the heading says ADR-${heading[1]}`);
    }
  }
  return numbers;
}

function indexedNumbers() {
  const numbers = [];
  const source = readFileSync(join(adrDirectory, indexName), "utf8");
  for (const line of source.split("\n")) {
    const row = /^\|\s*(\d{4})\s*\|\s*(.*?)\s*\|$/.exec(line);
    if (row === null) {
      continue;
    }
    numbers.push(row[1]);
    if (row[2] === "") {
      problems.push(`${indexName}: the row for ADR-${row[1]} has no decision text`);
    }
  }
  return numbers;
}

const records = recordNumbers();
const indexed = indexedNumbers();

for (const number of new Set(indexed)) {
  const rows = indexed.filter((entry) => entry === number).length;
  if (rows > 1) {
    problems.push(`${indexName}: ADR-${number} is listed ${rows} times`);
  }
}
for (const number of records) {
  if (!indexed.includes(number)) {
    problems.push(`${indexName}: ADR-${number} is missing from the table`);
  }
}
for (const number of indexed) {
  if (!records.includes(number)) {
    problems.push(`${indexName}: ADR-${number} has a row but no file in docs/adr/`);
  }
}
if ([...indexed].sort().join() !== indexed.join()) {
  problems.push(`${indexName}: the table must list the records in ascending order`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`check-adr-index: ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(`check-adr-index: ${records.length} decision records match docs/adr/${indexName}.`);
}
