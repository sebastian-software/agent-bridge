import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  Adapter,
  AdapterEvent,
  AdapterRunContext,
  AdapterRunResult,
  AdapterSendInputContext,
} from "../src/adapters/types.js";
import type { ResolvedRoute, StartInvocationRequest } from "../src/contract.js";
import type { BrokerPaths } from "../src/paths.js";

import { PiContinuationStore } from "../src/adapters/pi-continuation.js";
import {
  MAX_PI_PENDING_STEERING_INPUTS,
  MAX_PI_WORKER_EVENT_BYTES,
  parsePiWorkerControl,
  parsePiWorkerLine,
  PI_WORKER_PROTOCOL_VERSION,
  type PiWorkerStart,
  readBoundedLines,
} from "../src/adapters/pi-protocol.js";
import { PiSteeringPort } from "../src/adapters/pi-steering.js";
import { supervisePiWorker } from "../src/adapters/pi-supervisor.js";
import { supportsPiNodeVersion, WorkerOutput } from "../src/adapters/pi-worker.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Broker } from "../src/broker.js";
import { BridgeError } from "../src/errors.js";

type FixtureRequest = {
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
};
type FixtureReply = (response: ServerResponse, request: FixtureRequest) => void;

type Fixture = {
  readonly modelFiles: { authPath: string; modelsPath: string; modelsStorePath: string };
  readonly root: string;
  readonly requests: FixtureRequest[];
  readonly errors: Error[];
  setReplies: (replies: readonly FixtureReply[]) => void;
  close: () => Promise<void>;
};

async function childClosed(child: ChildProcess) {
  return new Promise<{ code: null | number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

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
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

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

function bashReply(
  command: string,
  options: { readonly content?: string; readonly timeoutSeconds?: number } = {},
): FixtureReply {
  return (response) => {
    stream(
      response,
      {
        ...(options.content === undefined ? {} : { content: options.content }),
        tool_calls: [
          {
            index: 0,
            id: "call-supervised-bash",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command,
                ...(options.timeoutSeconds === undefined
                  ? {}
                  : { timeout: options.timeoutSeconds }),
              }),
            },
          },
        ],
      },
      "tool_calls",
    );
  };
}

function runContext(
  workingDirectory: string,
  options?: { readonly input?: string; readonly interactionStrategy?: "deny" | "unattended" },
): {
  context: AdapterRunContext;
  events: AdapterEvent[];
  partials: Array<Partial<AdapterRunResult>>;
  controller: AbortController;
} {
  const events: AdapterEvent[] = [];
  const partials: Array<Partial<AdapterRunResult>> = [];
  const controller = new AbortController();
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
      signal: controller.signal,
      async emit(event) {
        events.push(event);
      },
      reportPartial(result) {
        partials.push(result);
      },
      terminationGraceMs: 1000,
    },
    partials,
    controller,
  };
}

function steeringInput(
  context: AdapterRunContext,
  inputId: string,
  text: string,
  signal = new AbortController().signal,
): AdapterSendInputContext {
  return {
    invocationId: context.invocationId,
    route: context.route,
    inputId,
    content: [{ type: "text", text }],
    signal,
  };
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
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

async function waitForFile(path: string, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function readPidFile(path: string): Promise<number | undefined> {
  try {
    const value = Number(await readFile(path, "utf8"));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

test("Pi worker protocol rejects process group IDs that could signal unrelated processes", () => {
  assert.throws(() =>
    parsePiWorkerLine(
      JSON.stringify({ type: "tool_process_started", requestId: "unsafe", processGroupId: 1 }),
    ),
  );
  assert.throws(() =>
    parsePiWorkerControl({
      type: "tool_process_registered",
      requestId: "unsafe",
      processGroupId: 1,
    }),
  );
});

test("Pi worker protocol rejects malformed steering controls and acknowledgements", () => {
  assert.throws(() => parsePiWorkerControl({ type: "steer", inputId: "input-1", text: "" }));
  assert.throws(() =>
    parsePiWorkerLine(
      JSON.stringify({
        type: "steer_ack",
        inputId: "input-1",
        accepted: true,
        message: "accepted ACKs cannot include a rejection message",
      }),
    ),
  );
});

test("Pi worker reports malformed or missing start messages without waiting for a finish handshake", async () => {
  const workerPath = fileURLToPath(new URL("../src/adapters/pi-worker.js", import.meta.url));
  for (const [description, initialInput] of [
    ["missing", ""],
    ["malformed", "not-json\n"],
  ] as const) {
    const child = spawn(process.execPath, [workerPath], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output: string[] = [];
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output.push(chunk);
    });
    const closed = childClosed(child);
    const timeout = new AbortController();
    try {
      child.stdin?.end(initialInput);
      const result = await Promise.race([
        closed,
        delay(3000, undefined, { signal: timeout.signal }).then(() => {
          child.kill("SIGKILL");
          throw new Error(`Pi worker hung after a ${description} start message.`);
        }),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      const lines = output
        .join("")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly type: string;
              readonly status?: string;
            },
        );
      assert.ok(lines.some((line) => line.type === "settling"));
      assert.ok(
        lines.some((line) => line.type === "terminal" && line.status === "failed"),
        `Pi worker must report the ${description} start as a failure`,
      );
    } finally {
      timeout.abort();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
});

test("Pi steering port cancels queued delivery before the worker is ready", async () => {
  const port = new PiSteeringPort();
  const controller = new AbortController();
  const pending = port.send(
    "input-cancelled",
    [{ type: "text", text: "wait for Pi" }],
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  port.close();
});

test("Pi steering port rejects premature ACKs and waits for the SDK ACK after sending", async () => {
  const port = new PiSteeringPort();
  const pending = port.send(
    "input-ack",
    [{ type: "text", text: "wait for the native boundary" }],
    new AbortController().signal,
  );
  assert.equal(port.acknowledge("input-ack", true), false);
  assert.equal(port.acknowledge("unknown-input", true), false);

  let senderStarted!: () => void;
  let releaseSender!: () => void;
  const started = new Promise<void>((resolve) => {
    senderStarted = resolve;
  });
  const senderDrain = new Promise<void>((resolve) => {
    releaseSender = resolve;
  });
  port.setSender(async () => {
    senderStarted();
    await senderDrain;
  });
  await started;
  assert.equal(port.acknowledge("input-ack", true), true);
  assert.deepEqual(await pending, { boundary: "next-supported-boundary" });
  releaseSender();
  await port.seal();
  port.close();
});

test("Pi steering port expires a sent input on cancellation and ignores its late ACK", async () => {
  const port = new PiSteeringPort();
  const controller = new AbortController();
  let senderStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    senderStarted = resolve;
  });
  const pending = port.send(
    "input-cancelled-after-send",
    [{ type: "text", text: "cancel after writing the control frame" }],
    controller.signal,
  );
  port.setSender(async () => {
    senderStarted();
  });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  port.close();
  assert.equal(port.acknowledge("input-cancelled-after-send", true), true);
  assert.equal(port.acknowledge("unknown-after-close", true), false);
});

test("Pi steering port bounds pending inputs before a worker sender is available", async () => {
  const port = new PiSteeringPort();
  const pending = Array.from({ length: MAX_PI_PENDING_STEERING_INPUTS }, async (_, index) =>
    port.send(
      `input-${index}`,
      [{ type: "text", text: `queued-${index}` }],
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    port.send("input-overflow", [{ type: "text", text: "overflow" }], new AbortController().signal),
    (error: unknown) => error instanceof BridgeError && error.code === "invocation_conflict",
  );
  port.close();
  await Promise.allSettled(pending);
});

test("fire-and-forget worker output observes overflow and closed-pipe rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  let releaseDrain: (() => void) | undefined;
  const blockedDrain = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const overflowFailures: Error[] = [];
  const overflowOutput = new WorkerOutput({
    write: () => false,
    async waitForDrain() {
      await blockedDrain;
    },
  });
  overflowOutput.setFailureHandler((error) => overflowFailures.push(error));

  const message = {
    type: "event",
    event: {
      category: "output",
      content: [{ type: "text", text: "x".repeat(60 * 1024) }],
    },
  } as const;
  assert.ok(Buffer.byteLength(JSON.stringify(message), "utf8") < MAX_PI_WORKER_EVENT_BYTES);

  try {
    for (let index = 0; index < 600; index += 1) {
      void overflowOutput.enqueue(message);
    }
    assert.match(overflowFailures[0]?.message ?? "", /bounded transport limit/);
    releaseDrain?.();
    await assert.rejects(overflowOutput.drain(), /bounded transport limit/);

    const closedFailures: Error[] = [];
    const closedOutput = new WorkerOutput({
      write() {
        throw new Error("stdout closed");
      },
      async waitForDrain() {},
    });
    closedOutput.setFailureHandler((error) => closedFailures.push(error));
    void closedOutput.enqueue(message);
    await assert.rejects(closedOutput.drain(), /stdout closed/);
    assert.match(closedFailures[0]?.message ?? "", /stdout closed/);

    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    releaseDrain?.();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("Pi worker drains fast shell output, cleans inherited-pipe descendants, and frames Unicode", async () => {
  const fixture = await startFixture();
  const promptMarkers = [
    "HOSTILE_GLOBAL_SYSTEM_MARKER",
    "HOSTILE_GLOBAL_APPEND_MARKER",
    "HOSTILE_PROJECT_SYSTEM_MARKER",
    "HOSTILE_PROJECT_APPEND_MARKER",
  ] as const;
  await mkdir(join(fixture.root, "work", ".pi"), { recursive: true });
  await writeFile(join(fixture.root, "agent", "SYSTEM.md"), promptMarkers[0]);
  await writeFile(join(fixture.root, "agent", "APPEND_SYSTEM.md"), promptMarkers[1]);
  await writeFile(join(fixture.root, "work", ".pi", "SYSTEM.md"), promptMarkers[2]);
  await writeFile(join(fixture.root, "work", ".pi", "APPEND_SYSTEM.md"), promptMarkers[3]);
  const stdout = `stdout-begin-${"o".repeat(17_000)}-stdout-end`;
  const stderr = `stderr-begin-${"e".repeat(17_000)}-stderr-end`;
  const command = [
    `printf '%s\\n' '${stdout}'`,
    `printf '%s\\n' '${stderr}' >&2`,
    "(sleep 60) &",
    "printf '%s\\n' \"$!\" > descendant.pid",
  ].join("\n");
  const finalText = `${"雪界".repeat(8000)}${'"\\'.repeat(1000)}`;
  fixture.setReplies([
    bashReply(command),
    (response, request) => {
      const toolMessages = (request.messages ?? []).filter((message) => message.role === "tool");
      assert.ok(
        toolMessages.some(
          (message) =>
            String(message.content).includes("stdout-end") &&
            String(message.content).includes("stderr-end"),
        ),
        "Pi's subsequent model request must contain both fully drained shell streams",
      );
      textReply(finalText)(response, request);
    },
  ]);
  const { context, events } = runContext(join(fixture.root, "work"));
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: fixture.root }) },
  );
  let descendantPid: number | undefined;
  try {
    const result = await adapter.run(context);
    descendantPid = Number(await readFile(join(fixture.root, "work", "descendant.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 2, "Pi must not retry the model request");
    const observedRequests = JSON.stringify(fixture.requests);
    for (const marker of promptMarkers) {
      assert.equal(
        observedRequests.includes(marker),
        false,
        `${marker} must not enter model context`,
      );
    }
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
        Buffer.byteLength(JSON.stringify({ type: "event", event }), "utf8") <
          MAX_PI_WORKER_EVENT_BYTES,
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
    await adapter.dispose();
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
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: fixture.root }) },
  );
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
    await adapter.dispose();
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
  let before: ChildProcess | undefined;
  let beforeClosed: ReturnType<typeof childClosed> | undefined;
  let after: ChildProcess | undefined;
  let afterClosed: ReturnType<typeof childClosed> | undefined;
  try {
    const beforeMarker = join(root, "before-ack.marker");
    before = spawn(process.execPath, [runnerPath], {
      cwd: root,
      env,
      detached: true,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    beforeClosed = childClosed(before);
    before.stdin?.write(
      `${JSON.stringify(runnerStart("before-ack", `printf executed > '${beforeMarker}'`))}\n`,
    );
    before.stdin?.end();
    const beforeExit = await Promise.race([
      beforeClosed,
      delay(3000).then(() => {
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
    afterClosed = childClosed(after);
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
      delay(3000).then(() => {
        throw new Error("The ACKed helper did not report the shell's exit.");
      }),
    ]);
    assert.equal(resultLine.done, false);
    assert.equal((JSON.parse(resultLine.value) as { exitCode: number }).exitCode, 0);
    await access(marker);
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    // Simulate worker-parent loss after the helper ACK: its own EOF watcher
    // must kill the detached group, including the background descendant.
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
        .filter((pending): pending is ReturnType<typeof childClosed> => pending !== undefined)
        .map(async (pending) => {
          await Promise.race([pending, delay(2000)]);
        }),
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
  command: "(sleep 60) &\\nprintf '%s\\\\n' \\"$!\\" > malformed-child.pid",
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
    descendantPid = Number(
      await readFile(join(fixture.root, "work", "malformed-child.pid"), "utf8"),
    );
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
    assert.ok(
      events.some((event) =>
        event.content?.some(
          (part) => part.type === "text" && part.text === "partial-before-protocol-error",
        ),
      ),
    );
    assert.ok(
      partials.some((partial) =>
        partial.content?.some(
          (part) => part.type === "text" && part.text.includes("partial-before-protocol-error"),
        ),
      ),
    );
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The supervisor normally kills this child before rejecting.
      }
    }
    try {
      helperGroupId = Number(
        await readFile(join(fixture.root, "work", "malformed-helper.pid"), "utf8"),
      );
      if (Number.isSafeInteger(helperGroupId) && helperGroupId > 1) {
        process.kill(-helperGroupId, "SIGKILL");
      }
    } catch {
      // The fake worker may fail before creating a helper group.
    }
    await fixture.close();
  }
});
test("Pi native steering queues FIFO while Bash continues and reaches the next model turn", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const startedPath = join(workingDirectory, "steering-started");
  const releasePath = join(workingDirectory, "release-steering");
  const finishedPath = join(workingDirectory, "steering-finished");
  let correctionRequests = 0;
  const replyForCorrections: FixtureReply = (response, request) => {
    correctionRequests += 1;
    const serialized = JSON.stringify(request.messages ?? []);
    const first = serialized.indexOf("first native correction");
    const second = serialized.indexOf("second native correction");
    if (second !== -1) {
      assert.ok(first !== -1, "the second correction must not arrive before the first");
      assert.ok(second > first, "Pi must retain FIFO steering order");
      stream(response, { content: "Both corrections received." }, "stop");
      return;
    }
    assert.ok(
      correctionRequests <= 2,
      "both accepted corrections must reach a subsequent model request",
    );
    bashReply("true")(response, request);
  };
  fixture.setReplies([
    bashReply(
      `touch steering-started\nwhile [ ! -f release-steering ]; do sleep 0.02; done\ntouch steering-finished`,
    ),
    replyForCorrections,
    replyForCorrections,
  ]);
  const { context, events, controller } = runContext(workingDirectory);
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      tools: ["read", "write", "edit", "bash"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: fixture.root }) },
  );
  const completion = adapter.run(context).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    const first = adapter
      .sendInput(steeringInput(context, "input-first", "first native correction"))
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitForFile(startedPath, "Pi Bash to reach its steering barrier");
    const second = adapter.sendInput(
      steeringInput(context, "input-second", "second native correction"),
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);
    if (!firstResult.ok) {
      throw firstResult.error;
    }
    assert.deepEqual(firstResult.value, { boundary: "next-supported-boundary" });
    assert.deepEqual(secondResult, { boundary: "next-supported-boundary" });
    assert.equal(
      events.some((event) => event.data?.phase === "tool_finished"),
      false,
    );
    await assert.rejects(access(finishedPath), { code: "ENOENT" });
    await writeFile(releasePath, "release");
    const timeout = new AbortController();
    const result = await Promise.race([
      completion,
      delay(10_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("Pi did not finish the steered turn within ten seconds.");
      }),
    ]).finally(() => {
      timeout.abort();
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(result.value.content, [{ type: "text", text: "Both corrections received." }]);
    await access(finishedPath);
    assert.equal(fixture.requests.length, correctionRequests + 1);
    assert.ok(correctionRequests >= 1 && correctionRequests <= 2);
    assert.deepEqual(fixture.errors, []);
  } finally {
    controller.abort();
    await writeFile(releasePath, "release").catch(() => {});
    const cleanupTimeout = new AbortController();
    await Promise.race([
      completion,
      delay(5000, undefined, { signal: cleanupTimeout.signal }),
    ]).finally(() => {
      cleanupTimeout.abort();
    });
    await adapter.dispose();
    await fixture.close();
  }
});

test(
  "Pi worker settles a premature control EOF during the finish handshake",
  { timeout: 15_000 },
  async () => {
    const fixture = await startFixture();
    const workingDirectory = join(fixture.root, "work");
    const home = join(fixture.root, "home");
    await mkdir(home, { recursive: true });
    fixture.setReplies([textReply("Finished before the host closed control.")]);
    const start: PiWorkerStart = {
      type: "start",
      protocolVersion: PI_WORKER_PROTOCOL_VERSION,
      workingDirectory,
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      prompt: "Reply with one short sentence. Do not call tools.",
      tools: ["read"],
    };
    const workerPath = fileURLToPath(new URL("../src/adapters/pi-worker.js", import.meta.url));
    const child = spawn(process.execPath, [workerPath], {
      cwd: workingDirectory,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        PI_OFFLINE: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outputs: Array<{
      readonly type?: string;
      readonly status?: string;
      readonly failure?: { readonly message?: string };
    }> = [];
    const stderr: string[] = [];
    let remainder = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      remainder += chunk;
      while (true) {
        const newline = remainder.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
        const output = JSON.parse(line) as (typeof outputs)[number];
        outputs.push(output);
        if (output.type === "settling" && child.stdin !== null && !child.stdin.writableEnded) {
          child.stdin.end();
        }
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
    const closed = childClosed(child);
    const timeout = new AbortController();
    assert.ok(child.stdin);
    child.stdin.write(`${JSON.stringify(start)}\n`);
    try {
      const result = await Promise.race([
        closed,
        delay(10_000, undefined, { signal: timeout.signal }).then(() => {
          child.kill("SIGKILL");
          throw new Error("Pi worker hung after the host closed control during settlement.");
        }),
      ]);
      assert.deepEqual(result, { code: 0, signal: null }, stderr.join(""));
      const terminal = outputs.find((output) => output.type === "terminal");
      assert.equal(terminal?.status, "failed");
      assert.match(
        terminal?.failure?.message ?? "",
        /control channel closed before the finish handshake/,
      );
      assert.deepEqual(fixture.errors, []);
    } finally {
      timeout.abort();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await fixture.close();
    }
  },
);

test("cancelling a live Pi Bash call rejects with identity partials and kills descendants", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const pidFile = join(workingDirectory, "cancel-child.pid");
  fixture.setReplies([
    bashReply(
      `(sleep 60) &\nprintf '%s\\n' "$!" > cancel-child.pid\nprintf before-cancel\nsleep 60`,
    ),
  ]);
  const { context, events, partials, controller } = runContext(workingDirectory);
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      tools: ["read", "write", "edit", "bash"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: fixture.root }) },
  );
  let descendantPid: number | undefined;
  const completion = adapter.run(context).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await waitForFile(pidFile, "a running descendant of Pi's Bash call");
    descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(events.some((event) => event.data?.phase === "tool_started"));
    controller.abort();
    const outcome = await Promise.race([
      completion,
      delay(5000).then(() => {
        throw new Error("Pi cancellation did not settle within five seconds.");
      }),
    ]);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error instanceof Error ? outcome.error.name : undefined, "AbortError");
    }
    assert.equal(fixture.requests.length, 1);
    assert.ok(
      partials.some(
        (partial) =>
          partial.observedIdentity?.harnessVersion.evidence === "verified" &&
          partial.observedIdentity.nativeSessionId.evidence === "reported",
      ),
      "identity observed before cancellation must remain in the partial outcome",
    );
    await waitForProcessExit(descendantPid);
  } finally {
    controller.abort();
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The supervisor normally kills this child before the run settles.
      }
    }
    await completion;
    await adapter.dispose();
    await fixture.close();
  }
});

test("broker invocation timeout records one timed_out outcome with Pi partial evidence and no descendants", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const pidFile = join(workingDirectory, "invocation-timeout-child.pid");
  const runnerPidFile = join(workingDirectory, "invocation-timeout-runner.pid");
  const partialText = "partial-before-invocation-timeout";
  fixture.setReplies([
    bashReply(
      `(sleep 60) &\nprintf '%s\\n' "$!" > invocation-timeout-child.pid\nprintf '%s\\n' "$PPID" > invocation-timeout-runner.pid\nprintf before-invocation-timeout\nsleep 60`,
      { content: partialText },
    ),
  ]);

  const piAdapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash"],
  });
  const descriptor = {
    routeId: "fixture:fixture-model",
    provider: "fixture",
    model: "fixture-model",
    efforts: ["low", "medium", "high"],
    via: "pi",
    adapter: "pi",
    harnessVersion: "0.87.1",
    authenticationMode: "none",
    capabilities: ["core.input.text", "core.output.text"],
    interactionStrategies: ["unattended"],
    assurance: "none",
    runtimeIdentityEvidence: "verified",
    readiness: "ready",
    qualification: [
      {
        qualificationId: "pi-worker-lifecycle-fixture",
        testedAt: "2026-09-29T00:00:00.000Z",
        claim: "Scripted Pi worker lifecycle fixture.",
      },
    ],
    diagnostics: [],
  } as const;
  const adapter: Adapter = {
    id: "pi",
    async discover() {
      return [descriptor];
    },
    resolvePolicy(request, route) {
      return piAdapter.resolvePolicy(request, route);
    },
    async run(context) {
      return piAdapter.run(context);
    },
  };
  const brokerRoot = join(fixture.root, "broker");
  const brokerPaths: BrokerPaths = {
    runtimeDirectory: join(brokerRoot, "run"),
    stateDirectory: join(brokerRoot, "state"),
    socketPath: join(brokerRoot, "run", "broker.sock"),
    stateFile: join(brokerRoot, "state", "state.json"),
  };
  const broker = new Broker(brokerPaths, {
    registry: new AdapterRegistry([adapter], {
      catalogPath: join(fixture.root, "catalog.json"),
      connectionsPath: join(fixture.root, "connections.json"),
    }),
  });
  let descendantPid: number | undefined;
  let runnerGroupId: number | undefined;
  try {
    await broker.initialize();
    const started = await broker.start({
      selector: {
        provider: "fixture",
        model: "fixture-model",
        via: "pi",
        requiredCapabilities: ["core.input.text", "core.output.text"],
      },
      input: [{ type: "text", text: "Start a long command and report its output." }],
      workingDirectory,
      interactionStrategy: "unattended",
      requestedPolicy: {
        minimumAssurance: "none",
        filesystem: "inherit",
        commands: "allow",
        network: "allow",
      },
      timeoutMs: 8000,
    });
    await waitForFile(pidFile, "a descendant of the invocation-timed-out Bash command");
    descendantPid = Number(await readFile(pidFile, "utf8"));
    runnerGroupId = await readPidFile(runnerPidFile);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(runnerGroupId !== undefined && runnerGroupId > 1);

    const terminal = await broker.wait(started.invocationId, 15_000);
    assert.equal(terminal.waited, true);
    assert.equal(terminal.state, "timed_out");
    const outcome = terminal.outcome as {
      readonly status?: string;
      readonly content?: unknown;
      readonly error?: { readonly code?: string };
      readonly observedIdentity?: {
        readonly harnessVersion?: { readonly evidence?: string };
        readonly nativeSessionId?: { readonly evidence?: string };
      };
    };
    assert.equal(outcome.status, "timed_out");
    assert.equal(outcome.error?.code, "timed_out");
    assert.ok(JSON.stringify(outcome.content).includes(partialText));
    assert.equal(outcome.observedIdentity?.harnessVersion?.evidence, "verified");
    assert.equal(outcome.observedIdentity?.nativeSessionId?.evidence, "reported");

    const events = (await broker.events({ invocationId: started.invocationId })).events;
    const terminalEvents = events.filter(
      (event) =>
        event.category === "lifecycle" &&
        ["cancelled", "failed", "interrupted", "succeeded", "timed_out"].includes(
          String(event.data?.state),
        ),
    );
    assert.equal(terminalEvents.length, 1, "the broker must persist exactly one terminal event");
    assert.equal(terminalEvents[0]?.data?.state, "timed_out");
    assert.ok(
      events.some(
        (event) =>
          event.category === "output" &&
          event.content?.some((part) => part.type === "text" && part.text.includes(partialText)),
      ),
      "the streamed partial text should remain visible in invocation events",
    );
    await waitForProcessExit(descendantPid);
    assert.equal(fixture.requests.length, 1, "an invocation timeout must not retry the provider");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await broker.close();
    descendantPid ??= await readPidFile(pidFile);
    runnerGroupId ??= await readPidFile(runnerPidFile);
    if (runnerGroupId !== undefined && runnerGroupId > 1) {
      try {
        process.kill(-runnerGroupId, "SIGKILL");
      } catch {
        // Pi's lifecycle supervision should already have killed the helper group.
      }
    }
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Pi's lifecycle supervision should already have killed the descendant.
      }
    }
    await fixture.close();
  }
});

test("Pi command timeout becomes a tool failure, settles the invocation, and kills descendants", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const pidFile = join(workingDirectory, "timeout-child.pid");
  const runnerPidFile = join(workingDirectory, "timeout-runner.pid");
  fixture.setReplies([
    bashReply(
      `(sleep 60) &\nprintf '%s\\n' "$!" > timeout-child.pid\nprintf '%s\\n' "$PPID" > timeout-runner.pid\nprintf before-timeout\nsleep 60`,
      { timeoutSeconds: 1 },
    ),
    (response, request) => {
      const toolMessages = (request.messages ?? []).filter((message) => message.role === "tool");
      assert.ok(
        toolMessages.some((message) =>
          String(message.content).includes("Command timed out after 1 seconds"),
        ),
        "Pi's native Bash tool should report the configured timeout as a tool failure",
      );
      textReply("The timed-out command was cleaned up.")(response, request);
    },
  ]);
  const { context, events, partials } = runContext(workingDirectory);
  const adapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash"],
  });
  let descendantPid: number | undefined;
  let runnerGroupId: number | undefined;
  try {
    const result = await adapter.run(context);
    descendantPid = Number(await readFile(pidFile, "utf8"));
    runnerGroupId = await readPidFile(runnerPidFile);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(runnerGroupId !== undefined && runnerGroupId > 1);
    await waitForProcessExit(descendantPid);
    assert.equal(fixture.requests.length, 2, "the worker must not retry the model request");
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(result.content, [
      { type: "text", text: "The timed-out command was cleaned up." },
    ]);
    assert.ok(
      events.some(
        (event) => event.category === "diagnostic" && event.data?.phase === "tool_failed",
      ),
      "the timeout should be normalized as a failed tool event, not a successful command",
    );
    assert.ok(
      partials.some((partial) =>
        partial.content?.some(
          (part) =>
            part.type === "text" && part.text.includes("The timed-out command was cleaned up."),
        ),
      ),
      "the settled assistant result should be reported as partial evidence",
    );
  } finally {
    descendantPid ??= await readPidFile(pidFile);
    runnerGroupId ??= await readPidFile(runnerPidFile);
    if (runnerGroupId !== undefined && runnerGroupId > 1) {
      try {
        process.kill(-runnerGroupId, "SIGKILL");
      } catch {
        // The supervisor normally reaps the helper group before returning.
      }
    }
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The supervisor should already have killed this descendant.
      }
    }
    await fixture.close();
  }
});

test("an abrupt Pi worker crash fails once, preserves streamed partial text, and kills tool descendants", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const pidFile = join(workingDirectory, "crash-child.pid");
  const workerPidFile = join(workingDirectory, "crash-worker.pid");
  const runnerPidFile = join(workingDirectory, "crash-runner.pid");
  const expectedHostPidFile = join(workingDirectory, "expected-host.pid");
  await writeFile(expectedHostPidFile, String(process.pid));
  fixture.setReplies([
    bashReply(
      [
        "(sleep 60) &",
        "printf '%s\\n' \"$!\" > crash-child.pid",
        "printf '%s\\n' \"$PPID\" > crash-runner.pid",
        "worker_pid=$(ps -o ppid= -p \"$PPID\" | tr -d ' ')",
        "case \"$worker_pid\" in ''|*[!0-9]*) exit 92 ;; esac",
        '[ "$worker_pid" -gt 1 ] || exit 92',
        "host_pid=$(ps -o ppid= -p \"$worker_pid\" | tr -d ' ')",
        `expected_host_pid=$(cat '${expectedHostPidFile}')`,
        '[ "$host_pid" = "$expected_host_pid" ] || exit 93',
        "printf '%s\\n' \"$worker_pid\" > crash-worker.pid",
        "printf before-worker-crash",
        'kill -KILL "$worker_pid"',
        "sleep 60",
      ].join("\n"),
      { content: "partial-before-worker-crash" },
    ),
  ]);
  const { context, events, partials } = runContext(workingDirectory);
  const adapter = new PiAdapter({
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash"],
  });
  let descendantPid: number | undefined;
  let workerPid: number | undefined;
  let runnerGroupId: number | undefined;
  try {
    await assert.rejects(
      adapter.run(context),
      (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
    );
    descendantPid = Number(await readFile(pidFile, "utf8"));
    workerPid = Number(await readFile(workerPidFile, "utf8"));
    runnerGroupId = await readPidFile(runnerPidFile);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
    assert.ok(runnerGroupId !== undefined && runnerGroupId > 1);
    await Promise.all([waitForProcessExit(descendantPid), waitForProcessExit(workerPid)]);
    assert.equal(fixture.requests.length, 1, "the crashed worker must not retry the model request");
    assert.deepEqual(fixture.errors, []);
    assert.ok(
      events.some((event) =>
        event.content?.some(
          (part) => part.type === "text" && part.text.includes("partial-before-worker-crash"),
        ),
      ),
      "text observed before the worker crash should remain streamed",
    );
    assert.ok(
      partials.some(
        (partial) =>
          partial.observedIdentity?.harnessVersion.evidence === "verified" &&
          partial.content?.some(
            (part) => part.type === "text" && part.text.includes("partial-before-worker-crash"),
          ),
      ),
      "the failed terminal path should retain both observed identity and partial text",
    );
  } finally {
    descendantPid ??= await readPidFile(pidFile);
    workerPid ??= await readPidFile(workerPidFile);
    runnerGroupId ??= await readPidFile(runnerPidFile);
    if (runnerGroupId !== undefined && runnerGroupId > 1) {
      try {
        process.kill(-runnerGroupId, "SIGKILL");
      } catch {
        // The supervisor normally reaps the helper group before rejecting.
      }
    }
    for (const pid of [descendantPid, workerPid]) {
      if (pid !== undefined && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The worker supervisor should already have reaped both processes.
        }
      }
    }
    await fixture.close();
  }
});

test("host-parent loss closes Pi worker and its tool descendants", async () => {
  const fixture = await startFixture();
  const workingDirectory = join(fixture.root, "work");
  const hostPidFile = join(fixture.root, "host.pid");
  const workerPidFile = join(workingDirectory, "parent-loss-worker.pid");
  const childPidFile = join(workingDirectory, "parent-loss-child.pid");
  const runnerPidFile = join(workingDirectory, "parent-loss-runner.pid");
  const hostScript = join(fixture.root, "parent-loss-host.mjs");
  const adapterPath = pathToFileURL(
    fileURLToPath(new URL("../src/adapters/pi.js", import.meta.url)),
  ).href;
  const configuration = {
    model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
    modelFiles: fixture.modelFiles,
    tools: ["read", "write", "edit", "bash"],
  };
  const request = {
    selector: {
      provider: "fixture",
      model: "fixture-model",
      via: "pi",
      requiredCapabilities: ["core.input.text", "core.output.text"],
    },
    input: [{ type: "text", text: "Start the long command." }],
    workingDirectory,
    interactionStrategy: "unattended",
    requestedPolicy: {
      minimumAssurance: "none",
      filesystem: "inherit",
      commands: "allow",
      network: "allow",
    },
  };
  const route = {
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
  await writeFile(
    hostScript,
    [
      'import { writeFile } from "node:fs/promises";',
      `import { PiAdapter } from ${JSON.stringify(adapterPath)};`,
      `await writeFile(${JSON.stringify(hostPidFile)}, String(process.pid));`,
      `const adapter = new PiAdapter(${JSON.stringify(configuration)});`,
      `const context = { invocationId: "parent-loss-test", request: ${JSON.stringify(request)}, route: ${JSON.stringify(route)}, signal: new AbortController().signal, emit: async () => {}, reportPartial: () => {}, terminationGraceMs: 1000 };`,
      "await adapter.run(context);",
    ].join("\n"),
  );
  fixture.setReplies([
    bashReply(
      [
        "(sleep 60) &",
        "printf '%s\\n' \"$!\" > parent-loss-child.pid",
        "printf '%s\\n' \"$PPID\" > parent-loss-runner.pid",
        "worker_pid=$(ps -o ppid= -p \"$PPID\" | tr -d ' ')",
        "case \"$worker_pid\" in ''|*[!0-9]*) exit 92 ;; esac",
        '[ "$worker_pid" -gt 1 ] || exit 92',
        "host_pid=$(ps -o ppid= -p \"$worker_pid\" | tr -d ' ')",
        `expected_host_pid=$(cat '${hostPidFile}')`,
        '[ "$host_pid" = "$expected_host_pid" ] || exit 93',
        "printf '%s\\n' \"$worker_pid\" > parent-loss-worker.pid",
        "sleep 60",
      ].join("\n"),
    ),
  ]);
  let host: ChildProcess | undefined;
  let hostClosed: ReturnType<typeof childClosed> | undefined;
  let workerPid: number | undefined;
  let descendantPid: number | undefined;
  let runnerGroupId: number | undefined;
  try {
    host = spawn(process.execPath, [hostScript], {
      cwd: fixture.root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: fixture.root, TMPDIR: fixture.root },
      stdio: "ignore",
    });
    hostClosed = childClosed(host);
    assert.ok(host.pid && host.pid > 1);
    await Promise.all([
      waitForFile(hostPidFile, "the isolated host process identity"),
      waitForFile(childPidFile, "the long-running command descendant"),
      waitForFile(workerPidFile, "the supervised Pi worker identity"),
    ]);
    descendantPid = Number(await readFile(childPidFile, "utf8"));
    workerPid = Number(await readFile(workerPidFile, "utf8"));
    runnerGroupId = await readPidFile(runnerPidFile);
    assert.equal(Number(await readFile(hostPidFile, "utf8")), host.pid);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1 && workerPid !== host.pid);
    assert.ok(runnerGroupId !== undefined && runnerGroupId > 1);

    host.kill("SIGKILL");
    const hostExit = await Promise.race([
      hostClosed,
      delay(5000).then(() => {
        throw new Error("The isolated host did not close after being killed.");
      }),
    ]);
    assert.equal(hostExit.signal, "SIGKILL");
    await Promise.all([waitForProcessExit(workerPid), waitForProcessExit(descendantPid)]);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.errors, []);
  } finally {
    descendantPid ??= await readPidFile(childPidFile);
    workerPid ??= await readPidFile(workerPidFile);
    runnerGroupId ??= await readPidFile(runnerPidFile);
    if (host?.pid !== undefined) {
      try {
        host.kill("SIGKILL");
      } catch {
        // The isolated host may already have exited.
      }
    }
    if (runnerGroupId !== undefined && runnerGroupId > 1) {
      try {
        process.kill(-runnerGroupId, "SIGKILL");
      } catch {
        // The helper group may already have exited after receiving control EOF.
      }
    }
    for (const pid of [workerPid, descendantPid]) {
      if (pid !== undefined && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The EOF handlers should already have cleaned these processes.
        }
      }
    }
    if (hostClosed !== undefined) {
      await Promise.race([hostClosed, delay(2000)]);
    }
    await fixture.close();
  }
});

test("a provider HTTP 429 fails once without retry and retains observed identity", async () => {
  const fixture = await startFixture();
  fixture.setReplies([
    (response) =>
      response
        .writeHead(429, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "fixture rate limit" } })),
  ]);
  const { context, partials } = runContext(join(fixture.root, "work"));
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: fixture.modelFiles,
      tools: ["read"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: fixture.root }) },
  );
  try {
    await assert.rejects(
      adapter.run(context),
      (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
    );
    assert.equal(fixture.requests.length, 1, "Pi must not retry a 429 request");
    assert.deepEqual(fixture.errors, []);
    assert.ok(
      partials.some((partial) => partial.observedIdentity?.harnessVersion.evidence === "verified"),
    );
  } finally {
    await adapter.dispose();
    await fixture.close();
  }
});

test("partial output prefers a completed stream or the longer incomplete final prefix", async () => {
  const scenarios: ReadonlyArray<{
    readonly streamedText?: string;
    readonly finalPrefix: string;
    readonly expected: string;
  }> = [
    {
      streamedText: "complete streamed answer survives an incomplete final result frame",
      finalPrefix: "incomplete prefix",
      expected: "complete streamed answer survives an incomplete final result frame",
    },
    {
      finalPrefix: "content-only partial prefix",
      expected: "content-only partial prefix",
    },
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-partial-"));
    const workingDirectory = join(root, "work");
    await mkdir(workingDirectory, { recursive: true });
    const fakeWorkerPath = join(root, "partial-worker.mjs");
    const outputLines = [
      ...(scenario.streamedText === undefined
        ? []
        : [
            `process.stdout.write(JSON.stringify({ type: "event", event: { category: "output", content: [{ type: "text", text: ${JSON.stringify(scenario.streamedText)} }] } }) + "\\n");`,
          ]),
      `process.stdout.write(JSON.stringify({ type: "content", index: 0, text: ${JSON.stringify(scenario.finalPrefix)}, final: false }) + "\\n");`,
      "process.stdin.destroy(); process.stdout.end();",
    ];
    await writeFile(
      fakeWorkerPath,
      `import { createInterface } from "node:readline";\nconst input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();\nawait input.next();\n${outputLines.join("\n")}\n`,
    );
    const { context, partials } = runContext(workingDirectory);
    const configuration = {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" as const },
      modelFiles: {
        authPath: join(root, "agent", "auth.json"),
        modelsPath: join(root, "agent", "models.json"),
        modelsStorePath: join(root, "agent", "models-store.json"),
      },
      tools: ["read"] as const,
    };
    try {
      await assert.rejects(
        supervisePiWorker(context, configuration, fakeWorkerPath),
        (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
      );
      const latest = partials.at(-1);
      assert.deepEqual(latest?.content, [{ type: "text", text: scenario.expected }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Pi SDK stays optional, version checks are explicit, and failed worker spawn is handled", async () => {
  assert.equal(supportsPiNodeVersion("22.18.9"), false);
  assert.equal(supportsPiNodeVersion("22.19.0"), true);
  assert.equal(supportsPiNodeVersion("23.0.0"), true);
  assert.equal(supportsPiNodeVersion("21.99.99"), false);
  assert.ok(
    supportsPiNodeVersion(process.versions.node),
    "the fixture needs the qualified Pi Node runtime",
  );

  const root = await mkdtemp(join(tmpdir(), "harness-relay-pi-optional-"));
  const loaderPath = join(root, "block-pi.mjs");
  // cspell:ignore earendil
  await writeFile(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {\n  if (specifier === "@earendil-works/pi-coding-agent") { const error = new Error("optional Pi dependency omitted"); error.code = "ERR_MODULE_NOT_FOUND"; throw error; }\n  return nextResolve(specifier, context);\n}\n`,
  );
  const workerPath = fileURLToPath(new URL("../src/adapters/pi-worker.js", import.meta.url));
  const start = {
    type: "start",
    protocolVersion: PI_WORKER_PROTOCOL_VERSION,
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
  const workerClosed = new Promise<{ code: null | number }>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code) => {
      resolve({ code });
    });
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
  const smokeExit = await new Promise<null | number>((resolve, reject) => {
    smoke.once("error", reject);
    smoke.once("close", resolve);
  });
  assert.equal(
    smokeExit,
    0,
    "core CLI and existing adapters must import without the optional Pi package",
  );

  const missingDirectory = join(root, "does-not-exist");
  const { context } = runContext(missingDirectory);
  const adapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: start.modelFiles,
      tools: ["read"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: root }) },
  );
  const readOnlyAdapter = new PiAdapter(
    {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
      modelFiles: start.modelFiles,
      tools: ["read", "write", "bash"],
    },
    { continuationStore: new PiContinuationStore({ baseDirectory: root }) },
  );
  try {
    await assert.rejects(
      adapter.run(context),
      (error: unknown) => error instanceof BridgeError && error.code === "harness_failed",
    );

    const policyContext = runContext(root).context;
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
    assert.deepEqual(
      await adapter.discover(),
      [],
      "the unqualified internal runtime stays undiscovered",
    );
  } finally {
    await adapter.dispose();
    await readOnlyAdapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
