import assert from "node:assert/strict";
import test from "node:test";

import { parseStartInvocationRequest } from "../src/contract.js";
import { BridgeError } from "../src/errors.js";

test("start request parsing applies honest defaults", () => {
  const request = parseStartInvocationRequest({
    selector: {
      provider: "agent-bridge",
      model: "fake-echo",
    },
    input: [{ type: "text", text: "hello" }],
    workingDirectory: "/tmp",
  });

  assert.equal(request.interactionStrategy, "orchestrator");
  assert.equal(request.requestedPolicy.minimumAssurance, "none");
  assert.deepEqual(request.selector.requiredCapabilities, []);
});

test("start request parsing rejects invalid multimodal boundaries", () => {
  assert.throws(
    () => parseStartInvocationRequest({
      selector: { provider: "agent-bridge", model: "fake-echo" },
      input: [{ type: "file", path: "report.txt" }],
      workingDirectory: "/tmp",
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_request",
  );
});

test("start request parsing bounds timeout values", () => {
  assert.throws(
    () => parseStartInvocationRequest({
      selector: { provider: "agent-bridge", model: "fake-echo" },
      input: [{ type: "text", text: "hello" }],
      workingDirectory: "/tmp",
      timeoutMs: 0,
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_request",
  );
});

test("content references allow an empty file with byteSize zero", () => {
  const request = parseStartInvocationRequest({
    selector: { provider: "agent-bridge", model: "fake-echo" },
    input: [{
      type: "file",
      path: "/tmp/empty.txt",
      mimeType: "text/plain",
      byteSize: 0,
    }],
    workingDirectory: "/tmp",
  });

  assert.equal(request.input[0]?.type, "file");
  assert.equal(request.input[0]?.byteSize, 0);
});
