import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { PiAdapter } from "../src/adapters/pi.js";
import { MAX_PI_WORKER_EVENT_BYTES, parsePiWorkerLine, readBoundedLines } from "../src/adapters/pi-protocol.js";
import { supervisePiWorker } from "../src/adapters/pi-supervisor.js";
import { supportsPiNodeVersion } from "../src/adapters/pi-worker.js";
import type { AdapterEvent, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import type { ResolvedRoute, StartInvocationRequest } from "../src/contract.js";
import { BridgeError } from "../src/errors.js";

type FixtureRequest = {
  readonly messages?: readonly { readonly role?: string; readonly content?: unknown }[];
};
type FixtureReply = (response: ServerResponse, request: FixtureRequest) => void;

type Fixture = {
  readonly modelFiles: { authPath: string; modelsPath: string; modelsStorePath: string };
  readonly root: string;
  readonly requests: FixtureRequest[];
  readonly errors: Error[];
  setReplies(replies: readonly FixtureReply[]): void;
  close(): Promise<void>;
};

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-test-"));
  const agentDir = join(root, "agent");
  const workingDirectory = join(root, "work");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
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
      assert.ok(reply, "unexpected Pi model request (including a retry)");
      reply(response, parsed);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500).end("fixture failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const modelFiles = {
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
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
    root,
    requests,
    errors,
    setReplies(next) {
      replies = [...next];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function stream(response: ServerResponse, delta: Record<string, unknown>, finishReason: string): void {
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
  return (response) => stream(response, { content: text }, "stop");
}

function bashReply(command: string): FixtureReply {
  return (response) =>
    stream(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: "call-supervised-bash",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command }) },
          },
        ],
      },
      "tool_calls",
    );
}

function runContext(
  workingDirectory: string,
  options?: { readonly input?: string; readonly interactionStrategy?: "deny" | "unattended" },
): { context: AdapterRunContext; events: AdapterEvent[]; partials: Partial<AdapterRunResult>[] } {
  const events: AdapterEvent[] = [];
  const partials: Partial<AdapterRunResult>[] = [];
  const request: StartInvocationRequest = {
    selector: {
      provider: "fixture",
      model: "fixture-model",
      via: "pi",
      requiredCapabilities: ["core.input.text", "core.output.text"],
    },
    input: [{ type: "text", text: options?.input ?? "Complete the task." }],
    workingDirectory,
    interactionStrategy: options?.interactionStrategy ?? "unattended",
    requestedPolicy: {
      minimumAssurance: "none",
      filesystem: "inherit",
      commands: "allow",
      network: "allow",
    },
  };
  const route: ResolvedRoute = {
    routeId: "fixture:fixture-model",
    adapter: "pi",
    harnessVersion: "0.87.1",
    authenticationMode: "none",
    provider: "fixture",
    model: "fixture-model",
    via: "pi",
    capabilities: [],
    qualification: [],
  };
  return {
    events,
    context: {
      invocationId: "test-pi-worker",
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
    partials,
  };
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await delay(20);
  }
  assert.fail(`Pi shell descendant ${pid} remained alive after worker completion.`);
}

test("Pi worker drains fast shell output, cleans inherited-pipe descendants, and frames Unicode", async () => {
  const fixture = await startFixture();
  const stdout = `stdout-begin-${"o".repeat(17_000)}-stdout-end`;
  const stderr = `stderr-begin-${"e".repeat(17_000)}-stderr-end`;
  const command = [
    `printf '%s\\n' '${stdout}'`,
    `printf '%s\\n' '${stderr}' >&2`,
    "(sleep 60) &",
    "printf '%s\\n' \"$!\" > descendant.pid",
  ].join("\n");
  const finalText = `${"雪界".repeat(8_000)}${'"\\'.repeat(1_000)}`;
  fixture.setReplies([
    bashReply(command),
    (response, request) => {
      const toolMessages = (request.messages ?? []).filter((message) => message.role === "tool");
      assert.ok(
        toolMessages.some((message) =>
          String(message.content).includes("stdout-end") && String(message.content).includes("stderr-end"),
        ),
        "Pi's subsequent model request must contain both fully drained shell streams",
      );
      textReply(finalText)(response, request);
    },
  ]);
  const { context, events } = runContext(join(fixture.root, "work"));
  const adapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  let descendantPid: number | undefined;
  try {
    const result = await adapter.run(context);
    descendantPid = Number(await readFile(join(fixture.root, "work", "descendant.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2, "Pi must not retry the model request");
    assert.deepEqual(result.content, [{ type: "text", text: finalText }]);
    assert.equal(
      events
        .filter((event) => event.category === "output")
        .flatMap((event) => event.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
      finalText,
      "streamed output frames must preserve the exact large Unicode answer",
    );
    for (const event of events) {
      assert.ok(
        Buffer.byteLength(JSON.stringify({ type: "event", event }), "utf8") < MAX_PI_WORKER_EVENT_BYTES,
        "every streamed event must fit the bounded worker JSONL frame",
      );
    }
    assert.equal(result.usage?.inputTokens, 14);
    assert.equal(result.observedIdentity.harnessVersion.evidence, "verified");
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The supervisor normally reaps this before returning.
      }
    }
    await fixture.close();
  }
});

test("Pi's Bash output truncation is bounded and keeps the complete stream tail", async () => {
  const fixture = await startFixture();
  const filler = "x".repeat(1024);
  const command = [
    `for i in {1..600}; do printf '%s\\n' '${filler}'; done`,
    "printf '%s\\n' 'STDOUT-TAIL-UNIQUE'",
    `for i in {1..600}; do printf '%s\\n' '${filler}' >&2; done`,
    "printf '%s\\n' 'STDERR-TAIL-UNIQUE' >&2",
  ].join("\n");
  let reportedToolOutput = "";
  fixture.setReplies([
    bashReply(command),
    (response, request) => {
      const toolMessages = (request.messages ?? []).filter((message) => message.role === "tool");
      reportedToolOutput = toolMessages.map((message) => String(message.content)).join("\n");
      textReply("Large output drained.")(response, request);
    },
  ]);
  const { context } = runContext(join(fixture.root, "work"));
  const adapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  try {
    const result = await adapter.run(context);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2);
    assert.ok(reportedToolOutput.includes("STDERR-TAIL-UNIQUE"));
    assert.ok(reportedToolOutput.includes("Full output:"));
    assert.ok(
      reportedToolOutput.includes("50.0KB limit") || reportedToolOutput.includes("Showing last"),
      "Pi's built-in Bash renderer must describe its documented output truncation",
    );
    assert.ok(
      Buffer.byteLength(reportedToolOutput, "utf8") < 60 * 1024,
      "Pi must keep the model-facing Bash result bounded while preserving its tail",
    );
    assert.deepEqual(result.content, [{ type: "text", text: "Large output drained." }]);
  } finally {
    await fixture.close();
  }
});

test("the gated Pi shell runner refuses execution before registration and dies with its ACKed group", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-gate-"));
  const runnerPath = fileURLToPath(new URL("../src/adapters/pi-tool-runner.js", import.meta.url));
  const shell = process.platform === "darwin" ? "/bin/bash" : "/bin/bash";
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" };
  const runnerStart = (requestId: string, command: string) => ({
    type: "start",
    requestId,
    shell,
    shellArgs: ["-c"],
    commandTransport: "argv",
    command,
    cwd: root,
    env,
  });
  const closed = (child: ChildProcess) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  let before: ChildProcess | undefined;
  let beforeClosed: ReturnType<typeof closed> | undefined;
  let after: ChildProcess | undefined;
  let afterClosed: ReturnType<typeof closed> | undefined;
  try {
    const beforeMarker = join(root, "before-ack.marker");
    before = spawn(process.execPath, [runnerPath], {
      cwd: root,
      env,
      detached: true,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    beforeClosed = closed(before);
    before.stdin?.write(
      `${JSON.stringify(runnerStart("before-ack", `printf executed > '${beforeMarker}'`))}\n`,
    );
    before.stdin?.end();
    const beforeExit = await Promise.race([
      beforeClosed,
      delay(3_000).then(() => {
        throw new Error("The gated runner did not exit when registration control closed.");
      }),
    ]);
    assert.notEqual(beforeExit.code, 0);
    await assert.rejects(access(beforeMarker), { code: "ENOENT" });

    const marker = join(root, "after-ack.marker");
    const pidFile = join(root, "after-ack.pid");
    after = spawn(process.execPath, [runnerPath], {
      cwd: root,
      env,
      detached: true,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    assert.ok(after.pid);
    afterClosed = closed(after);
    const resultStream = after.stdio[3];
    assert.ok(resultStream && "read" in resultStream);
    const resultLines = readBoundedLines(resultStream as AsyncIterable<Buffer>, 4096);
    after.stdin?.write(
      `${JSON.stringify(
        runnerStart(
          "after-ack",
          `printf executed > '${marker}'\n(sleep 60) &\nprintf '%s\\n' "$!" > '${pidFile}'`,
        ),
      )}\n{"type":"registered"}\n`,
    );
    const resultLine = await Promise.race([
      resultLines.next(),
      delay(3_000).then(() => {
        throw new Error("The ACKed helper did not report the shell's exit.");
      }),
    ]);
    assert.equal(resultLine.done, false);
    assert.equal((JSON.parse(resultLine.value) as { exitCode: number }).exitCode, 0);
    await access(marker);
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    try {
      process.kill(-after.pid, "SIGKILL");
    } catch {
      // The group may exit between reading its result and delivering cleanup.
    }
    after.stdin?.end();
    await afterClosed;
    await waitForProcessExit(descendantPid);
  } finally {
    for (const child of [after, before]) {
      if (child?.pid !== undefined && child.pid > 1) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group may already have exited.
        }
        child.stdin?.destroy();
      }
    }
    await Promise.all(
      [afterClosed, beforeClosed]
        .filter((pending): pending is ReturnType<typeof closed> => pending !== undefined)
        .map((pending) => Promise.race([pending, delay(2_000).then(() => undefined)])),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed worker output cleans an ACKed shell group and preserves partial text", async () => {
  const fixture = await startFixture();
  const fakeWorkerPath = join(fixture.root, "malformed-worker.mjs");
  const helperPath = fileURLToPath(new URL("../src/adapters/pi-tool-runner.js", import.meta.url));
  const requestId = "malformed-protocol-test";
  const script = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const startLine = await input.next();
if (startLine.done) process.exit(70);
const start = JSON.parse(startLine.value);
const runner = spawn(process.execPath, [${JSON.stringify(helperPath)}], {
  cwd: start.workingDirectory,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  detached: true,
  stdio: ["pipe", "ignore", "ignore", "pipe"],
});
await writeFile(start.workingDirectory + "/malformed-helper.pid", String(runner.pid));
const requestId = ${JSON.stringify(requestId)};
runner.stdin.write(JSON.stringify({
  type: "start",
  requestId,
  shell: "/bin/bash",
  shellArgs: ["-c"],
  commandTransport: "argv",
  command: "(sleep 60) &\\nprintf '%s\\\\n' \\\"$!\\\" > malformed-child.pid",
  cwd: start.workingDirectory,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "event", event: { category: "output", content: [{ type: "text", text: "partial-before-protocol-error" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_process_started", requestId, processGroupId: runner.pid }) + "\\n");
const registered = await input.next();
if (registered.done || JSON.parse(registered.value).type !== "tool_process_registered") process.exit(71);
runner.stdin.write("{\\"type\\":\\"registered\\"}\\n");
const result = createInterface({ input: runner.stdio[3] })[Symbol.asyncIterator]();
await result.next();
process.stdout.write("not-json\\n");
await new Promise(() => {});
`;
  await writeFile(fakeWorkerPath, script);
  const { context, events, partials } = runContext(join(fixture.root, "work"));
  const configuration = {
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" as const },
    modelFiles: fixture.modelFiles,
    tools: ["bash"] as const,
  };
  let descendantPid: number | undefined;
  let helperGroupId: number | undefined;
  try {
    await assert.rejects(
      supervisePiWorker(context, configuration, fakeWorkerPath),
      (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
    );
    descendantPid = Number(await readFile(join(fixture.root, "work", "malformed-child.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
    assert.ok(events.some((event) => event.content?.some((part) => part.type === "text" && part.text === "partial-before-protocol-error")));
    assert.ok(partials.some((partial) => partial.content?.some((part) => part.type === "text" && part.text.includes("partial-before-protocol-error"))));
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The supervisor normally kills this child before rejecting.
      }
    }
    try {
      helperGroupId = Number(await readFile(join(fixture.root, "work", "malformed-helper.pid"), "utf8"));
      if (Number.isSafeInteger(helperGroupId) && helperGroupId > 1) {
        process.kill(-helperGroupId, "SIGKILL");
      }
    } catch {
      // The fake worker may fail before creating a helper group.
    }
    await fixture.close();
  }
});

test("Pi SDK stays optional, version checks are explicit, and failed worker spawn is handled", async () => {
  assert.equal(supportsPiNodeVersion("22.18.9"), false);
  assert.equal(supportsPiNodeVersion("22.19.0"), true);
  assert.equal(supportsPiNodeVersion("23.0.0"), true);
  assert.equal(supportsPiNodeVersion("21.99.99"), false);
  assert.ok(supportsPiNodeVersion(process.versions.node), "the fixture needs the qualified Pi Node runtime");

  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-optional-"));
  const loaderPath = join(root, "block-pi.mjs");
  await writeFile(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {\n  if (specifier === "@earendil-works/pi-coding-agent") { const error = new Error("optional Pi dependency omitted"); error.code = "ERR_MODULE_NOT_FOUND"; throw error; }\n  return nextResolve(specifier, context);\n}\n`,
  );
  const workerPath = fileURLToPath(new URL("../src/adapters/pi-worker.js", import.meta.url));
  const start = {
    type: "start",
    protocolVersion: 1,
    workingDirectory: root,
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: {
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "models-store.json"),
    },
    prompt: "Do not run without the optional package.",
    tools: ["read"],
  };
  const worker = spawn(process.execPath, ["--no-warnings", "--loader", loaderPath, workerPath], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(worker.stdin && worker.stdout);
  const workerClosed = new Promise<{ code: number | null }>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code) => resolve({ code }));
  });
  worker.stdin.write(`${JSON.stringify(start)}\n`);
  worker.stdin.end();
  let unavailableTerminal: ReturnType<typeof parsePiWorkerLine> | undefined;
  for await (const line of readBoundedLines(worker.stdout, MAX_PI_WORKER_EVENT_BYTES)) {
    const output = parsePiWorkerLine(line);
    if (output.type === "terminal") {
      unavailableTerminal = output;
    }
  }
  const workerExit = await workerClosed;
  assert.equal(workerExit.code, 0);
  assert.ok(unavailableTerminal?.type === "terminal");
  assert.equal(unavailableTerminal.status, "failed");
  assert.equal(unavailableTerminal.failure?.code, "pi_sdk_unavailable");
  assert.equal(unavailableTerminal.observedIdentity.harnessVersion.evidence, "unverified");

  const modules = [
    fileURLToPath(new URL("../src/index.js", import.meta.url)),
    fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    fileURLToPath(new URL("../src/adapters/claude.js", import.meta.url)),
    fileURLToPath(new URL("../src/adapters/codex.js", import.meta.url)),
  ].map((path) => pathToFileURL(path).href);
  const smokeCode = `await Promise.all(${JSON.stringify(modules)}.map((url) => import(url)));`;
  const smoke = spawn(
    process.execPath,
    ["--no-warnings", "--loader", loaderPath, "--input-type=module", "--eval", smokeCode],
    { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, stdio: "ignore" },
  );
  const smokeExit = await new Promise<number | null>((resolve, reject) => {
    smoke.once("error", reject);
    smoke.once("close", resolve);
  });
  assert.equal(smokeExit, 0, "core CLI and existing adapters must import without the optional Pi package");

  const missingDirectory = join(root, "does-not-exist");
  const { context } = runContext(missingDirectory);
  const adapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: start.modelFiles,
    tools: ["read"],
  });
  await assert.rejects(
    adapter.run(context),
    (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
  );

  const policyContext = runContext(root).context;
  const readOnlyAdapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: start.modelFiles,
    tools: ["read", "write", "bash"],
  });
  await assert.rejects(
    readOnlyAdapter.run({
      ...policyContext,
      request: {
        ...policyContext.request,
        requestedPolicy: { ...policyContext.request.requestedPolicy, filesystem: "read-only" },
      },
    }),
    (error: unknown) => error instanceof BridgeError && error.code === "unsupported_capability",
  );
  assert.deepEqual(await adapter.discover(), [], "the unqualified internal runtime stays undiscovered");
  await rm(root, { recursive: true, force: true });
});
