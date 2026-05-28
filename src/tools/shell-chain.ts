/** Parse + spawn `cmd1 | cmd2 && cmd3 > out` ourselves — never invoke a shell, sidestep PS5.1's `&&` parse error and codepage drift. */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { constants, closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import * as pathMod from "node:path";
import { isDqEscape, killProcessTree, prepareSpawn, smartDecodeOutput } from "./shell.js";

export type ChainOp = "|" | "||" | "&&" | ";";
export type RedirectKind = ">" | ">>" | "<" | "2>" | "2>>" | "2>&1" | "&>";
export interface Redirect {
  kind: RedirectKind;
  target: string;
}
export interface ChainSegment {
  argv: string[];
  redirects: Redirect[];
}
export interface CommandChain {
  segments: ChainSegment[];
  ops: ChainOp[];
}

export class UnsupportedSyntaxError extends Error {
  constructor(detail: string) {
    super(`run_command: ${detail}`);
    this.name = "UnsupportedSyntaxError";
  }
}

function splitOnChainOps(cmd: string): { segs: string[]; ops: ChainOp[] } {
  const segs: string[] = [];
  const ops: ChainOp[] = [];
  let segStart = 0;
  let i = 0;
  let quote: '"' | "'" | null = null;
  let atTokenStart = true;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && isDqEscape(ch, cmd[i + 1])) i++;
      i++;
      atTokenStart = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      atTokenStart = false;
      continue;
    }
    if (ch === " " || ch === "\t") {
      i++;
      atTokenStart = true;
      continue;
    }
    if (atTokenStart) {
      let op: ChainOp | null = null;
      let opLen = 0;
      const next = cmd[i + 1];
      if (ch === "|" && next === "|") {
        op = "||";
        opLen = 2;
      } else if (ch === "&" && next === "&") {
        op = "&&";
        opLen = 2;
      } else if (ch === "|") {
        op = "|";
        opLen = 1;
      } else if (ch === ";") {
        op = ";";
        opLen = 1;
      }
      if (op !== null) {
        segs.push(cmd.slice(segStart, i));
        ops.push(op);
        i += opLen;
        segStart = i;
        atTokenStart = true;
        continue;
      }
    }
    i++;
    atTokenStart = false;
  }
  segs.push(cmd.slice(segStart));
  return { segs, ops };
}

function parseSegment(segStr: string): ChainSegment {
  const argv: string[] = [];
  const redirects: Redirect[] = [];
  let cur = "";
  let curHasContent = false;
  let pending: RedirectKind | null = null;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (!curHasContent && cur.length === 0) return;
    if (pending) {
      redirects.push({ kind: pending, target: cur });
      pending = null;
    } else argv.push(cur);
    cur = "";
    curHasContent = false;
  };
  let i = 0;
  while (i < segStr.length) {
    const ch = segStr[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && isDqEscape(ch, segStr[i + 1])) cur += segStr[++i] ?? "";
      else cur += ch;
      curHasContent = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      curHasContent = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    if (cur.length === 0 && !curHasContent) {
      const remaining = segStr.slice(i);
      let matched: { op: RedirectKind; len: number } | null = null;
      if (remaining.startsWith("2>&1")) matched = { op: "2>&1", len: 4 };
      else if (remaining.startsWith("&>")) matched = { op: "&>", len: 2 };
      else if (remaining.startsWith("2>>")) matched = { op: "2>>", len: 3 };
      else if (remaining.startsWith("2>")) matched = { op: "2>", len: 2 };
      else if (remaining.startsWith(">>")) matched = { op: ">>", len: 2 };
      else if (remaining.startsWith(">")) matched = { op: ">", len: 1 };
      else if (remaining.startsWith("<<"))
        throw new UnsupportedSyntaxError('shell operator "<<" is not supported');
      else if (remaining.startsWith("<")) matched = { op: "<", len: 1 };
      if (matched) {
        if (pending !== null)
          throw new UnsupportedSyntaxError(
            `redirect "${pending}" missing target before "${matched.op}"`,
          );
        if (matched.op === "2>&1") redirects.push({ kind: "2>&1", target: "" });
        else pending = matched.op;
        i += matched.len;
        continue;
      }
      if (ch === "&")
        throw new UnsupportedSyntaxError(
          'shell operator "&" is not supported — use run_background',
        );
    }
    cur += ch;
    curHasContent = true;
    i++;
  }
  if (quote) throw new Error(`unclosed ${quote} in command`);
  flush();
  if (pending) throw new UnsupportedSyntaxError(`redirect "${pending}" is missing a target file`);
  if (argv.length === 0 && redirects.length > 0)
    throw new UnsupportedSyntaxError("redirect without a command");
  validateRedirectFds(redirects);
  return { argv, redirects };
}

function validateRedirectFds(redirects: readonly Redirect[]): void {
  let stdin = 0;
  let stdout = 0;
  let stderr = 0;
  for (const r of redirects) {
    if (r.kind === "<") stdin++;
    else if (r.kind === ">" || r.kind === ">>") stdout++;
    else if (r.kind === "2>" || r.kind === "2>>" || r.kind === "2>&1") stderr++;
    else if (r.kind === "&>") {
      stdout++;
      stderr++;
    }
  }
  if (stdin > 1) throw new UnsupportedSyntaxError("multiple `<` stdin redirects");
  if (stdout > 1) throw new UnsupportedSyntaxError("multiple stdout redirects");
  if (stderr > 1)
    throw new UnsupportedSyntaxError(
      "multiple stderr redirects (`2>` / `2>>` / `&>` / `2>&1` conflict)",
    );
}

export function parseCommandChain(cmd: string): CommandChain | null {
  const { segs, ops } = splitOnChainOps(cmd);
  const segments: ChainSegment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const trimmed = segs[i]!.trim();
    if (trimmed.length === 0) {
      const op = i === 0 ? ops[0]! : ops[i - 1]!;
      throw new UnsupportedSyntaxError(
        i === 0
          ? `empty segment before "${op}"`
          : i === segs.length - 1
            ? `chain ends with "${op}"`
            : `empty segment between "${ops[i - 1]}" and "${ops[i]}"`,
      );
    }
    segments.push(parseSegment(trimmed));
  }
  if (ops.length === 0 && segments[0]!.redirects.length === 0) return null;
  return { segments, ops };
}

export function chainAllowed(
  chain: CommandChain,
  isAllowed: (segmentCmd: string) => boolean,
): boolean {
  for (const seg of chain.segments) {
    if (!isAllowed(seg.argv.join(" "))) return false;
  }
  return true;
}

export interface ChainResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

interface ChainGroup {
  segments: ChainSegment[];
  opBefore: Exclude<ChainOp, "|"> | null;
}

function groupChain(chain: CommandChain): ChainGroup[] {
  const groups: ChainGroup[] = [{ segments: [chain.segments[0]!], opBefore: null }];
  for (let i = 0; i < chain.ops.length; i++) {
    const op = chain.ops[i]!;
    const next = chain.segments[i + 1]!;
    if (op === "|") groups[groups.length - 1]!.segments.push(next);
    else groups.push({ segments: [next], opBefore: op });
  }
  return groups;
}

export interface RunChainOptions {
  cwd: string;
  timeoutSec: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export async function runChain(chain: CommandChain, opts: RunChainOptions): Promise<ChainResult> {
  const groups = groupChain(chain);
  const buf = new OutputBuffer(opts.maxOutputChars * 2 * 4);
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let lastExit: number | null = 0;
  const sandboxRoot = realpathSync(pathMod.resolve(opts.cwd));
  let timedOut = false;
  let cwd = opts.cwd;

  for (const group of groups) {
    if (group.opBefore === "&&" && lastExit !== 0) continue;
    if (group.opBefore === "||" && lastExit === 0) continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }

    // Handle cd X && cmd pattern: resolve directory, update cwd, skip spawning
    const firstSeg = group.segments[0]!;
    const firstCmd = firstSeg.argv[0] ?? "";
    if (
      firstCmd.toLowerCase() === "cd" &&
      firstSeg.argv.length >= 2 &&
      group.segments.length === 1
    ) {
      const target = pathMod.resolve(cwd, firstSeg.argv[1]!);
      try {
        const realTarget = realpathSync(target);
        ensureUnderSandbox(realTarget, sandboxRoot, firstSeg.argv[1]!);
        cwd = realTarget;
      } catch {
        buf.push(Buffer.from(`cd: ${target}: No such directory\n`));
        lastExit = 1;
      }
      continue;
    }

    const result = await runPipeGroup(group.segments, {
      cwd,
      timeoutMs: remainingMs,
      buf,
      signal: opts.signal,
    });
    lastExit = result.exitCode;
    if (result.timedOut) {
      timedOut = true;
      break;
    }
    if (opts.signal?.aborted) break;
  }
  const output = buf.toString();
  const truncated =
    output.length > opts.maxOutputChars
      ? `${output.slice(0, opts.maxOutputChars)}\n\n[—truncated ${output.length - opts.maxOutputChars} chars —]`
      : output;
  return { exitCode: lastExit, output: truncated, timedOut };
}

interface PipeGroupResult {
  exitCode: number | null;
  timedOut: boolean;
}
interface PipeGroupOptions {
  cwd: string;
  timeoutMs: number;
  buf: OutputBuffer;
  signal?: AbortSignal;
}
interface SegmentStdio {
  stdinFd: number | null;
  stdoutFd: number | null;
  stderrFd: number | null;
  mergeStderrToStdout: boolean;
  toClose: number[];
}

function expandEnvVars(argv: string[]): string[] {
  return argv.map((token) =>
    token
      .replace(/\$(\w+)/g, (_m, name) => process.env[name] ?? _m)
      .replace(/\$\{(\w+)\}/g, (_m, name) => process.env[name] ?? _m)
      .replace(/%(\w+)%/g, (_m, name) => process.env[name] ?? _m),
  );
}

export function isNullDeviceAlias(target: string): boolean {
  const lower = target.toLowerCase();
  return lower === "/dev/null" || (process.platform === "win32" && lower === "nul");
}

function pathIsUnder(child: string, parent: string): boolean {
  const rel = pathMod.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !pathMod.isAbsolute(rel));
}

function openFlags(mode: "r" | "w" | "a"): number {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  if (mode === "r") return constants.O_RDONLY | noFollow;
  if (mode === "w") return constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow;
  return constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow;
}

function ensureUnderSandbox(path: string, sandboxRoot: string, target: string): void {
  if (!pathIsUnder(path, sandboxRoot))
    throw new Error(`redirect target "${target}" escapes sandbox`);
}

function resolveRedirectTarget(target: string, cwd: string): string {
  const lexicalRoot = pathMod.resolve(cwd);
  const sandboxRoot = realpathSync(lexicalRoot);
  const resolved = pathMod.resolve(lexicalRoot, target);
  ensureUnderSandbox(resolved, lexicalRoot, target);
  try {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`redirect target "${target}" is a symbolic link`);
    ensureUnderSandbox(realpathSync(resolved), sandboxRoot, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    ensureUnderSandbox(realpathSync(pathMod.dirname(resolved)), sandboxRoot, target);
  }
  return resolved;
}

function validateRedirectTargets(redirects: readonly Redirect[], cwd: string): void {
  for (const r of redirects) {
    if (r.kind === "2>&1" || !r.target || isNullDeviceAlias(r.target)) continue;
    resolveRedirectTarget(r.target, cwd);
  }
}

function openRedirects(redirects: readonly Redirect[], cwd: string): SegmentStdio {
  validateRedirectTargets(redirects, cwd);
  let stdinFd: number | null = null;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  let mergeStderrToStdout = false;
  let bothFd: number | null = null;
  const toClose: number[] = [];
  const open = (target: string, flags: "r" | "w" | "a"): number => {
    const resolved = isNullDeviceAlias(target) ? devNull : resolveRedirectTarget(target, cwd);
    const fd = openSync(resolved, openFlags(flags), 0o666);
    toClose.push(fd);
    return fd;
  };
  for (const r of redirects) {
    if (r.kind === "<") stdinFd = open(r.target, "r");
    else if (r.kind === ">") stdoutFd = open(r.target, "w");
    else if (r.kind === ">>") stdoutFd = open(r.target, "a");
    else if (r.kind === "2>") stderrFd = open(r.target, "w");
    else if (r.kind === "2>>") stderrFd = open(r.target, "a");
    else if (r.kind === "&>") {
      bothFd = open(r.target, "w");
      stdoutFd = bothFd;
      stderrFd = bothFd;
    } else if (r.kind === "2>&1") mergeStderrToStdout = true;
  }
  return { stdinFd, stdoutFd, stderrFd, mergeStderrToStdout, toClose };
}

async function runPipeGroup(
  segments: ChainSegment[],
  opts: PipeGroupOptions,
): Promise<PipeGroupResult> {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const children: ChildProcess[] = [];
  const allFds: number[] = [];
  let timedOut = false;
  const killAll = () => {
    for (const c of children) killProcessTree(c);
  };
  const killTimer = setTimeout(() => {
    timedOut = true;
    killAll();
  }, opts.timeoutMs);
  const onAbort = () => killAll();
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (let i = 0; i < segments.length; i++) {
      const isFirst = i === 0;
      const isLast = i === segments.length - 1;
      const seg = segments[i]!;
      const io = openRedirects(seg.redirects, opts.cwd);
      allFds.push(...io.toClose);
      seg.argv = expandEnvVars(seg.argv);
      const { bin, args, spawnOverrides } = prepareSpawn(seg.argv);
      const stdoutSpec = io.stdoutFd !== null ? io.stdoutFd : "pipe";
      const stderrSpec =
        io.stderrFd !== null ? io.stderrFd : io.mergeStderrToStdout ? stdoutSpec : "pipe";
      const stdinSpec = io.stdinFd !== null ? io.stdinFd : isFirst ? "ignore" : "pipe";
      const spawnOpts: SpawnOptions = {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        env,
        stdio: [stdinSpec, stdoutSpec, stderrSpec],
        ...spawnOverrides,
      };
      let child: ChildProcess;
      try {
        child = spawn(bin, args, spawnOpts);
      } catch (err) {
        for (const fd of allFds) tryClose(fd);
        killAll();
        clearTimeout(killTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        throw err;
      }
      children.push(child);
      if (!isFirst && io.stdinFd === null) {
        const prev = children[i - 1]!;
        prev.stdout?.on("error", () => {});
        child.stdin?.on("error", () => {});
        const prevMergesStderr =
          segments[i - 1]!.redirects.some((r) => r.kind === "2>&1") && !!prev.stderr;
        if (prevMergesStderr && prev.stderr) {
          prev.stderr.on("error", () => {});
          let openSources = 2;
          const closeIfDone = () => {
            if (--openSources === 0) child.stdin?.end();
          };
          prev.stdout?.pipe(child.stdin!, { end: false });
          prev.stderr.pipe(child.stdin!, { end: false });
          prev.stdout?.once("end", closeIfDone);
          prev.stderr.once("end", closeIfDone);
        } else prev.stdout?.pipe(child.stdin!);
      }
      if (child.stderr && io.stderrFd === null && !(io.mergeStderrToStdout && !isLast))
        child.stderr.on("data", (chunk) => opts.buf.push(toBuf(chunk)));
      if (isLast && child.stdout && io.stdoutFd === null) {
        child.stdout.on("data", (chunk) => opts.buf.push(toBuf(chunk)));
        if (io.mergeStderrToStdout && child.stderr && io.stderrFd === null) {
          child.stderr.removeAllListeners("data");
          child.stderr.on("data", (chunk) => opts.buf.push(toBuf(chunk)));
        }
      }
    }
    const exits = await Promise.all(
      children.map(
        (c) =>
          new Promise<number | null>((resolve) => {
            c.once("error", () => resolve(null));
            c.once("close", (code) => resolve(code));
          }),
      ),
    );
    return { exitCode: exits[exits.length - 1] ?? null, timedOut };
  } finally {
    for (const fd of allFds) tryClose(fd);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function tryClose(fd: number): void {
  try {
    closeSync(fd);
  } catch {}
}
function toBuf(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly cap: number) {}
  push(b: Buffer): void {
    if (this.bytes >= this.cap) return;
    const remaining = this.cap - this.bytes;
    if (b.length > remaining) {
      this.chunks.push(b.subarray(0, remaining));
      this.bytes = this.cap;
    } else {
      this.chunks.push(b);
      this.bytes += b.length;
    }
  }
  toString(): string {
    return smartDecodeOutput(Buffer.concat(this.chunks));
  }
}
