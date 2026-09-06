import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { chat, EventType } from "@tanstack/ai";
import type { ChatStream, StreamChunk } from "@tanstack/ai";
import { claudeCodeText } from "@tanstack/ai-claude-code";
import { codexText } from "@tanstack/ai-codex";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";

const execFileAsync = promisify(execFile);
const MAX_RAW_CHUNK_BYTES = 32 * 1024;

type Harness = "claude" | "codex";
type Scenario = "basic" | "continuation" | "cancellation" | "full";

interface RunObservation {
  label: string;
  durationMs: number;
  eventCounts: Record<string, number>;
  sessionId?: string;
  text: string;
  fileEvents: Array<unknown>;
  runErrors: Array<unknown>;
  aborted: boolean;
  terminalEventSeen: boolean;
  thrown?: string;
}

interface SpikeOptions {
  harness: Harness;
  model: string;
  scenario: Scenario;
  workspace: string;
  generatedWorkspace: boolean;
  output: string;
  abortAfterMs: number;
}

function usage(): string {
  return `Usage:
  pnpm run run -- --harness claude|codex [options]

Options:
  --model <id>              Default: opus (Claude), gpt-5.5 (Codex)
  --scenario <name>         basic|continuation|cancellation|full (default: full)
  --workspace <path>        Existing disposable Git repository
  --output <path>           Bounded raw JSONL capture outside the workspace
  --abort-after-ms <n>      Cancellation delay (default: 8000)
  --help
`;
}

async function git(cwd: string, args: Array<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function prepareWorkspace(
  requested: string | undefined,
): Promise<{ path: string; generated: boolean }> {
  if (requested) {
    const path = resolve(requested);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${path}`);
    await git(path, ["rev-parse", "--show-toplevel"]);
    return { path, generated: false };
  }

  const path = await mkdtemp(join(tmpdir(), "agent-bridge-tanstack-ai-"));
  await git(path, ["init", "--quiet"]);
  await writeFile(join(path, "README.md"), "# Agent Bridge TanStack AI spike fixture\n", "utf8");
  await git(path, ["add", "README.md"]);
  await git(path, [
    "-c",
    "user.name=Agent Bridge Spike",
    "-c",
    "user.email=spike@agent-bridge.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  return { path, generated: true };
}

async function optionsFromArgv(): Promise<SpikeOptions | null> {
  const { values } = parseArgs({
    options: {
      harness: { type: "string" },
      model: { type: "string" },
      scenario: { type: "string", default: "full" },
      workspace: { type: "string" },
      output: { type: "string" },
      "abort-after-ms": { type: "string", default: "8000" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(usage());
    return null;
  }
  if (values.harness !== "claude" && values.harness !== "codex") {
    throw new Error("--harness must be claude or codex");
  }
  if (
    values.scenario !== "basic" &&
    values.scenario !== "continuation" &&
    values.scenario !== "cancellation" &&
    values.scenario !== "full"
  ) {
    throw new Error("--scenario must be basic, continuation, cancellation, or full");
  }

  const abortAfterMs = Number(values["abort-after-ms"]);
  if (!Number.isSafeInteger(abortAfterMs) || abortAfterMs < 1) {
    throw new Error("--abort-after-ms must be a positive integer");
  }

  const workspace = await prepareWorkspace(values.workspace);
  const model = values.model ?? (values.harness === "claude" ? "opus" : "gpt-5.5");
  const output = resolve(
    values.output ?? join(tmpdir(), `agent-bridge-tanstack-${values.harness}-${Date.now()}.jsonl`),
  );
  await mkdir(dirname(output), { recursive: true });

  return {
    harness: values.harness,
    model,
    scenario: values.scenario,
    workspace: workspace.path,
    generatedWorkspace: workspace.generated,
    output,
    abortAfterMs,
  };
}

function boundedChunk(chunk: StreamChunk): unknown {
  const serialized = JSON.stringify(chunk);
  if (Buffer.byteLength(serialized) <= MAX_RAW_CHUNK_BYTES) return chunk;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    preview: serialized.slice(0, MAX_RAW_CHUNK_BYTES),
  };
}

async function observeStream(
  label: string,
  stream: ChatStream,
  output: string,
  abortController?: AbortController,
): Promise<RunObservation> {
  const startedAt = Date.now();
  const eventCounts: Record<string, number> = {};
  const fileEvents: Array<unknown> = [];
  const runErrors: Array<unknown> = [];
  let text = "";
  let sessionId: string | undefined;
  let thrown: string | undefined;
  let terminalEventSeen = false;

  try {
    let sequence = 0;
    for await (const chunk of stream) {
      sequence += 1;
      eventCounts[chunk.type] = (eventCounts[chunk.type] ?? 0) + 1;

      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) text += chunk.delta;
      if (
        chunk.type === EventType.CUSTOM &&
        chunk.name.endsWith(".session-id") &&
        typeof chunk.value === "object" &&
        chunk.value !== null &&
        "sessionId" in chunk.value &&
        typeof chunk.value.sessionId === "string"
      ) {
        sessionId = chunk.value.sessionId;
      }
      if (
        chunk.type === EventType.CUSTOM &&
        (chunk.name === "file.changed" ||
          chunk.name === "sandbox.file" ||
          chunk.name === "sandbox.file.diff")
      ) {
        fileEvents.push({ name: chunk.name, value: chunk.value });
      }
      if (chunk.type === EventType.RUN_ERROR) runErrors.push(chunk);
      if (chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR) {
        terminalEventSeen = true;
      }

      await appendFile(
        output,
        `${JSON.stringify({
          label,
          sequence,
          elapsedMs: Date.now() - startedAt,
          chunk: boundedChunk(chunk),
        })}\n`,
        "utf8",
      );
    }
  } catch (error) {
    thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return {
    label,
    durationMs: Date.now() - startedAt,
    eventCounts,
    ...(sessionId ? { sessionId } : {}),
    text,
    fileEvents,
    runErrors,
    aborted: abortController?.signal.aborted ?? false,
    terminalEventSeen,
    ...(thrown ? { thrown } : {}),
  };
}

function createSandbox(options: SpikeOptions) {
  return defineSandbox({
    id: `agent-bridge-spike-${options.harness}`,
    provider: localProcessSandbox({
      dir: options.workspace,
      removeOnDestroy: false,
      scrubEnv:
        options.harness === "claude"
          ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
          : ["CODEX_API_KEY", "OPENAI_API_KEY"],
    }),
    // The fixed local-process directory already is the workspace. An explicit
    // empty definition is still required because withSandbox 0.5.1 declares a
    // projection capability even when no workspace definition was supplied.
    workspace: defineWorkspace({ source: { type: "none" }, root: "." }),
    lifecycle: {
      reuse: "thread",
      snapshot: "none",
      destroyOnComplete: false,
    },
    fileEvents: { diff: true },
  });
}

async function runClaude(
  options: SpikeOptions,
  label: string,
  prompt: string,
  threadId: string,
  sessionId?: string,
  abortController?: AbortController,
): Promise<RunObservation> {
  const adapter = claudeCodeText(options.model, {
    authMode: "host",
    permissionMode: "bypassPermissions",
    settingSources: [],
    streamPartials: true,
    emitDiff: true,
  });
  const stream = chat({
    adapter,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    threadId,
    runId: randomUUID(),
    abortController,
    modelOptions: {
      authMode: "host",
      permissionMode: "bypassPermissions",
      ...(sessionId ? { sessionId } : {}),
    },
    middleware: [withSandbox(createSandbox(options))],
  });
  return observeStream(label, stream, options.output, abortController);
}

async function runCodex(
  options: SpikeOptions,
  label: string,
  prompt: string,
  threadId: string,
  sessionId?: string,
  abortController?: AbortController,
): Promise<RunObservation> {
  const adapter = codexText(options.model, {
    authMode: "host",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
    skipGitRepoCheck: false,
  });
  const stream = chat({
    adapter,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    threadId,
    runId: randomUUID(),
    abortController,
    modelOptions: {
      authMode: "host",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      modelReasoningEffort: "high",
      skipGitRepoCheck: false,
      ...(sessionId ? { sessionId } : {}),
    },
    middleware: [withSandbox(createSandbox(options))],
  });
  return observeStream(label, stream, options.output, abortController);
}

async function runTurn(
  options: SpikeOptions,
  label: string,
  prompt: string,
  threadId: string,
  sessionId?: string,
  abortController?: AbortController,
): Promise<RunObservation> {
  return options.harness === "claude"
    ? runClaude(options, label, prompt, threadId, sessionId, abortController)
    : runCodex(options, label, prompt, threadId, sessionId, abortController);
}

async function main(): Promise<void> {
  const options = await optionsFromArgv();
  if (!options) return;

  await writeFile(
    options.output,
    `${JSON.stringify({ type: "spike.config", ...options, startedAt: new Date().toISOString() })}\n`,
    "utf8",
  );

  const threadId = randomUUID();
  const observations: Array<RunObservation> = [];
  let firstSessionId: string | undefined;

  if (options.scenario !== "cancellation") {
    const first = await runTurn(
      options,
      "basic",
      `Work directly in the current repository. Create bridge-spike.txt containing exactly "created by ${options.harness}\\n". Do not modify any other file. Reply with a short confirmation.`,
      threadId,
    );
    observations.push(first);
    firstSessionId = first.sessionId;
  }

  if (options.scenario === "continuation" || options.scenario === "full") {
    if (!firstSessionId) {
      observations.push({
        label: "continuation",
        durationMs: 0,
        eventCounts: {},
        text: "",
        fileEvents: [],
        runErrors: [],
        aborted: false,
        terminalEventSeen: false,
        thrown: "No native session id was emitted by the first run",
      });
    } else {
      observations.push(
        await runTurn(
          options,
          "continuation",
          `Continue the previous session. Append exactly "continued by ${options.harness}\\n" to bridge-spike.txt. Do not modify any other file. Reply with a short confirmation.`,
          threadId,
          firstSessionId,
        ),
      );
    }
  }

  if (options.scenario === "cancellation" || options.scenario === "full") {
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(new Error("agent-bridge spike cancellation")),
      options.abortAfterMs,
    );
    try {
      observations.push(
        await runTurn(
          options,
          "cancellation",
          "Run the shell command `sleep 120`, wait for it to finish, then reply `finished sleeping`. Do not modify any files.",
          randomUUID(),
          undefined,
          abortController,
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const status = await git(options.workspace, ["status", "--short"]);
  const diff = await git(options.workspace, ["diff", "--no-ext-diff", "--binary"]);
  let fixtureContent: string | undefined;
  try {
    fixtureContent = await readFile(join(options.workspace, "bridge-spike.txt"), "utf8");
  } catch {
    // Cancellation-only and failed runs need not create the fixture.
  }
  const streamCriteriaPassed = observations.every((observation) =>
    observation.label === "cancellation"
      ? observation.aborted && observation.thrown === undefined
      : observation.thrown === undefined &&
        observation.runErrors.length === 0 &&
        observation.terminalEventSeen &&
        observation.sessionId !== undefined,
  );
  const summary = {
    options,
    observations,
    workspaceStatus: status,
    workspaceDiff: diff,
    ...(fixtureContent !== undefined ? { fixtureContent } : {}),
    streamCriteriaPassed,
  };
  await appendFile(
    options.output,
    `${JSON.stringify({ type: "spike.summary", ...summary })}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!streamCriteriaPassed) process.exitCode = 1;
}

await main();
