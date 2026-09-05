import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 1_048_576;

export type BrokerLogLevel = "warn" | "error" | "info";

export async function writeBrokerLog(path: string, level: BrokerLogLevel, message: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const info = await stat(path);
      if (info.size >= MAX_LOG_BYTES) {
        await rename(path, `${path}.1`).catch(() => undefined);
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        return;
      }
    }
    await appendFile(path, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Logging must never prevent the broker from serving requests.
  }
}
