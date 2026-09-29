import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import type { PiRuntimeConfiguration } from "../src/adapters/pi-supervisor.js";
import type { AdapterEvent, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import type { AdapterConnectionContext } from "../src/connections.js";
import type { ResolvedRoute, StartInvocationRequest } from "../src/contract.js";

import {
  piContinuationBinding,
  type PiContinuationContext,
  PiContinuationStore,
  type PiNativeSessionSnapshot,
} from "../src/adapters/pi-continuation.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { BridgeError } from "../src/errors.js";

type FixtureRequest = {
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
};
type FixtureReply = (response: ServerResponse, request: FixtureRequest) => void;
type PiFixture = {
  readonly modelFiles: PiRuntimeConfiguration["modelFiles"];
  readonly requests: FixtureRequest[];
  readonly errors: Error[];
  setReplies: (replies: readonly FixtureReply[]) => void;
  close: () => Promise<void>;
};

async function startPiFixture(root: string): Promise<PiFixture> {
  const agentDirectory = join(root, "pi-agent");
  await mkdir(agentDirectory, { recursive: true });
  const requests: FixtureRequest[] = [];
  const errors: Error[] = [];
  let replies: FixtureReply[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const parsed = JSON.parse(body) as FixtureRequest;
      requests.push(parsed);
      const reply = replies.shift();
      assert.ok(reply, "unexpected fixture model request");
      reply(response, parsed);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500).end("fixture failed");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const modelFiles = {
    authPath: join(agentDirectory, "auth.json"),
    modelsPath: join(agentDirectory, "models.json"),
    modelsStorePath: join(agentDirectory, "models-store.json"),
  };
  await writeFile(modelFiles.authPath, "{}");
  await writeFile(
    modelFiles.modelsPath,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-not-secret",
          models: [{ id: "fixture-model", contextWindow: 32_768, maxTokens: 20_000 }],
        },
      },
    }),
  );
  return {
    modelFiles,
    requests,
    errors,
    setReplies(next) {
      replies = [...next];
    },
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function textReply(text: string): FixtureReply {
  return (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
      },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", ...chunk })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  };
}

function rateLimitReply(response: ServerResponse): void {
  response
    .writeHead(429, { "content-type": "application/json" })
    .end(JSON.stringify({ error: { message: "fixture rate limit" } }));
}

function adapterRunContext(
  root: string,
  prompt: string,
  invocationId: string,
  continuationHandle?: AdapterRunResult["continuationHandle"],
): { readonly context: AdapterRunContext; readonly events: AdapterEvent[] } {
  const requestValue = request(join(root, "workspace"), prompt);
  const events: AdapterEvent[] = [];
  return {
    events,
    context: {
      invocationId,
      request: requestValue,
      route: route(),
      ...(continuationHandle === undefined ? {} : { continuationHandle }),
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
      terminationGraceMs: 1000,
    },
  };
}

function request(root: string, input = "first prompt"): StartInvocationRequest {
  return {
    selector: {
      provider: "fixture",
      model: "fixture-model",
      via: "pi",
      requiredCapabilities: ["core.input.text", "core.output.text"],
    },
    input: [{ type: "text", text: input }],
    workingDirectory: root,
    interactionStrategy: "unattended",
    requestedPolicy: {
      minimumAssurance: "none",
      filesystem: "inherit",
      commands: "allow",
      network: "allow",
    },
    idempotencyKey: input,
  };
}

function route(): ResolvedRoute {
  return {
    routeId: "fixture:fixture-model",
    adapter: "pi",
    harnessVersion: "0.87.1",
    authenticationMode: "none",
    provider: "fixture",
    model: "fixture-model",
    via: "pi",
    capabilities: ["core.input.text", "core.output.text", "continuation"],
    qualification: [],
  };
}

async function fixture(root: string): Promise<{
  readonly configuration: PiRuntimeConfiguration;
  readonly context: PiContinuationContext;
}> {
  const agentDirectory = join(root, "pi-agent");
  const workingDirectory = join(root, "workspace");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  const configuration: PiRuntimeConfiguration = {
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: {
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: join(agentDirectory, "models.json"),
      modelsStorePath: join(agentDirectory, "models-store.json"),
    },
    tools: ["read"],
  };
  await writeFile(configuration.modelFiles.authPath, "{}");
  await writeFile(configuration.modelFiles.modelsPath, JSON.stringify({ providers: {} }));
  const connection: AdapterConnectionContext = {
    id: "local-pi",
    harness: "pi",
    nativeContextRef: agentDirectory,
    revision: "connection-revision-1",
    purpose: "fixture account",
  };
  return {
    configuration,
    context: { request: request(workingDirectory), route: route(), connection },
  };
}

function snapshot(directory: string, cwd: string): PiNativeSessionSnapshot {
  return {
    sessionFile: join(directory, "session.jsonl"),
    sessionId: "pi-session-id",
    cwd: resolve(cwd),
    terminalLeafId: "terminal-leaf-id",
  };
}

test("Pi continuation binding follows route, account, policy, and model config but allows a new prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-binding-"));
  try {
    const { configuration, context } = await fixture(root);
    const original = await piContinuationBinding(context, configuration);
    const nextPrompt: PiContinuationContext = {
      ...context,
      request: {
        ...context.request,
        input: [{ type: "text", text: "follow-up" }],
        idempotencyKey: "next",
      },
    };
    assert.equal(await piContinuationBinding(nextPrompt, configuration), original);

    const changedRoute = {
      ...context,
      route: { ...context.route, routeId: "fixture:other-model" },
    };
    assert.notEqual(await piContinuationBinding(changedRoute, configuration), original);

    const originalConnection = context.connection;
    assert.ok(originalConnection);
    const changedAccount: PiContinuationContext = {
      ...context,
      connection: { ...originalConnection, revision: "connection-revision-2" },
    };
    assert.notEqual(await piContinuationBinding(changedAccount, configuration), original);

    await writeFile(
      configuration.modelFiles.modelsPath,
      JSON.stringify({ providers: { fixture: {} } }),
    );
    assert.notEqual(await piContinuationBinding(context, configuration), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi continuation binding rejects a missing or retargeted working-directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-working-directory-"));
  try {
    const { configuration, context } = await fixture(root);
    const firstDirectory = join(root, "workspace-first");
    const secondDirectory = join(root, "workspace-second");
    const link = join(root, "workspace-link");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    await symlink(firstDirectory, link, "dir");
    const linkedContext: PiContinuationContext = {
      ...context,
      request: { ...context.request, workingDirectory: link },
    };
    const original = await piContinuationBinding(linkedContext, configuration, {
      requireWorkingDirectory: true,
    });

    await unlink(link);
    await symlink(secondDirectory, link, "dir");
    assert.notEqual(
      await piContinuationBinding(linkedContext, configuration, {
        requireWorkingDirectory: true,
      }),
      original,
      "a symlink that now selects another physical workspace must invalidate continuation",
    );

    await unlink(link);
    await assert.rejects(
      piContinuationBinding(linkedContext, configuration, { requireWorkingDirectory: true }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi continuation handles expose no paths and require their retained session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-session-store-"));
  const store = new PiContinuationStore({ baseDirectory: root });
  try {
    const { configuration, context } = await fixture(root);
    const binding = await piContinuationBinding(context, configuration);
    const directory = await store.createSessionDirectory();
    const checkpoint = snapshot(directory, context.request.workingDirectory);
    await writeFile(checkpoint.sessionFile, '{"type":"session"}\n');
    const handle = await store.retain(directory, checkpoint, binding);

    assert.equal(handle.reference.includes(directory), false);
    assert.equal(JSON.stringify(handle).includes(checkpoint.sessionFile), false);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await store.resume(handle, binding), { directory, snapshot: checkpoint });

    await assert.rejects(
      store.resume(handle, `${binding}-changed`),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    await rm(checkpoint.sessionFile);
    await assert.rejects(
      store.resume(handle, binding),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    await assert.rejects(readFile(checkpoint.sessionFile), { code: "ENOENT" });
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing the Pi continuation store removes its private session root", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-dispose-"));
  const store = new PiContinuationStore({ baseDirectory: root });
  try {
    const { configuration, context } = await fixture(root);
    const binding = await piContinuationBinding(context, configuration);
    const directory = await store.createSessionDirectory();
    const checkpoint = snapshot(directory, context.request.workingDirectory);
    await writeFile(checkpoint.sessionFile, '{"type":"session"}\n');
    await store.retain(directory, checkpoint, binding);
    const privateRoot = dirname(directory);

    await store.dispose();

    await assert.rejects(stat(privateRoot), { code: "ENOENT" });
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi continuation handles expire and a fresh adapter store cannot reopen a lost handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-expiry-"));
  const store = new PiContinuationStore({ baseDirectory: root, ttlMs: 1 });
  try {
    const { configuration, context } = await fixture(root);
    const binding = await piContinuationBinding(context, configuration);
    const directory = await store.createSessionDirectory();
    const checkpoint = snapshot(directory, context.request.workingDirectory);
    await writeFile(checkpoint.sessionFile, '{"type":"session"}\n');
    const handle = await store.retain(directory, checkpoint, binding);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await assert.rejects(
      store.resume(handle, binding),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_expired",
    );

    const restartedStore = new PiContinuationStore({ baseDirectory: root });
    await assert.rejects(
      restartedStore.resume(
        { reference: handle.reference, expiresAt: "2999-01-01T00:00:00.000Z" },
        binding,
      ),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    await restartedStore.dispose();
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi resumes a settled SDK session into a new file and failed branches leave the predecessor usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-branch-"));
  const fixture = await startPiFixture(root);
  const store = new PiContinuationStore({ baseDirectory: root });
  const configuration: PiRuntimeConfiguration = {
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: [],
  };
  const adapter = new PiAdapter(configuration, { continuationStore: store });
  await mkdir(join(root, "workspace"), { recursive: true });
  try {
    fixture.setReplies([textReply("initial answer"), rateLimitReply, textReply("later answer")]);
    assert.deepEqual(await adapter.discover(), []);

    const firstContext = adapterRunContext(root, "initial prompt", "pi-continuation-first").context;
    const firstResult = await adapter.run(firstContext);
    assert.ok(firstResult.continuationHandle);
    assert.equal(JSON.stringify(firstResult.continuationHandle).includes("sessionFile"), false);
    const binding = await piContinuationBinding(firstContext, configuration);
    const predecessor = await store.resume(firstResult.continuationHandle, binding);
    const predecessorBytes = await readFile(predecessor.snapshot.sessionFile);

    const sessionLines = predecessorBytes.toString("utf8").trimEnd().split(/\r?\n/u);
    const changedHeader = JSON.parse(sessionLines[0] ?? "{}") as Record<string, unknown>;
    changedHeader.id = "mismatched-session-id";
    await writeFile(
      predecessor.snapshot.sessionFile,
      `${[JSON.stringify(changedHeader), ...sessionLines.slice(1)].join("\n")}\n`,
    );
    const changedIdContext = adapterRunContext(
      root,
      "must reject a changed native session id",
      "pi-continuation-mismatched-id",
      firstResult.continuationHandle,
    ).context;
    await assert.rejects(
      adapter.run(changedIdContext),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    assert.equal(fixture.requests.length, 1, "checkpoint mismatch must not reach the model");
    await writeFile(predecessor.snapshot.sessionFile, predecessorBytes);

    const changedLeaf = JSON.parse(sessionLines.at(-1) ?? "{}") as Record<string, unknown>;
    changedLeaf.id = `${String(changedLeaf.id)}-mismatched`;
    await writeFile(
      predecessor.snapshot.sessionFile,
      `${[...sessionLines.slice(0, -1), JSON.stringify(changedLeaf)].join("\n")}\n`,
    );
    const changedLeafContext = adapterRunContext(
      root,
      "must reject a changed terminal leaf",
      "pi-continuation-mismatched-leaf",
      firstResult.continuationHandle,
    ).context;
    await assert.rejects(
      adapter.run(changedLeafContext),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "continuation_route_changed",
    );
    assert.equal(fixture.requests.length, 1, "leaf mismatch must not reach the model");
    await writeFile(predecessor.snapshot.sessionFile, predecessorBytes);
    assert.deepEqual(await readFile(predecessor.snapshot.sessionFile), predecessorBytes);

    const failedContext = adapterRunContext(
      root,
      "failed branch prompt",
      "pi-continuation-failed",
      firstResult.continuationHandle,
    ).context;
    await assert.rejects(
      adapter.run(failedContext),
      (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
    );
    assert.deepEqual(await readFile(predecessor.snapshot.sessionFile), predecessorBytes);

    const nextContext = adapterRunContext(
      root,
      "successful branch prompt",
      "pi-continuation-successful",
      firstResult.continuationHandle,
    ).context;
    const nextResult = await adapter.run(nextContext);
    assert.ok(nextResult.continuationHandle);
    assert.notEqual(
      nextResult.continuationHandle.reference,
      firstResult.continuationHandle.reference,
    );
    const nextBinding = await piContinuationBinding(nextContext, configuration);
    const continued = await store.resume(nextResult.continuationHandle, nextBinding);
    assert.notEqual(continued.snapshot.sessionFile, predecessor.snapshot.sessionFile);
    assert.notEqual(continued.snapshot.sessionId, predecessor.snapshot.sessionId);
    assert.deepEqual(await readFile(predecessor.snapshot.sessionFile), predecessorBytes);

    const thirdRequestMessages = JSON.stringify(fixture.requests[2]?.messages);
    assert.ok(thirdRequestMessages.includes("initial prompt"));
    assert.ok(thirdRequestMessages.includes("initial answer"));
    assert.ok(thirdRequestMessages.includes("successful branch prompt"));
    assert.equal(thirdRequestMessages.includes("failed branch prompt"), false);

    await rm(predecessor.snapshot.sessionFile);
    const unavailableContext = adapterRunContext(
      root,
      "must not start a fresh session",
      "pi-continuation-missing-file",
      firstResult.continuationHandle,
    ).context;
    await assert.rejects(
      adapter.run(unavailableContext),
      (error: unknown) => error instanceof BridgeError && error.code === "continuation_unavailable",
    );
    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await adapter.dispose();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
