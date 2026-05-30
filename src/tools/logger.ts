/** Simple file logger for tool calls — writes JSON lines to .reasonix/logs/ */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".reasonix", "logs");

/** Ensure log directory exists (first call only). */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** Format a tool's arguments into a short summary string for logging (truncated to avoid giant log lines). */
function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(args);
    return str.length > 500 ? `${str.slice(0, 500)}…` : str;
  } catch {
    return String(args);
  }
}

/** Log a tool call to a date-rotated JSONL file. */
export function logToolCall(
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  durationMs: number,
): void {
  try {
    ensureLogDir();
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = join(LOG_DIR, `${date}.log`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      name,
      args: summarizeArgs(args),
      ok,
      durationMs,
    });
    appendFileSync(logFile, `${entry}\n`, "utf-8");
  } catch {
    // Logging must never crash the tool dispatch
  }
}
