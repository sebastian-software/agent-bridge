import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";

import {
  discoverLocalRuntime,
  type LocalRuntimeKind,
  parseLocalRuntimeProfiles,
} from "../src/local-runtimes.js";

async function endpoint(
  context: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<string> {
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(async () => handler(request, response))
      .catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end();
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
  return `http://127.0.0.1:${address.port}`;
}

function profile(url: string, kind: LocalRuntimeKind = "ollama") {
  const result = parseLocalRuntimeProfiles({
    localRuntimes: [{ id: "local", kind, endpoint: url }],
  });
  assert.ok(result[0]);
  return result[0];
}

function json(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text) as unknown;
}

function tag(name: string, extra: Readonly<Record<string, unknown>> = {}) {
  return { name, model: name, digest: "a".repeat(64), ...extra };
}

test("local runtime profiles reject ambiguous or nonlocal access and normalize stable identity", () => {
  const original = profile("http://localhost:11434/");
  assert.equal(original.endpoint, "http://127.0.0.1:11434");
  assert.equal(original.revision, profile("http://127.0.0.1:11434").revision);
  assert.notEqual(original.revision, profile("http://127.0.0.1:11435").revision);
  assert.equal(profile("http://[::1]:11434").endpoint, "http://[::1]:11434");

  for (const url of [
    "https://localhost:11434",
    "http://192.168.1.2:11434",
    "http://localhost.example:11434",
    "http://user:secret@localhost:11434",
    "http://localhost:11434/v1",
    "http://localhost:11434/?token=secret",
    "http://localhost:11434/#fragment",
    "file:///tmp/model",
  ]) {
    assert.throws(() => profile(url), /loopback|HTTP/u);
  }
  const base = { id: "local", kind: "ollama", endpoint: "http://127.0.0.1:11434" };
  assert.throws(() => parseLocalRuntimeProfiles({ localRuntimes: [base, base] }), /duplicated/u);
  assert.throws(
    () =>
      parseLocalRuntimeProfiles({
        localRuntimes: [{ ...base, headers: { authorization: "secret" } }],
      }),
    /unsupported fields/u,
  );
  assert.throws(
    () =>
      parseLocalRuntimeProfiles({
        localRuntimes: Array.from({ length: 17 }, (_, index) => ({
          ...base,
          id: `server-${index}`,
        })),
      }),
    /at most 16/u,
  );
});

test("Ollama discovery excludes remote routes from either native response without model-name fallback", async (context) => {
  const lookedUp: unknown[] = [];
  const url = await endpoint(context, async (request, response) => {
    if (request.url === "/api/version") {
      json(response, { version: "0.34.4" });
      return;
    }
    if (request.url === "/api/tags") {
      json(response, {
        models: [
          tag("qwen3:4b"),
          tag("innocent-name", { remote_host: "https://ollama.com" }),
          tag("another-name", { remote_model: "grok" }),
          tag("remote-in-show"),
          tag("mismatched"),
        ],
      });
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/show");
    const body = await requestBody(request);
    lookedUp.push(body);
    if (JSON.stringify(body) === JSON.stringify({ model: "remote-in-show" })) {
      json(response, { remote_model: "qwen3:4b", capabilities: ["tools"] });
      return;
    }
    if (JSON.stringify(body) === JSON.stringify({ model: "mismatched" })) {
      json(response, { model: "other-model", capabilities: ["tools"] });
      return;
    }
    assert.deepEqual(body, { model: "qwen3:4b" });
    json(response, {
      capabilities: ["completion", "tools"],
      model_info: { "qwen3.context_length": 32_768 },
    });
  });
  const inventory = await discoverLocalRuntime(profile(url));
  assert.equal(inventory.serverVersion, "0.34.4");
  assert.equal(inventory.models.length, 1);
  assert.equal(inventory.models[0]?.id, "qwen3:4b");
  assert.equal(inventory.models[0]?.digest, "a".repeat(64));
  assert.equal(inventory.models[0]?.supportsTools, true);
  assert.equal(inventory.models[0]?.contextWindow, 32_768);
  assert.equal(inventory.models[0]?.providerEvidence, "unverified");
  assert.deepEqual(
    lookedUp.map((value) => JSON.stringify(value)).toSorted(),
    [{ model: "qwen3:4b" }, { model: "remote-in-show" }, { model: "mismatched" }]
      .map((value) => JSON.stringify(value))
      .toSorted(),
  );
  assert.match(inventory.diagnostics.join(" "), /remote_host or remote_model/u);
  assert.match(inventory.diagnostics.join(" "), /different model identity/u);
});

function cloudTag(
  name: string,
  remoteModel: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return tag(name, { remote_host: "https://ollama.com", remote_model: remoteModel, ...extra });
}

async function cloudEndpoint(
  context: TestContext,
  options: {
    readonly models: readonly unknown[];
    readonly me?: number;
    readonly show?: (model: string) => Readonly<Record<string, unknown>>;
  },
): Promise<{ readonly url: string; readonly requests: string[] }> {
  const requests: string[] = [];
  const url = await endpoint(context, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/version") {
      json(response, { version: "0.34.4" });
      return;
    }
    if (request.url === "/api/tags") {
      json(response, { models: options.models });
      return;
    }
    if (request.url === "/api/me") {
      assert.equal(request.method, "POST");
      const status = options.me ?? 200;
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(
          JSON.stringify(
            status === 401
              ? { error: "unauthorized", signin_url: "https://ollama.com/connect?key=secret-key" }
              : { name: "someone", email: "someone@example.com" },
          ),
        );
      return;
    }
    assert.equal(request.url, "/api/show");
    const body = (await requestBody(request)) as { model: string };
    json(
      response,
      options.show?.(body.model) ?? {
        capabilities: ["completion", "thinking", "tools"],
        model_info: { "glm_dsa_moe.context_length": 1_048_576 },
      },
    );
  });
  return { url, requests };
}

test("Ollama cloud models become remote routes once the server is signed in", async (context) => {
  const { url, requests } = await cloudEndpoint(context, {
    models: [tag("qwen3:4b"), cloudTag("glm-5.3:cloud", "glm-5.3")],
    show: (model) =>
      model === "qwen3:4b"
        ? { capabilities: ["tools"], model_info: { "qwen3.context_length": 32_768 } }
        : {
            capabilities: ["completion", "thinking", "tools"],
            model_info: { "glm_dsa_moe.context_length": 1_048_576 },
          },
  });
  const inventory = await discoverLocalRuntime(profile(url));
  assert.deepEqual(inventory.diagnostics, []);
  assert.equal(requests.filter((request) => request === "POST /api/me").length, 1);
  const local = inventory.models.find((model) => model.id === "qwen3:4b");
  assert.equal(local?.inferenceLocation, "local");
  assert.equal(local?.remoteModel, undefined);
  const cloud = inventory.models.find((model) => model.id === "glm-5.3:cloud");
  assert.equal(cloud?.inferenceLocation, "remote");
  assert.equal(cloud?.remoteModel, "glm-5.3");
  assert.equal(cloud?.readiness, "ready");
  assert.equal(cloud?.contextWindow, 1_048_576);
  assert.equal(cloud?.provider, "unknown");
  assert.ok(cloud?.capabilities.includes("core.tools"));
});

test("Ollama discovery asks for the sign-in only when a cloud model is installed", async (context) => {
  const { url, requests } = await cloudEndpoint(context, { models: [tag("qwen3:4b")] });
  const inventory = await discoverLocalRuntime(profile(url));
  assert.equal(inventory.models[0]?.inferenceLocation, "local");
  assert.equal(requests.includes("POST /api/me"), false);
});

test("Ollama cloud models without a sign-in are unavailable and never leak the sign-in link", async (context) => {
  for (const [status, pattern] of [
    [401, /not signed in to ollama\.com.*ollama signin/u],
    [404, /did not confirm a sign-in/u],
    [500, /did not confirm a sign-in/u],
  ] as const) {
    const { url } = await cloudEndpoint(context, {
      models: [cloudTag("kimi-k3:cloud", "kimi-k3")],
      me: status,
    });
    const inventory = await discoverLocalRuntime(profile(url));
    const model = inventory.models[0];
    assert.equal(model?.readiness, "unavailable");
    assert.equal(model?.inferenceLocation, "remote");
    assert.match(model?.diagnostics.join(" ") ?? "", pattern);
    const serialized = JSON.stringify(inventory);
    assert.equal(serialized.includes("secret-key"), false);
    assert.equal(serialized.includes("someone"), false);
  }
});

test("Ollama keeps excluding remote entries that are not complete ollama.com cloud models", async (context) => {
  const { url } = await cloudEndpoint(context, {
    models: [
      tag("other-host", { remote_host: "https://models.example.com", remote_model: "glm-5.3" }),
      tag("lookalike", { remote_host: "https://ollama.com.example.net", remote_model: "glm-5.3" }),
      tag("with-path", { remote_host: "https://ollama.com/proxy", remote_model: "glm-5.3" }),
      tag("no-model", { remote_host: "https://ollama.com" }),
      cloudTag("renamed:cloud", "glm-5.3"),
    ],
    show: () => ({
      remote_host: "https://ollama.com",
      remote_model: "kimi-k3",
      capabilities: ["tools"],
    }),
  });
  const inventory = await discoverLocalRuntime(profile(url));
  assert.deepEqual(inventory.models, []);
  const diagnostics = inventory.diagnostics.join(" ");
  for (const id of ["other-host", "lookalike", "with-path", "no-model"]) {
    assert.ok(diagnostics.includes(`${id} forwards to a remote model`), id);
  }
  assert.match(diagnostics, /different remote model for renamed:cloud/u);
});

test("local discovery does not follow an HTTP redirect to another endpoint", async (context) => {
  let redirectedRequests = 0;
  const target = await endpoint(context, (_request, response) => {
    redirectedRequests += 1;
    json(response, { version: "0.34.4", models: [] });
  });
  const source = await endpoint(context, (_request, response) => {
    response.writeHead(302, { location: target }).end();
  });
  const inventory = await discoverLocalRuntime(profile(source));
  assert.deepEqual(inventory.models, []);
  assert.ok(inventory.diagnostics.length > 0);
  assert.equal(redirectedRequests, 0);
});

test("local discovery bounds oversized native responses", async (context) => {
  const url = await endpoint(context, (request, response) => {
    if (request.url === "/api/version") {
      json(response, { version: "0.34.4" });
      return;
    }
    json(response, { models: [], padding: "x".repeat(2 * 1024 * 1024) });
  });
  const inventory = await discoverLocalRuntime(profile(url));
  assert.deepEqual(inventory.models, []);
  assert.match(inventory.diagnostics.join(" "), /2 MiB/u);
});

test(
  "Ollama inventory has one deadline even when every model-detail request stalls",
  { timeout: 25_000 },
  async (context) => {
    let detailRequests = 0;
    const url = await endpoint(context, (request, response) => {
      if (request.url === "/api/version") {
        json(response, { version: "0.34.4" });
        return;
      }
      if (request.url === "/api/tags") {
        json(response, {
          models: Array.from({ length: 64 }, (_, index) => tag(`model-${index}`)),
        });
        return;
      }
      assert.equal(request.url, "/api/show");
      detailRequests += 1;
      // Leave the response open: native HTTP cancellation, not a mocked clock,
      // must bound the complete inventory rather than 64 independent retries.
    });
    const inventory = await discoverLocalRuntime(profile(url));
    assert.deepEqual(inventory.models, []);
    assert.ok(detailRequests > 0 && detailRequests < 64);
    assert.match(inventory.diagnostics.join(" "), /deadline/u);
  },
);

test("LM Studio distinguishes loaded, unloaded, and embedding models without claiming locality", async (context) => {
  const requests: string[] = [];
  const url = await endpoint(context, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    json(response, {
      models: [
        {
          type: "llm",
          publisher: "qwen",
          key: "qwen/qwen3-4b",
          capabilities: { trained_for_tool_use: true },
          loaded_instances: [{ id: "my-loaded-model", config: { context_length: 8192 } }],
        },
        { type: "llm", publisher: "qwen", key: "qwen/unloaded", loaded_instances: [] },
        {
          type: "embedding",
          publisher: "nomic",
          key: "nomic/embed",
          loaded_instances: [{ id: "embed" }],
        },
      ],
    });
  });
  const inventory = await discoverLocalRuntime(profile(url, "lm-studio"));
  assert.deepEqual(requests, ["GET /api/v1/models"]);
  assert.equal(inventory.models.length, 2);
  const loaded = inventory.models.find((model) => model.id === "my-loaded-model");
  assert.equal(loaded?.canonicalModel, "qwen/qwen3-4b");
  assert.equal(loaded?.instanceId, "my-loaded-model");
  assert.equal(loaded?.provider, "qwen");
  assert.equal(loaded?.readiness, "unqualified");
  assert.equal(loaded?.inferenceLocation, undefined);
  assert.match(loaded?.diagnostics.join(" ") ?? "", /remote device/u);
  assert.equal(
    inventory.models.find((model) => model.id === "qwen/unloaded")?.readiness,
    "unavailable",
  );
});
