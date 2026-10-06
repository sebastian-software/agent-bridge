import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AdapterEvent, AdapterRunResult } from "../src/adapters/types.js";
import type { StartInvocationRequest } from "../src/contract.js";

import { LocalPiAdapter } from "../src/adapters/local-pi.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { BridgeError } from "../src/errors.js";
import { piRuntimeAvailability } from "../src/local-runtimes.js";

type OllamaState = { contextWindow: number; supportsTools: boolean; showRequests: number };
type Endpoint = { url: string; state: OllamaState };

function jsonResponse(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function endpoint(context: TestContext, digest: string): Promise<Endpoint> {
  const errors: unknown[] = [];
  const state: OllamaState = { contextWindow: 16_384, supportsTools: true, showRequests: 0 };
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(async () => handle(request, response))
      .catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end();
      });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/api/version") {
      jsonResponse(response, { version: "0.34.4" });
      return;
    }
    if (request.url === "/api/tags") {
      jsonResponse(response, {
        models: [{ name: "qwen3:4b", model: "qwen3:4b", digest }],
      });
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/show");
    state.showRequests += 1;
    let body = "";
    for await (const chunk of request) body += String(chunk);
    assert.deepEqual(JSON.parse(body) as unknown, { model: "qwen3:4b" });
    jsonResponse(response, {
      model_info: { "qwen3.context_length": state.contextWindow },
      capabilities: ["completion", ...(state.supportsTools ? ["tools"] : [])],
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    assert.deepEqual(errors, []);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, state };
}

function streamReply(
  response: ServerResponse,
  delta: Readonly<Record<string, unknown>>,
  finishReason: string,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
    },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk", model: "qwen3:4b", ...chunk })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

type ShowPause = { readonly started: Promise<void>; readonly release: () => void };
type CodingAgentEndpoint = {
  readonly url: string;
  readonly requests: ReadonlyArray<Record<string, unknown>>;
  readonly errors: readonly Error[];
  readonly pauseNextShow: () => ShowPause;
};

type CodingAgentEndpointOptions = {
  readonly toolCommand?: string;
  readonly finalResponse?: string;
  readonly followupReply?: (response: ServerResponse, request: Record<string, unknown>) => void;
};

async function codingAgentEndpoint(
  context: TestContext,
  digest: string,
  options: CodingAgentEndpointOptions = {},
): Promise<CodingAgentEndpoint> {
  const requests: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  let showPause:
    | {
        readonly started: () => void;
        readonly waiting: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/api/version") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ version: "0.34.4" }));
        return;
      }
      if (request.url === "/api/tags") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ models: [{ name: "qwen3:4b", model: "qwen3:4b", digest }] }));
        return;
      }
      if (request.url === "/api/show") {
        for await (const _chunk of request) {
          // Drain discovery request bodies without retaining them.
        }
        const pendingPause = showPause;
        if (pendingPause !== undefined) {
          showPause = undefined;
          pendingPause.started();
          await pendingPause.waiting;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            model_info: { "qwen3.context_length": 8192 },
            capabilities: ["completion", "tools"],
          }),
        );
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (requests.length === 1) {
        streamReply(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "local-bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: options.toolCommand ?? "printf local-pi-ok > generated.txt",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
        return;
      }
      if (options.followupReply !== undefined) {
        options.followupReply(response, parsed);
        return;
      }
      streamReply(
        response,
        {
          content:
            requests.length === 2
              ? (options.finalResponse ?? "Created generated.txt.")
              : "Continued with qwen3:4b.",
        },
        "stop",
      );
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500).end("fixture failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    assert.deepEqual(errors, []);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    pauseNextShow() {
      let start!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      showPause = { started: start, waiting, release };
      return { started, release };
    },
  };
}

function localRequest(workingDirectory: string): StartInvocationRequest {
  return {
    selector: {
      provider: "unknown",
      model: "qwen3:4b",
      via: "pi",
      requiredCapabilities: [
        "core.input.text",
        "core.output.text",
        "core.tools",
        "core.streaming.events",
        "continuation",
      ],
    },
    input: [{ type: "text", text: "Create generated.txt with the requested content." }],
    workingDirectory,
    interactionStrategy: "unattended",
    requestedPolicy: {
      minimumAssurance: "none",
      filesystem: "inherit",
      commands: "allow",
      network: "allow",
    },
  };
}

async function waitForFile(path: string, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(10_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(`Timed out waiting for ${description}.`);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

test("local Pi aliases preserve runtime identity and runtimeId disambiguates duplicate models", async (context) => {
  const first = await endpoint(context, "a".repeat(64));
  const second = await endpoint(context, "b".repeat(64));
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-routing-"));
  const configPath = join(root, "config.json");
  const connectionsPath = join(root, "connections.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [
        { id: "ollama-a", kind: "ollama", endpoint: first.url },
        { id: "ollama-b", kind: "ollama", endpoint: second.url },
      ],
      adapters: {
        pi: {
          aliases: { quick: "qwen3:4b" },
          models: { fabricated: { nativeModel: "qwen3:4b" } },
        },
      },
    }),
    "utf8",
  );
  context.after(async () => rm(root, { recursive: true, force: true }));

  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], {
    catalogPath: configPath,
    connectionsPath,
  });
  context.after(async () => registry.dispose());

  const routes = await registry.discover();
  assert.equal(routes.length, 4);
  assert.equal(
    routes.some((route) => route.model === "fabricated"),
    false,
  );
  const aliases = routes.filter((route) => route.model === "quick");
  assert.deepEqual(
    aliases
      .map((route) => route.runtimeId)
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["ollama-a", "ollama-b"],
  );
  assert.equal(new Set(aliases.map((route) => route.routeId)).size, 2);
  assert.equal(new Set(aliases.map((route) => route.modelDigest)).size, 2);
  for (const route of aliases) {
    assert.equal(route.readiness, "ready");
    assert.ok(route.capabilities.includes("steering"));
    assert.equal(route.provider, "unknown");
    assert.equal(route.modelVendorEvidence, "unverified");
    assert.equal(route.nativeModel, "qwen3:4b");
    assert.ok(route.runtimeRevision);
    assert.equal(route.inferenceServer, "ollama");
  }

  const request = {
    selector: {
      provider: "unknown",
      model: "quick",
      via: "pi",
      requiredCapabilities: ["core.tools"],
    },
    input: [{ type: "text" as const, text: "hello" }],
    workingDirectory: root,
    interactionStrategy: "unattended" as const,
    requestedPolicy: { minimumAssurance: "none" as const },
  };
  await assert.rejects(
    registry.resolve(request),
    (error: unknown) => error instanceof BridgeError && error.code === "route_ambiguous",
  );
  const resolved = await registry.resolve({
    ...request,
    selector: { ...request.selector, runtimeId: "ollama-b" },
  });
  assert.equal(resolved.route.runtimeId, "ollama-b");
  assert.equal(resolved.route.modelDigest, "b".repeat(64));

  const staleResolved = await registry.resolve({
    ...request,
    selector: { ...request.selector, runtimeId: "ollama-a" },
  });
  first.state.contextWindow += 1024;
  await registry.discover({ refresh: true });
  const requestsBeforeStaleRun = first.state.showRequests;
  await assert.rejects(
    adapter.run({
      invocationId: "stale-model-snapshot",
      request: { ...request, selector: { ...request.selector, runtimeId: "ollama-a" } },
      route: staleResolved.route,
      signal: new AbortController().signal,
      async emit() {},
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "route_unavailable",
  );
  assert.equal(first.state.showRequests, requestsBeforeStaleRun);

  const oldRevision = aliases.find((route) => route.runtimeId === "ollama-a")?.runtimeRevision;
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [
        { id: "ollama-a", kind: "ollama", endpoint: second.url },
        { id: "ollama-b", kind: "ollama", endpoint: second.url },
      ],
      adapters: {
        pi: {
          aliases: { fast: "qwen3:4b" },
          models: { fabricated: { nativeModel: "qwen3:4b" } },
        },
      },
    }),
    "utf8",
  );
  const refreshed = await registry.discover();
  assert.equal(
    refreshed.some((route) => route.model === "quick"),
    false,
  );
  assert.equal(refreshed.filter((route) => route.model === "fast").length, 2);
  assert.notEqual(
    refreshed.find((route) => route.model === "fast" && route.runtimeId === "ollama-a")
      ?.runtimeRevision,
    oldRevision,
  );
});

test("an Ollama cloud route reports remote inference and fails preflight after sign-out", async (context) => {
  const state = { signedIn: true };
  const server = createServer((request, response) => {
    if (request.url === "/api/version") {
      jsonResponse(response, { version: "0.34.4" });
      return;
    }
    if (request.url === "/api/tags") {
      jsonResponse(response, {
        models: [
          {
            name: "glm-5.3:cloud",
            model: "glm-5.3:cloud",
            remote_model: "glm-5.3",
            remote_host: "https://ollama.com",
            digest: "c".repeat(64),
          },
        ],
      });
      return;
    }
    if (request.url === "/api/me") {
      response.writeHead(state.signedIn ? 200 : 401).end("{}");
      return;
    }
    jsonResponse(response, {
      capabilities: ["completion", "thinking", "tools"],
      model_info: { "glm_dsa_moe.context_length": 1_048_576 },
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-cloud-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [
        { id: "ollama", kind: "ollama", endpoint: `http://127.0.0.1:${address.port}` },
      ],
    }),
    "utf8",
  );
  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], {
    catalogPath: configPath,
    connectionsPath: join(root, "connections.json"),
  });
  context.after(async () => registry.dispose());

  const unavailable = await piRuntimeAvailability();
  const [route] = await registry.discover();
  assert.equal(route?.model, "glm-5.3:cloud");
  assert.equal(route?.inferenceServer, "ollama");
  assert.equal(route?.inferenceLocation, "remote");
  assert.deepEqual(route?.billing, { mode: "unknown", evidence: "unverified" });
  if (unavailable.length > 0) {
    assert.equal(route?.readiness, "unavailable");
    return;
  }
  assert.equal(route?.readiness, "ready");
  assert.ok(route?.capabilities.includes("steering"));

  const request = {
    selector: {
      provider: "unknown",
      model: "glm-5.3:cloud",
      via: "pi",
      requiredCapabilities: ["core.tools"],
    },
    input: [{ type: "text" as const, text: "hello" }],
    workingDirectory: root,
    interactionStrategy: "unattended" as const,
    requestedPolicy: { minimumAssurance: "none" as const },
  };
  const resolved = await registry.resolve(request);
  state.signedIn = false;
  await assert.rejects(
    adapter.run({
      invocationId: "cloud-signed-out",
      request,
      route: resolved.route,
      signal: new AbortController().signal,
      async emit() {},
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "route_unavailable" &&
      error.message.includes("ollama signin"),
  );
});

test("configured Ollama route dispatches its exact model through Pi and normalizes identity", async (context) => {
  const unavailable = await piRuntimeAvailability();
  if (unavailable.length > 0) {
    context.skip(unavailable.join(" "));
    return;
  }
  const digest = "c".repeat(64);
  const server = await codingAgentEndpoint(context, digest);
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-agent-"));
  const workingDirectory = join(root, "work");
  await mkdir(workingDirectory);
  const configPath = join(root, "config.json");
  const connectionsPath = join(root, "connections.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [{ id: "ollama-test", kind: "ollama", endpoint: server.url }],
    }),
    "utf8",
  );
  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], { catalogPath: configPath, connectionsPath });
  try {
    const request = localRequest(workingDirectory);
    const resolved = await registry.resolve(request);
    assert.equal(resolved.route.model, "qwen3:4b");
    assert.equal(resolved.route.nativeModel, "qwen3:4b");
    assert.equal(resolved.route.modelDigest, digest);
    assert.equal(resolved.route.provider, "unknown");
    const events: AdapterEvent[] = [];
    const partials: Array<Partial<AdapterRunResult>> = [];
    const run = await adapter.run({
      invocationId: "local-pi-e2e",
      request,
      route: resolved.route,
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
      reportPartial(partial) {
        partials.push(partial);
      },
    });
    assert.ok(run.continuationHandle);
    const continuedRequest: StartInvocationRequest = {
      ...request,
      input: [{ type: "text", text: "Continue and confirm the earlier file creation." }],
    };
    const continued = await adapter.run({
      invocationId: "local-pi-e2e-continuation",
      request: continuedRequest,
      route: resolved.route,
      continuationHandle: run.continuationHandle,
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
      reportPartial(partial) {
        partials.push(partial);
      },
    });

    assert.equal(await readFile(join(workingDirectory, "generated.txt"), "utf8"), "local-pi-ok");
    assert.deepEqual(run.content, [{ type: "text", text: "Created generated.txt." }]);
    assert.deepEqual(continued.content, [{ type: "text", text: "Continued with qwen3:4b." }]);
    assert.ok(continued.continuationHandle);
    assert.ok(events.some((event) => event.category === "output"));
    assert.equal(
      server.requests.length,
      3,
      "continuation should reuse the exact model configuration",
    );
    assert.ok(server.requests.every((body) => body.model === "qwen3:4b"));
    const tools = server.requests[0]?.tools;
    assert.ok(Array.isArray(tools));
    assert.ok(
      tools.some(
        (tool) =>
          typeof tool === "object" &&
          tool !== null &&
          "function" in tool &&
          typeof tool.function === "object" &&
          tool.function !== null &&
          "name" in tool.function &&
          tool.function.name === "bash",
      ),
    );
    assert.match(JSON.stringify(server.requests[2]?.messages), /Created generated\.txt/u);
    assert.match(JSON.stringify(server.requests[2]?.messages), /Continue and confirm/u);
    assert.ok(partials.length > 0);
    for (const identity of [
      run.observedIdentity,
      continued.observedIdentity,
      ...partials.flatMap((partial) =>
        partial.observedIdentity ? [partial.observedIdentity] : [],
      ),
    ]) {
      assert.equal(identity.provider.value, undefined);
      assert.equal(identity.provider.evidence, "unverified");
      assert.equal(identity.provider.source, "ollama-model-catalog");
      assert.doesNotMatch(JSON.stringify(identity.provider), /relay-local-/u);
      assert.equal(identity.model.value, "qwen3:4b");
    }
    assert.deepEqual(server.errors, []);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("ready Ollama routes steer their captured Pi session after runtime removal", async (context) => {
  const unavailable = await piRuntimeAvailability();
  if (unavailable.length > 0) {
    context.skip(unavailable.join(" "));
    return;
  }
  const digest = "e".repeat(64);
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-steering-"));
  const workingDirectory = join(root, "work");
  await mkdir(workingDirectory);
  const startedPath = join(workingDirectory, "steering-started");
  const releasePath = join(workingDirectory, "release-steering");
  const finishedPath = join(workingDirectory, "steering-finished");
  const earlyText = "Queue this while local route preflight is waiting.";
  const refreshedText = "After runtime removal, include this in the following model request.";
  let followupRequests = 0;
  let earlyTextRequest = 0;
  let refreshedTextRequest = 0;
  const server = await codingAgentEndpoint(context, digest, {
    toolCommand: `touch ${startedPath}; while [ ! -f ${releasePath} ]; do sleep 0.02; done; touch ${finishedPath}`,
    finalResponse: "I received both steering corrections.",
    followupReply(response, request) {
      followupRequests += 1;
      const messages = JSON.stringify(request.messages ?? []);
      if (messages.includes(earlyText) && earlyTextRequest === 0) {
        earlyTextRequest = followupRequests;
      }
      if (messages.includes(refreshedText) && refreshedTextRequest === 0) {
        refreshedTextRequest = followupRequests;
      }
      if (earlyTextRequest > 0 && refreshedTextRequest > 0) {
        assert.ok(earlyTextRequest <= refreshedTextRequest, "steering text must retain FIFO order");
        streamReply(response, { content: "Both corrections reached the next model turn." }, "stop");
        return;
      }
      assert.ok(followupRequests <= 2, "both queued corrections must reach a later model request");
      streamReply(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `steering-barrier-${followupRequests}`,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "true" }) },
            },
          ],
        },
        "tool_calls",
      );
    },
  });
  const configPath = join(root, "config.json");
  const connectionsPath = join(root, "connections.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [{ id: "ollama-test", kind: "ollama", endpoint: server.url }],
    }),
    "utf8",
  );
  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], { catalogPath: configPath, connectionsPath });
  const runController = new AbortController();
  const earlyInputController = new AbortController();
  const refreshedInputController = new AbortController();
  let pause: ShowPause | undefined;
  let completion:
    | Promise<
        | { readonly ok: false; readonly error: unknown }
        | { readonly ok: true; readonly value: AdapterRunResult }
      >
    | undefined;
  try {
    const baseRequest = localRequest(workingDirectory);
    const request: StartInvocationRequest = {
      ...baseRequest,
      selector: {
        ...baseRequest.selector,
        requiredCapabilities: [...(baseRequest.selector.requiredCapabilities ?? []), "steering"],
      },
    };
    const resolved = await registry.resolve(request);
    assert.ok(resolved.route.capabilities.includes("steering"));
    pause = server.pauseNextShow();
    completion = adapter
      .run({
        invocationId: "local-pi-steering-after-refresh",
        request,
        route: resolved.route,
        signal: runController.signal,
        async emit() {},
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await pause.started;

    let earlyInputSettled = false;
    const earlyInput = adapter
      .sendInput({
        invocationId: "local-pi-steering-after-refresh",
        route: resolved.route,
        inputId: "input-before-ready",
        content: [{ type: "text", text: earlyText }],
        signal: earlyInputController.signal,
      })
      .finally(() => {
        earlyInputSettled = true;
      });
    await delay(25);
    assert.equal(
      earlyInputSettled,
      false,
      "early input must wait for its invocation-bound adapter",
    );
    pause.release();
    await waitForFile(startedPath, "the Pi Bash steering barrier");
    assert.deepEqual(await within(earlyInput, "the early native steering acknowledgement"), {
      boundary: "next-supported-boundary",
    });

    await writeFile(configPath, JSON.stringify({ localRuntimes: [] }), "utf8");
    assert.deepEqual(await registry.discover({ refresh: true }), []);
    const refreshedInput = adapter.sendInput({
      invocationId: "local-pi-steering-after-refresh",
      route: resolved.route,
      inputId: "input-after-refresh",
      content: [{ type: "text", text: refreshedText }],
      signal: refreshedInputController.signal,
    });
    assert.deepEqual(
      await within(refreshedInput, "the post-refresh native steering acknowledgement"),
      { boundary: "next-supported-boundary" },
    );
    await assert.rejects(access(finishedPath), { code: "ENOENT" });
    await writeFile(releasePath, "release", "utf8");

    assert.ok(completion !== undefined);
    const result = await within(completion, "the steered local Pi invocation");
    if (!result.ok) {
      throw result.error;
    }
    assert.deepEqual(result.value.content, [
      { type: "text", text: "Both corrections reached the next model turn." },
    ]);
    assert.equal(server.requests.length, followupRequests + 1);
    assert.ok(earlyTextRequest > 0, "early input must reach a subsequent model request");
    assert.ok(refreshedTextRequest > 0, "post-refresh input must reach a subsequent model request");
    assert.ok(followupRequests <= 2);
    await access(finishedPath);
    assert.deepEqual(server.errors, []);
  } finally {
    pause?.release();
    runController.abort();
    earlyInputController.abort();
    refreshedInputController.abort();
    await writeFile(releasePath, "release", "utf8").catch(() => {});
    if (completion !== undefined) {
      await within(completion, "local Pi cleanup").catch((error: unknown) => error);
    }
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("early local Pi input waits for route preflight and settles when the run is cancelled", async (context) => {
  const unavailable = await piRuntimeAvailability();
  if (unavailable.length > 0) {
    context.skip(unavailable.join(" "));
    return;
  }
  const server = await codingAgentEndpoint(context, "d".repeat(64));
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-input-"));
  const workingDirectory = join(root, "work");
  await mkdir(workingDirectory);
  const configPath = join(root, "config.json");
  const connectionsPath = join(root, "connections.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [{ id: "ollama-test", kind: "ollama", endpoint: server.url }],
    }),
    "utf8",
  );
  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], { catalogPath: configPath, connectionsPath });
  let pause: ShowPause | undefined;
  const controller = new AbortController();
  try {
    const request = localRequest(workingDirectory);
    const resolved = await registry.resolve(request);
    pause = server.pauseNextShow();
    const run = adapter.run({
      invocationId: "local-pi-early-input",
      request,
      route: resolved.route,
      signal: controller.signal,
      async emit() {},
    });
    await pause.started;
    let inputSettled = false;
    const input = adapter
      .sendInput({
        invocationId: "local-pi-early-input",
        route: resolved.route,
        inputId: "input-1",
        content: [{ type: "text", text: "Please continue." }],
        signal: new AbortController().signal,
      })
      .finally(() => {
        inputSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(inputSettled, false, "input should wait for the adapter bound to this invocation");
    controller.abort(new Error("test cancellation"));
    await assert.rejects(run, /test cancellation/u);
    await assert.rejects(input, /test cancellation/u);
  } finally {
    pause?.release();
    controller.abort();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped Ollama server is reported as unavailable, not as a changed model", async (context) => {
  const unavailable = await piRuntimeAvailability();
  if (unavailable.length > 0) {
    context.skip(unavailable.join(" "));
    return;
  }
  const digest = "d".repeat(64);
  const server = createServer((request, response) => {
    if (request.url === "/api/version") {
      jsonResponse(response, { version: "0.34.4" });
    } else if (request.url === "/api/tags") {
      jsonResponse(response, { models: [{ name: "qwen3:4b", model: "qwen3:4b", digest }] });
    } else {
      jsonResponse(response, {
        model_info: { "qwen3.context_length": 16_384 },
        capabilities: ["completion", "tools"],
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "harness-relay-local-pi-stopped-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "work");
  await mkdir(workingDirectory);
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      localRuntimes: [
        { id: "ollama-stopped", kind: "ollama", endpoint: `http://127.0.0.1:${address.port}` },
      ],
    }),
    "utf8",
  );
  const adapter = new LocalPiAdapter({ configPath });
  const registry = new AdapterRegistry([adapter], {
    catalogPath: configPath,
    connectionsPath: join(root, "connections.json"),
  });
  context.after(async () => registry.dispose());
  const request = localRequest(workingDirectory);
  const resolved = await registry.resolve(request);

  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await assert.rejects(
    adapter.run({
      invocationId: "local-pi-stopped-server",
      request,
      route: resolved.route,
      signal: new AbortController().signal,
      async emit() {},
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "route_unavailable" &&
      error.message.includes("Ollama profile ollama-stopped is unavailable at") &&
      !error.message.includes("changed after route discovery"),
  );
});
