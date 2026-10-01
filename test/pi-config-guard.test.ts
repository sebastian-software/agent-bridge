import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import type { ResolvedRoute, StartInvocationRequest } from "../src/contract.js";

import {
  assertPiAuthStorageContentSafe,
  assertPiLoadedModelConfigurationSafe,
  assertPiRuntimeConfigurationSafe,
  PiRuntimeConfigurationError,
  type PiRuntimeModelFiles,
} from "../src/adapters/pi-config-guard.js";
import { type PiRuntimeConfiguration, runPiWorker } from "../src/adapters/pi-supervisor.js";
import { BridgeError } from "../src/errors.js";

type FixtureRequest = {
  readonly authorizationPresent: boolean;
  readonly staticHeader: string | undefined;
};
type FixtureReply = (response: ServerResponse) => void;
type PiFixture = {
  readonly authPath: string;
  readonly baseUrl: string;
  readonly modelFiles: PiRuntimeModelFiles;
  readonly modelsPath: string;
  readonly requests: FixtureRequest[];
  readonly root: string;
  readonly workingDirectory: string;
  readonly setReplies: (replies: readonly FixtureReply[]) => void;
  readonly writeAuth: (content: string) => Promise<void>;
  readonly writeModels: (content: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

function stream(
  response: ServerResponse,
  delta: Record<string, unknown>,
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
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", ...chunk })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

function textReply(text: string): FixtureReply {
  return (response) => {
    stream(response, { content: text }, "stop");
  };
}

function bashReply(command: string): FixtureReply {
  return (response) => {
    stream(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: "call-update-auth",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command }) },
          },
        ],
      },
      "tool_calls",
    );
  };
}

async function startFixture(): Promise<PiFixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-config-"));
  const agentDirectory = join(root, "agent");
  const workingDirectory = join(root, "work");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  const requests: FixtureRequest[] = [];
  let replies: FixtureReply[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      for await (const _chunk of request) {
        // Drain the request body without retaining credential-bearing payload data.
      }
      requests.push({
        authorizationPresent: typeof request.headers.authorization === "string",
        staticHeader:
          typeof request.headers["x-static-fixture"] === "string"
            ? request.headers["x-static-fixture"]
            : undefined,
      });
      const reply = replies.shift();
      assert.ok(reply, "unexpected Pi model request (including a retry)");
      reply(response);
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : "fixture failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const modelFiles = {
    authPath: join(agentDirectory, "auth.json"),
    modelsPath: join(agentDirectory, "models.json"),
    modelsStorePath: join(agentDirectory, "models-store.json"),
  };
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(
    modelFiles.authPath,
    JSON.stringify({
      openai: { type: "api_key", key: "static-fixture-token" },
    }),
  );
  await writeFile(
    modelFiles.modelsPath,
    JSON.stringify({ providers: { openai: modelProvider(baseUrl) } }),
  );
  await writeFile(modelFiles.modelsStorePath, "{}");

  return {
    authPath: modelFiles.authPath,
    baseUrl,
    modelFiles,
    modelsPath: modelFiles.modelsPath,
    requests,
    root,
    workingDirectory,
    setReplies(next) {
      replies = [...next];
    },
    async writeAuth(content) {
      await writeFile(modelFiles.authPath, content);
    },
    async writeModels(content) {
      await writeFile(modelFiles.modelsPath, content);
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function modelProvider(
  baseUrl: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: "fixture-model",
        api: "openai-completions",
        contextWindow: 32_768,
        maxTokens: 20_000,
      },
    ],
    ...extra,
  };
}

function configuration(fixture: PiFixture): PiRuntimeConfiguration {
  return {
    model: { provider: "openai", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash"],
  };
}

function runContext(
  fixture: PiFixture,
  input = "Use the configured model and report the result.",
): {
  context: AdapterRunContext;
  events: AdapterEvent[];
  partials: Array<Partial<AdapterRunResult>>;
} {
  const events: AdapterEvent[] = [];
  const partials: Array<Partial<AdapterRunResult>> = [];
  const request: StartInvocationRequest = {
    selector: {
      provider: "openai",
      model: "fixture-model",
      via: "pi",
      requiredCapabilities: ["core.input.text", "core.output.text"],
    },
    input: [{ type: "text", text: input }],
    workingDirectory: fixture.workingDirectory,
    interactionStrategy: "unattended",
    requestedPolicy: {
      minimumAssurance: "none",
      filesystem: "inherit",
      commands: "allow",
      network: "allow",
    },
  };
  const route: ResolvedRoute = {
    routeId: "openai:fixture-model",
    adapter: "pi",
    harnessVersion: "1.0.0",
    authenticationMode: "api_key",
    provider: "openai",
    model: "fixture-model",
    via: "pi",
    capabilities: [],
    qualification: [],
  };
  return {
    events,
    partials,
    context: {
      invocationId: "test-pi-config-guard",
      request,
      route,
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
      reportPartial(result) {
        partials.push(result);
      },
      terminationGraceMs: 1000,
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );
}

async function assertCommandConfigFailure(
  operation: Promise<unknown>,
  hiddenValues: readonly string[],
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BridgeError, "the worker should fail at the harness boundary");
  assert.equal(caught.code, "harness_failed");
  assert.equal(caught.details?.nativeCode, "pi_command_config_unsupported");
  const publicDetail = JSON.stringify(caught.toDetail());
  for (const value of hiddenValues) {
    assert.equal(
      publicDetail.includes(value),
      false,
      "configuration failures must not reveal values",
    );
  }
}

test("Pi accepts static auth and model configuration through the native SDK storage", async () => {
  const fixture = await startFixture();
  try {
    await fixture.writeModels(
      JSON.stringify({
        providers: {
          openai: modelProvider(fixture.baseUrl, {
            headers: { "X-Static-Fixture": "plain-header" },
          }),
        },
      }),
    );
    fixture.setReplies([textReply("Static configuration passed.")]);
    const { context } = runContext(fixture);
    const result = await runPiWorker(context, configuration(fixture));
    assert.ok(
      result.content.some(
        (part) => part.type === "text" && part.text.includes("Static configuration passed."),
      ),
    );
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.authorizationPresent, true);
    assert.equal(fixture.requests[0]?.staticHeader, "plain-header");
  } finally {
    await fixture.close();
  }
});

test("a request-time auth reload rejects a newly introduced command before Pi can execute it", async () => {
  const fixture = await startFixture();
  const markerPath = join(fixture.root, "auth-command-ran");
  try {
    const commandValue = `!touch ${shellQuote(markerPath)}`;
    const replacement = JSON.stringify({
      openai: { type: "api_key", key: commandValue },
    });
    const writeAuthCommand =
      `node -e 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])' ` +
      `${shellQuote(fixture.authPath)} ${shellQuote(replacement)}`;
    fixture.setReplies([bashReply(writeAuthCommand)]);
    const { context } = runContext(
      fixture,
      "Update auth.json from the shell command, then retry once.",
    );
    await assertCommandConfigFailure(runPiWorker(context, configuration(fixture)), [
      markerPath,
      commandValue,
      "static-fixture-token",
    ]);
    assert.equal(
      fixture.requests.length,
      1,
      "the second model request must be rejected before HTTP",
    );
    await assertMissing(markerPath);
  } finally {
    await fixture.close();
  }
});

async function assertModelCommandRejected(
  fixture: PiFixture,
  extra: Record<string, unknown>,
  markerPath: string,
  command: string,
): Promise<void> {
  await fixture.writeModels(
    JSON.stringify({ providers: { openai: modelProvider(fixture.baseUrl, extra) } }),
  );
  const { context } = runContext(fixture);
  await assertCommandConfigFailure(runPiWorker(context, configuration(fixture)), [
    markerPath,
    command,
    "static-fixture-token",
  ]);
  assert.equal(fixture.requests.length, 0);
  await assertMissing(markerPath);
}

test("models.json API keys using command values fail before a model request", async () => {
  const fixture = await startFixture();
  const apiMarker = join(fixture.root, "models-api-command-ran");
  try {
    const apiCommand = `!touch ${shellQuote(apiMarker)}`;
    await assertModelCommandRejected(fixture, { apiKey: apiCommand }, apiMarker, apiCommand);
  } finally {
    await fixture.close();
  }
});

test("models.json headers using command values fail before a model request", async () => {
  const fixture = await startFixture();
  const markerPath = join(fixture.root, "models-header-command-ran");
  try {
    const command = `!touch ${shellQuote(markerPath)}`;
    await assertModelCommandRejected(
      fixture,
      { headers: { "X-Command-Fixture": command } },
      markerPath,
      command,
    );
  } finally {
    await fixture.close();
  }
});

test("Pi config validation rejects command values across auth, model, and store fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-config-scan-"));
  const markerPath = join(root, "must-not-leak");
  const command = `!touch ${shellQuote(markerPath)}`;
  const files = {
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
  };
  const baseProvider = {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    models: [{ id: "fixture-model", api: "openai-completions" }],
  };
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly auth?: unknown;
    readonly provider?: Record<string, unknown>;
    readonly modelsStore?: unknown;
  }> = [
    {
      name: "auth.json API key",
      auth: { openai: { type: "api_key", key: command } },
    },
    {
      name: "models.json provider API key",
      provider: { ...baseProvider, apiKey: command },
    },
    {
      name: "models.json provider headers",
      provider: { ...baseProvider, headers: { Authorization: command } },
    },
    {
      name: "models.json model headers",
      provider: {
        ...baseProvider,
        models: [
          { id: "fixture-model", api: "openai-completions", headers: { Authorization: command } },
        ],
      },
    },
    {
      name: "models.json model override headers",
      provider: {
        ...baseProvider,
        modelOverrides: { "fixture-model": { headers: { Authorization: command } } },
      },
    },
    {
      name: "models-store model headers",
      modelsStore: {
        openai: { models: [{ id: "fixture-model", headers: { Authorization: command } }] },
      },
    },
  ];

  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        await writeFile(files.authPath, JSON.stringify(entry.auth ?? {}));
        await writeFile(
          files.modelsPath,
          JSON.stringify({ providers: { openai: entry.provider ?? baseProvider } }),
        );
        await writeFile(files.modelsStorePath, JSON.stringify(entry.modelsStore ?? {}));
        await assert.rejects(
          assertPiRuntimeConfigurationSafe(files),
          (error: unknown) =>
            error instanceof PiRuntimeConfigurationError &&
            error.code === "pi_command_config_unsupported" &&
            !error.message.includes(markerPath) &&
            !error.message.includes("touch"),
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static config and Pi JSONC syntax remain accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-config-static-"));
  const files = {
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
  };
  try {
    await writeFile(
      files.authPath,
      JSON.stringify({ openai: { type: "api_key", key: "static-value" } }),
    );
    await writeFile(
      files.modelsPath,
      `{
        // Pi accepts comments and trailing commas in models.json.
        "providers": {
          "openai": {
            "apiKey": "$OPENAI_API_KEY",
            "headers": { "X-Static": "value", },
            "models": [{ "id": "fixture-model", "headers": { "X-Model": "value" }, },],
            "modelOverrides": { "fixture-model": { "headers": { "X-Override": "value" }, }, },
          },
        },
      }`,
    );
    await writeFile(
      files.modelsStorePath,
      JSON.stringify({
        openai: { models: [{ id: "fixture-model", headers: { "X-Cache": "value" } }] },
      }),
    );
    await assert.doesNotReject(assertPiRuntimeConfigurationSafe(files));
    assert.doesNotThrow(() => {
      assertPiAuthStorageContentSafe(JSON.stringify({ openai: { type: "api_key", key: "$KEY" } }));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pinned SDK's loaded ModelConfig snapshot is validated and unsupported shapes fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-loaded-config-"));
  const modelsPath = join(root, "models.json");
  try {
    const marker = join(root, "loaded-config-command-ran");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: `!touch ${shellQuote(marker)}`,
            headers: { Authorization: `!touch ${shellQuote(marker)}` },
          },
        },
      }),
    );
    const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const moduleValue: unknown = await import(new URL("core/model-config.js", sdkEntry).href);
    const moduleRecord =
      typeof moduleValue === "object" && moduleValue !== null
        ? (moduleValue as Record<string, unknown>)
        : undefined;
    const modelConfigClass = moduleRecord?.ModelConfig;
    if (typeof modelConfigClass !== "function") {
      assert.fail("the pinned Pi ModelConfig export is unavailable");
    }
    const load = Reflect.get(modelConfigClass, "load");
    if (typeof load !== "function") {
      assert.fail("the pinned Pi ModelConfig loader is unavailable");
    }
    const modelConfig = await (load as (this: unknown, path: string) => Promise<unknown>).call(
      modelConfigClass,
      modelsPath,
    );
    assert.throws(
      () => {
        assertPiLoadedModelConfigurationSafe(modelConfig);
      },
      (error: unknown) =>
        error instanceof PiRuntimeConfigurationError &&
        error.code === "pi_command_config_unsupported" &&
        !error.message.includes(marker),
    );
    await assertMissing(marker);
    assert.throws(
      () => {
        assertPiLoadedModelConfigurationSafe({});
      },
      (error: unknown) =>
        error instanceof PiRuntimeConfigurationError && error.code === "pi_config_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AuthStorage content guard rejects command values without exposing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-auth-content-"));
  try {
    const command = `!touch ${shellQuote(join(root, "secret-marker"))}`;
    assert.throws(
      () => {
        assertPiAuthStorageContentSafe(
          JSON.stringify({ openai: { type: "api_key", key: command } }),
        );
      },
      (error: unknown) =>
        error instanceof PiRuntimeConfigurationError &&
        error.code === "pi_command_config_unsupported" &&
        !error.message.includes(command),
    );
    assert.doesNotThrow(() => {
      assertPiAuthStorageContentSafe("{}");
    });
    await assertMissing(join(root, "secret-marker"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
