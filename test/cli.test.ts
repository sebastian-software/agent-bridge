import assert from "node:assert/strict";
import { type ChildProcess, execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { IpcClient } from "../src/ipc.js";

const execFile = promisify(execFileCallback);
const cliPath = join(process.cwd(), "dist", "src", "cli.js");

test("the published bin keeps its shebang", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    readonly bin: Readonly<Record<string, string>>;
  };
  assert.equal(join(process.cwd(), manifest.bin["agent-bridge"] ?? ""), cliPath);

  const [firstLine] = (await readFile(cliPath, "utf8")).split("\n", 1);
  assert.equal(firstLine, "#!/usr/bin/env node");
});

function testEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BRIDGE_RUNTIME_DIR: join(root, "run"),
    AGENT_BRIDGE_STATE_DIR: join(root, "state"),
    AGENT_BRIDGE_SOCKET_PATH: join(tmpdir(), `${basename(root)}.sock`),
  };
}

async function waitForBroker(client: IpcClient): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.request("system.describe", {});
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`Broker did not become ready: ${String(lastError)}`);
}

async function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  return new Promise((resolve, reject) => {
    child.once("exit", () => {
      resolve();
    });
    child.once("error", reject);
  });
}

function invocationIdFrom(stdout: string): string {
  const value = JSON.parse(stdout) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("invocationId" in value) ||
    typeof value.invocationId !== "string"
  ) {
    assert.fail("Expected a CLI result with an invocationId.");
  }
  return value.invocationId;
}

test("CLI discovers, starts, follows, and inspects through the Unix socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-cli-"));
  const env = testEnvironment(root);
  const broker = spawn(process.execPath, [cliPath, "broker", "serve"], {
    env,
    stdio: "ignore",
  });
  const client = new IpcClient(env.AGENT_BRIDGE_SOCKET_PATH ?? "");
  try {
    await waitForBroker(client);
    const described = await execFile(process.execPath, [cliPath, "describe", "--json"], { env });
    const description = JSON.parse(described.stdout) as { operationsVersion?: unknown };
    assert.equal(description.operationsVersion, "1.0");

    const status = await execFile(process.execPath, [cliPath, "broker", "status", "--json"], {
      env,
    });
    const brokerStatus = JSON.parse(status.stdout) as {
      ready?: unknown;
      environmentVariableNames?: unknown;
    };
    assert.equal(brokerStatus.ready, true);
    assert.ok(Array.isArray(brokerStatus.environmentVariableNames));
    assert.ok(brokerStatus.environmentVariableNames.includes("PATH"));

    try {
      await execFile(process.execPath, [cliPath, "start", "--provider", "agent-bridge", "--json"], {
        env,
      });
      assert.fail("Invalid CLI input should fail.");
    } catch (error) {
      if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string") {
        assert.fail("Expected a process error with captured stderr.");
      }
      const failure = JSON.parse(error.stderr) as { error?: { code?: unknown } };
      assert.equal(failure.error?.code, "invalid_request");
    }

    const started = await execFile(
      process.execPath,
      [
        cliPath,
        "start",
        "--provider",
        "agent-bridge",
        "--model",
        "fake-echo",
        "--via",
        "fake",
        "--text",
        "hello from CLI",
        "--cwd",
        root,
        "--correlation-id",
        "cli-test",
        "--json",
      ],
      { env },
    );
    const invocationId = invocationIdFrom(started.stdout);

    const followed = await execFile(
      process.execPath,
      [cliPath, "events", invocationId, "--follow", "--json"],
      { env },
    );
    const eventLines = followed.stdout.trim().split("\n").filter(Boolean);
    assert.ok(eventLines.length >= 5);
    const terminalEvent = JSON.parse(eventLines.at(-1) ?? "null") as { data?: { state?: string } };
    assert.equal(terminalEvent.data?.state, "succeeded");

    const inspected = await execFile(
      process.execPath,
      [cliPath, "inspect", invocationId, "--json"],
      { env },
    );
    const inspection = JSON.parse(inspected.stdout) as { state?: unknown };
    assert.equal(inspection.state, "succeeded");

    const fetched = await execFile(process.execPath, [cliPath, "get", invocationId, "--json"], {
      env,
    });
    assert.equal(
      (JSON.parse(fetched.stdout) as { invocationId?: unknown }).invocationId,
      invocationId,
    );

    const waited = await execFile(process.execPath, [cliPath, "wait", invocationId, "--json"], {
      env,
    });
    assert.equal((JSON.parse(waited.stdout) as { waited?: unknown }).waited, true);

    const result = await execFile(process.execPath, [cliPath, "result", invocationId, "--json"], {
      env,
    });
    assert.equal((JSON.parse(result.stdout) as { outcome?: unknown }).outcome !== undefined, true);

    const listed = await execFile(
      process.execPath,
      [cliPath, "list", "--correlation", "cli-test", "--json"],
      { env },
    );
    assert.equal(
      (JSON.parse(listed.stdout) as { invocations?: readonly unknown[] }).invocations?.length,
      1,
    );

    const oneShot = await execFile(
      process.execPath,
      [
        cliPath,
        "run",
        "--provider",
        "agent-bridge",
        "--model",
        "fake-echo",
        "--via",
        "fake",
        "--text",
        "one shot",
        "--cwd",
        root,
        "--json",
      ],
      { env },
    );
    const oneShotLines = oneShot.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(oneShotLines.some((line) => line.category === "lifecycle"));
    const oneShotOutcome = oneShotLines.at(-1)?.outcome;
    assert.ok(
      typeof oneShotOutcome === "object" && oneShotOutcome !== null && "status" in oneShotOutcome,
    );
    assert.equal(oneShotOutcome.status, "succeeded");

    const humanRun = await execFile(
      process.execPath,
      [
        cliPath,
        "run",
        "--provider",
        "agent-bridge",
        "--model",
        "fake-echo",
        "--via",
        "fake",
        "--cwd",
        root,
        "human progress",
      ],
      { env },
    );
    assert.ok(humanRun.stderr.includes("activity: fake-work"));

    const version = await execFile(process.execPath, [cliPath, "--version"], { env });
    assert.equal(version.stdout.trim(), "0.1.0");
  } finally {
    try {
      await execFile(process.execPath, [cliPath, "broker", "stop", "--json"], { env });
    } catch {
      broker.kill("SIGTERM");
    }
    await childExit(broker);
    await rm(root, { recursive: true, force: true });
  }
});

test("a real broker crash is reconciled as interrupted after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-crash-"));
  const env = testEnvironment(root);
  const socketPath = env.AGENT_BRIDGE_SOCKET_PATH ?? "";
  let broker = spawn(process.execPath, [cliPath, "broker", "serve"], { env, stdio: "ignore" });
  try {
    await waitForBroker(new IpcClient(socketPath));
    const started = await execFile(
      process.execPath,
      [
        cliPath,
        "start",
        "--provider",
        "agent-bridge",
        "--model",
        "fake-slow",
        "--text",
        "survive caller disconnect",
        "--cwd",
        root,
        "--json",
      ],
      { env },
    );
    const invocationId = invocationIdFrom(started.stdout);

    broker.kill("SIGKILL");
    await childExit(broker);

    broker = spawn(process.execPath, [cliPath, "broker", "serve"], { env, stdio: "ignore" });
    const client = new IpcClient(socketPath);
    await waitForBroker(client);
    const inspected = await client.request("invocation.inspect", { invocationId });
    if (typeof inspected !== "object" || inspected === null || !("state" in inspected)) {
      assert.fail("Expected an inspection result with state.");
    }
    assert.equal(inspected.state, "interrupted");
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) {
      try {
        await execFile(process.execPath, [cliPath, "broker", "stop", "--json"], { env });
      } catch {
        broker.kill("SIGTERM");
      }
      await childExit(broker);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("autostart includes the broker startup diagnostic when initialization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-startup-error-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  await chmod(stateDirectory, 0o755);
  const env = testEnvironment(root);
  try {
    await assert.rejects(
      execFile(process.execPath, [cliPath, "describe", "--json"], { env }),
      (error: unknown) => {
        if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string") {
          return false;
        }
        return (
          error.stderr.includes(stateDirectory) &&
          error.stderr.includes("broker_unavailable") &&
          !error.stderr.includes("Startup error: agent-bridge:") &&
          !error.stderr.includes("(broker_unavailable) (broker_unavailable)")
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exits after autostarting a healthy broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-autostart-exit-"));
  const env = testEnvironment(root);
  try {
    const result = await execFile(
      process.execPath,
      [
        cliPath,
        "run",
        "--provider",
        "agent-bridge",
        "--model",
        "fake-echo",
        "--via",
        "fake",
        "--cwd",
        root,
        "--json",
        "autostart should exit",
      ],
      { env, timeout: 5000 },
    );
    const lastLine = result.stdout.trim().split("\n").at(-1);
    const outcome =
      lastLine === undefined
        ? undefined
        : (JSON.parse(lastLine) as { outcome?: { status?: string } });
    assert.equal(outcome?.outcome?.status, "succeeded");
  } finally {
    try {
      await execFile(process.execPath, [cliPath, "broker", "stop", "--json"], {
        env,
        timeout: 2000,
      });
    } catch {
      // The broker may already have exited after a failed startup.
    }
    await rm(root, { recursive: true, force: true });
  }
});
