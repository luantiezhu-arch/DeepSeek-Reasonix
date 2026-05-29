import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import { parseCommandChain, runChain } from "../shell-chain.js";
import { tokenizeCommand } from "./parse.js";

export const DEFAULT_TIMEOUT_SEC = 60;
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {}
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch {}
  try {
    child.kill("SIGKILL");
  } catch {}
}

export interface RunCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export async function runCommand(
  cmd: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<RunCommandResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const argv = tokenizeCommand(cmd);
  if (argv.length === 0) throw new Error("run_command: empty command");
  const chain = parseCommandChain(cmd);
  if (chain !== null) {
    return await runChain(chain, {
      cwd: opts.cwd,
      timeoutSec,
      maxOutputChars: maxChars,
      signal: opts.signal,
    });
  }
  const timeoutMs = timeoutSec * 1000;
  const normalizedEnv = normalizeWindowsEnvVars(process.env);
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    // PYTHONIOENCODING + PYTHONUTF8 force Python children to emit UTF-8
    // on stdout. Without this, CJK Windows defaults to GBK and
    // print("…") raises UnicodeEncodeError on non-GBK chars.
    env: opts.env ?? { ...normalizedEnv, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  };

  // Expand $VAR, ${VAR}, and %VAR% AFTER allowlist check.
  // Use the resolved env (sandbox-filtered or process.env) so
  // sandbox mode doesn't leak stripped vars into command args.
  const expandEnv = opts.env ?? process.env;
  const expandedArgv = argv.map((token) =>
    token
      .replace(/\$(\w+)/g, (_m, name) => expandEnv[name] ?? _m)
      .replace(/\$\{(\w+)\}/g, (_m, name) => expandEnv[name] ?? _m)
      .replace(/%(\w+)%/g, (_m, name) => expandEnv[name] ?? _m),
  );
  const { bin, args, spawnOverrides } = prepareSpawn(expandedArgv, { env: normalizedEnv });
  const effectiveSpawnOpts = { ...spawnOpts, ...spawnOverrides };

  // Sandbox wraps spawn with consistent kill + timeout + env handling
  const { Sandbox } = await import("../../core/sandbox/sandbox.js");
  const sbox = new Sandbox({ timeoutMs, maxOutputBytes: maxChars * 2 });
  const { child } = sbox.spawn(bin, args, effectiveSpawnOpts);

  return new Promise<RunCommandResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const byteCap = maxChars * 2 * 4; // worst-case 4 bytes/char
    const onAbort = () => sbox.kill(child);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (totalBytes >= byteCap) return;
      const remaining = byteCap - totalBytes;
      if (b.length > remaining) {
        chunks.push(b.subarray(0, remaining));
        totalBytes = byteCap;
      } else {
        chunks.push(b);
        totalBytes += b.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      sbox.cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const merged = Buffer.concat(chunks);
      const buf = smartDecodeOutput(merged);
      const output =
        buf.length > maxChars
          ? `${buf.slice(0, maxChars)}\n\n[—truncated ${buf.length - maxChars} chars —]`
          : buf;
      resolve({ exitCode: code, output, timedOut: sbox.timedOut });
    });
  });
}

export function smartDecodeOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {}
  if (process.platform === "win32") {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {}
  }
  return buf.toString("utf8");
}

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isFile?: (path: string) => boolean;
  pathDelimiter?: string;
}

export function resolveExecutable(cmd: string, opts: ResolveExecutableOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return cmd;
  if (!cmd) return cmd;
  if (cmd.includes("/") || cmd.includes("\\") || pathMod.isAbsolute(cmd)) return cmd;
  if (pathMod.extname(cmd)) return cmd;
  const env = opts.env ?? process.env;
  const pathExt = (getEnvCaseInsensitive(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const delimiter = opts.pathDelimiter ?? (platform === "win32" ? ";" : pathMod.delimiter);
  const pathDirs = (getEnvCaseInsensitive(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const isFile = opts.isFile ?? defaultIsFile;
  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      const full = pathMod.win32.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return cmd;
}

export function normalizeWindowsEnvVars(
  env: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ...env };
  const out: NodeJS.ProcessEnv = {};
  const pathValues: string[] = [];
  const pathExtValues: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (lower === "path") {
      if (typeof value === "string") pathValues.push(value);
      continue;
    }
    if (lower === "pathext") {
      if (typeof value === "string") pathExtValues.push(value);
      continue;
    }
    out[key] = value;
  }
  if (pathValues.length > 0) out.Path = mergeWindowsPathLike(pathValues, ";");
  if (pathExtValues.length > 0) out.PATHEXT = mergeWindowsPathLike(pathExtValues, ";");
  return out;
}

function getEnvCaseInsensitive(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const exact = env[key];
  if (exact !== undefined) return exact;
  const target = key.toLowerCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === target) return value;
  }
  return undefined;
}

function mergeWindowsPathLike(values: readonly string[], delimiter: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    for (const part of value.split(delimiter)) {
      const entry = part.trim();
      if (!entry) continue;
      const normalized = entry.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(entry);
    }
  }
  return merged.join(delimiter);
}

function defaultIsFile(full: string): boolean {
  try {
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

export function prepareSpawn(
  argv: readonly string[],
  opts: ResolveExecutableOptions = {},
): { bin: string; args: string[]; spawnOverrides: SpawnOptions } {
  const head = argv[0] ?? "";
  const tail = argv.slice(1);
  const platform = opts.platform ?? process.platform;
  const resolved = resolveExecutable(head, opts);
  if (platform !== "win32") return { bin: resolved, args: [...tail], spawnOverrides: {} };
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const cmdline = [resolved, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }
  if (isBareWindowsName(resolved) && resolved === head) {
    const cmdline = [head, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }
  if (isPowerShellExe(resolved)) {
    const patched = injectPowerShellUtf8(tail);
    if (patched) return { bin: resolved, args: patched, spawnOverrides: {} };
  }
  return { bin: resolved, args: [...tail], spawnOverrides: {} };
}

function isPowerShellExe(resolved: string): boolean {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(resolved);
}

export function injectPowerShellUtf8(args: readonly string[]): string[] | null {
  const prelude =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^-(?:Command|c)$/i.test(a) && i + 1 < args.length) {
      const out = [...args];
      out[i + 1] = `${prelude}${args[i + 1] ?? ""}`;
      return out;
    }
  }
  return null;
}

export function withUtf8Codepage(cmdline: string): string {
  return `chcp 65001 >nul & ${cmdline}`;
}

function isBareWindowsName(s: string): boolean {
  if (!s) return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (pathMod.isAbsolute(s)) return false;
  if (pathMod.extname(s)) return false;
  return true;
}

export function quoteForCmdExe(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
