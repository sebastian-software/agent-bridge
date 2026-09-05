import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { SCHEMA_DEFINITIONS, describeContract } from "../src/operations.js";
import { SCHEMA_VERSION } from "../src/contract.js";

test("published schemas are valid JSON documents with stable identities", async () => {
  for (const definition of SCHEMA_DEFINITIONS) {
    const text = await readFile(join(process.cwd(), definition.path), "utf8");
    const schema = JSON.parse(text) as Record<string, unknown>;
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, `agent-bridge://schemas/${definition.path.split("/").at(-1)}`);
    assert.equal(schema.type, "object");
  }
});

test("describe contract advertises the same schema version and paths", () => {
  const description = describeContract();
  assert.equal(description.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(description.schemas, SCHEMA_DEFINITIONS);
});
