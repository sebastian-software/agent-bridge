import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  MAX_PI_WORKER_MESSAGE_BYTES,
  parsePiToolRunnerStart,
  readBoundedLines,
} from "./pi-protocol.js";

type RunnerResult = {
  readonly type: "result";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error?: string;
};

function writeResult(result: RunnerResult): void {
  const line = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(line, "utf8") > 4096) {
    throw new Error("Pi tool runner result exceeded its limit.");
  }
  const bytes = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(3, bytes, offset, bytes.byteLength - offset);
  }
}

function killOwnGroup(): void {
  if (process.platform === "win32" || process.pid <= 1) {
    return;
  }
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // The group may already have exited.
  }
}

async function runPiToolRunner(): Promise<void> {
  const input = readBoundedLines(process.stdin, MAX_PI_WORKER_MESSAGE_BYTES);
  try {
    const startLine = await input.next();
    if (startLine.done) {
      process.exitCode = 70;
      return;
    }
    const start = parsePiToolRunnerStart(JSON.parse(startLine.value) as unknown);
    const controlLine = await input.next();
    if (controlLine.done) {
      // The worker may exit before the Relay process group registration ACK.
      // The shell has not been spawned at this point.
      process.exitCode = 70;
      return;
    }
    const control = JSON.parse(controlLine.value) as unknown;
    if (
      typeof control !== "object" ||
      control === null ||
      (control as Record<string, unknown>).type !== "registered"
    ) {
      process.exitCode = 70;
      return;
    }

    let parentLost = false;
    let shellStarted = false;
    process.stdin.once("end", () => {
      parentLost = true;
      if (shellStarted) {
        killOwnGroup();
      }
    });
    void input
      .next()
      .then(() => {
        parentLost = true;
        if (shellStarted) {
          killOwnGroup();
        }
      })
      .catch(() => {
        parentLost = true;
        if (shellStarted) {
          killOwnGroup();
        }
      });
    await access(start.cwd, constants.F_OK);
    if (parentLost) {
      process.exitCode = 70;
      return;
    }
    const args =
      start.commandTransport === "stdin"
        ? [...start.shellArgs]
        : [...start.shellArgs, start.command];
    const shell = spawn(start.shell, args, {
      cwd: start.cwd,
      env: { ...start.env },
      detached: false,
      stdio: [start.commandTransport === "stdin" ? "pipe" : "ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    shellStarted = true;
    if (parentLost) {
      killOwnGroup();
      return;
    }
    let shellError: Error | undefined;
    shell.once("error", (error) => {
      shellError = error;
    });
    if (start.commandTransport === "stdin") {
      shell.stdin?.on("error", () => {});
      shell.stdin?.end(start.command);
    }

    const result = await new Promise<RunnerResult>((resolveResult) => {
      shell.once("exit", (exitCode, signal) => {
        resolveResult({
          type: "result",
          exitCode,
          signal,
          ...(shellError === undefined ? {} : { error: shellError.message }),
        });
      });
      shell.once("error", (error) => {
        resolveResult({ type: "result", exitCode: null, signal: null, error: error.message });
      });
    });
    writeResult(result);

    // The worker reports the exit and waits for Relay to terminate this whole
    // process group. That removes background shell descendants which outlive
    // the command's leader. If the worker disappears, stdin EOF kills the group.
    await new Promise<void>(() => {});
  } catch (error) {
    try {
      writeResult({
        type: "result",
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      process.exitCode = 71;
    }
  }
}

export { runPiToolRunner };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runPiToolRunner();
}
