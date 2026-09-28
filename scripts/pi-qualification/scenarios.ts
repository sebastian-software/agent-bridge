import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = process.argv[2];
assert.ok(root, "isolated root is required");
const agentDir = join(root, "agent");
const cwd = join(root, "work");
await mkdir(cwd);

type FixtureReply = (response: ServerResponse, body: string) => void;
let replies: FixtureReply[] = [];
const requests: string[] = [];
const serverErrors: Error[] = [];
const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed: unknown = JSON.parse(body);
    assert.ok(typeof parsed === "object" && parsed !== null && "model" in parsed);
    assert.equal(parsed.model, "fixture-model", "explicit model must override ambient defaults");
    requests.push(body);
    const reply = replies.shift();
    assert.ok(reply, "unexpected model request (including unrequested retry)");
    reply(response, body);
  })().catch((error: unknown) => {
    serverErrors.push(error instanceof Error ? error : new Error(String(error)));
    response.writeHead(500).end("fixture failed");
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-not-secret",
        models: [{ id: "fixture-model", contextWindow: 32_768, maxTokens: 4096 }],
      },
    },
  }),
);
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "models-store.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const model = runtime.getModel("fixture", "fixture-model");
assert.ok(model, "configured local model must be available");
const loader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Execute the user's task with the supplied coding tools.",
  getSystemPromptSource(): undefined {
    // The in-memory system prompt has no source file.
  },
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {
    /* The fixture has no discoverable resources. */
  },
  async reload() {
    /* All fixture resources are supplied in memory. */
  },
};

function stream(response: ServerResponse, delta: unknown, finishReason: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", ...chunk })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
const text =
  (value: string): FixtureReply =>
  (response) =>
    stream(response, { content: value }, "stop");
const tool =
  (name: string, args: Record<string, unknown>): FixtureReply =>
  (response) =>
    stream(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    );

async function withSession(
  run: (session: AgentSession, events: AgentSessionEvent[]) => Promise<void>,
): Promise<void> {
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["read", "write", "edit", "bash"],
  });
  const events: AgentSessionEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  try {
    await run(session, events);
    assert.equal(replies.length, 0, "all expected model exchanges must occur");
    assert.deepEqual(serverErrors, []);
  } finally {
    await session.abort();
    unsubscribe();
    session.dispose();
  }
}

function assistantStops(session: AgentSession): string[] {
  return session.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.stopReason);
}

async function waitUntil(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await delay(20);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await waitUntil(async () => !isAlive(pid), "shell descendant termination after abort");
}

function assertAbortedEvents(events: AgentSessionEvent[]): void {
  assert.ok(events.some((event) => event.type === "tool_execution_end" && event.isError));
  assert.equal(events.at(-1)?.type, "agent_settled");
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function readChildPid(): Promise<number | undefined> {
  try {
    const value = Number(await readFile(join(cwd, "child.pid"), "utf8"));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

const settingsBefore = await readFile(join(agentDir, "settings.json"), "utf8");
try {
  await withSession(async (session, events) => {
    replies = [
      tool("write", { path: "result.txt", content: "first\n" }),
      tool("edit", { path: "result.txt", oldText: "first", newText: "second" }),
      tool("read", { path: "result.txt" }),
      tool("bash", { command: "cat result.txt > shell-result.txt" }),
      text("Tools finished."),
    ];
    await session.prompt("Create, edit, read and copy result.txt.");
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "second\n");
    assert.equal(await readFile(join(cwd, "shell-result.txt"), "utf8"), "second\n");
    assert.equal(session.getLastAssistantText(), "Tools finished.");
    assert.ok(
      events.some(
        (event) =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      ),
    );
    const ends = events.filter((event) => event.type === "tool_execution_end");
    assert.deepEqual(
      ends.map((event) => event.toolName),
      ["write", "edit", "read", "bash"],
    );
    assert.ok(ends.every((event) => !event.isError));
    assert.equal(events.at(-1)?.type, "agent_settled");
    replies = [
      (response, body) => {
        assert.ok(
          body.includes("Tools finished."),
          "next prompt must include preceding conversation",
        );
        text("Continued.")(response, body);
      },
    ];
    await session.prompt("Continue the same session.");
    assert.equal(session.getLastAssistantText(), "Continued.");
    assert.equal(events.filter((event) => event.type === "agent_settled").length, 2);
    assert.ok(assistantStops(session).every((reason) => reason === "stop" || reason === "toolUse"));
  });
  console.log(
    "PASS: headless built-in write/edit/read/bash, streamed events, same-session continuation",
  );

  await withSession(async (session, events) => {
    const held = Promise.withResolvers<ServerResponse>();
    replies = [
      (response) => held.resolve(response),
      (response, body) => {
        assert.ok(body.includes("New instruction: preserve the original file."));
        text("Steering processed.")(response, body);
      },
    ];
    const pending = session.prompt("Start the initial turn.");
    // Attach the rejection handler immediately while coordinating with the endpoint.
    const completion = pending.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const heldResponse = await held.promise;
    await session.steer("New instruction: preserve the original file.");
    assert.equal(
      requests.at(-1)?.includes("New instruction:"),
      false,
      "acceptance is not delivery",
    );
    text("Initial answer.")(heldResponse, "");
    const result = await completion;
    if (!result.ok) throw result.error;
    assert.equal(session.getLastAssistantText(), "Steering processed.");
    assert.equal(events.at(-1)?.type, "agent_settled");
  });
  console.log("PASS: steering is queued during inference and delivered on the next model turn");

  await withSession(async (session, events) => {
    replies = [
      tool("bash", {
        command:
          "touch tool-started; while [ ! -f release-tool ]; do sleep 0.02; done; echo finished > tool-finished",
      }),
      (response, body) => {
        assert.ok(body.includes("Instruction queued while the tool was running."));
        text("Tool completed before steering.")(response, body);
      },
    ];
    const completion = session
      .prompt("Run a command before processing additional instructions.")
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitUntil(async () => {
      try {
        await readFile(join(cwd, "tool-started"));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    }, "the tool to reach its controlled barrier");
    await session.steer("Instruction queued while the tool was running.");
    assert.ok(!events.some((event) => event.type === "tool_execution_end"));
    await writeFile(join(cwd, "release-tool"), "continue");
    const result = await completion;
    if (!result.ok) throw result.error;
    assert.equal(await readFile(join(cwd, "tool-finished"), "utf8"), "finished\n");
    assert.ok(events.some((event) => event.type === "tool_execution_end" && !event.isError));
    assert.equal(session.getLastAssistantText(), "Tool completed before steering.");
  });
  console.log(
    "PASS: steering during a running tool preserves the command and reaches the next model request",
  );

  await withSession(async (session) => {
    const before = requests.length;
    replies = [
      (response) =>
        response.writeHead(429, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "fixture quota exhausted", type: "rate_limit_error" },
          }),
        ),
    ];
    // Pi reports this in session state; a resolved prompt is not evidence of success.
    await session.prompt("Exercise a rate limit without retry.");
    assert.equal(requests.length - before, 1);
    assert.deepEqual(assistantStops(session), ["error"]);
  });
  console.log("PASS: HTTP 429 has no retry; prompt resolves with an assistant error outcome");

  await withSession(async (session, events) => {
    replies = [
      tool("bash", {
        command: 'sleep 120 & child=$!; printf \'%s\' "$child" > child.pid; wait "$child"',
      }),
    ];
    const completion = session.prompt("Run a long command.").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let pid: number | undefined;
    try {
      await waitUntil(async () => {
        pid = await readChildPid();
        return pid !== undefined;
      }, "the actual shell descendant");
      assert.ok(pid);
      process.kill(pid, 0);
      await session.abort();
      const result = await completion;
      if (!result.ok) throw result.error;
      await waitForProcessExit(pid);
      pid = undefined; // The observed process has exited; do not retain its PID for cleanup.
      assertAbortedEvents(events);
    } finally {
      await session.abort();
      if (pid) killIfAlive(pid);
    }
  });
  console.log("PASS: abort terminates the observed shell descendant and settles the session");
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), settingsBefore);
  console.log("PASS: isolated ambient settings remain unchanged");
  console.log(
    "LIMIT: scripted endpoint only; real Ollama/LM Studio models and Relay policy mapping remain unqualified",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
