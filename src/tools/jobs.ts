/** Background process registry for never-exiting commands; ready-signal detection short-circuits the startup wait. */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as pathMod from "node:path";
import { detectShellOperator, prepareSpawn, tokenizeCommand } from "./shell.js";

/** Kills the whole tree — `child.kill` only hits the direct child, leaving npm-spawned dev servers orphaned. */
function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      const killer = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {}
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}
}

const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;

const READY_SIGNALS: ReadonlyArray<RegExp> = [
  /\blistening on\b/i,
  /\blocal:\s+https?:\/\//i,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/i,
  /\b(?:ready|server started|started server|app listening)\b/i,
  /\bcompiled successfully\b/i,
  /\bbuild complete(?:d)?\b/i,
  /\bwatching for (?:file )?changes\b/i,
  /\bready in \d+/i,
  /\bstartup (?:complete|finished)\b/i,
];

export interface JobStartOptions {
  cwd: string;
  waitSec?: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
}

export interface JobStartResult {
  jobId: number;
  pid: number | null;
  stillRunning: boolean;
  readyMatched: boolean;
  preview: string;
  exitCode: number | null;
}

export interface JobRecord {
  id: number;
  command: string;
  pid: number | null;
  startedAt: number;
  exitCode: number | null;
  output: string;
  totalBytesWritten: number;
  running: boolean;
  spawnError?: string;
}

export class JobRegistry {
  private readonly jobs = new Map<number, InternalJob>();
  private nextId = 1;
  private static readonly MAX_COMPLETED_JOBS = 20;

  async start(command: string, opts: JobStartOptions): Promise<JobStartResult> {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("run_background: empty command");
    // Allow redirect operators (>, 2>&1, etc.) since run_background already
    // merges stdout+stderr into the job buffer. Only reject chain operators.
    const op = detectShellOperator(trimmed);
    if (op !== null && !/^(?:2>&1|&>|2>|2>>|>>|>|<)$/.test(op)) {
      throw new Error(
        `run_background: shell operator "${op}" is not supported — spawn one process per background job.`,
      );
    }
    const argv = tokenizeCommand(trimmed);
    if (argv.length === 0) throw new Error("run_background: empty command");
    const waitMs = Math.max(0, Math.min(30, opts.waitSec ?? 3)) * 1000;
    const maxBytes = opts.maxBufferBytes ?? DEFAULT_OUTPUT_CAP_BYTES;

    const { bin, args, spawnOverrides } = prepareSpawn(argv);
    const spawnOpts: SpawnOptions = {
      cwd: pathMod.resolve(opts.cwd),
      shell: false,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32",
      ...spawnOverrides,
    };

    let child: ChildProcess;
    try {
      child = spawn(bin, args, spawnOpts);
    } catch (err) {
      const id = this.nextId++;
      const job: InternalJob = {
        id,
        command: trimmed,
        pid: null,
        startedAt: Date.now(),
        exitCode: null,
        output: `[spawn failed] ${(err as Error).message}`,
        totalBytesWritten: 0,
        running: false,
        spawnError: (err as Error).message,
        child: null,
        readyPromise: Promise.resolve(),
        signalReady: () => {},
        closedPromise: Promise.resolve(),
        signalClosed: () => {},
        outputWaiters: new Set(),
      };
      this.jobs.set(id, job);
      return {
        jobId: id,
        pid: null,
        stillRunning: false,
        readyMatched: false,
        preview: job.output,
        exitCode: null,
      };
    }

    const id = this.nextId++;
    let readyResolve: () => void = () => {};
    const readyPromise = new Promise<void>((res) => {
      readyResolve = res;
    });
    let closedResolve: () => void = () => {};
    const closedPromise = new Promise<void>((res) => {
      closedResolve = res;
    });
    const job: InternalJob = {
      id,
      command: trimmed,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitCode: null,
      output: "",
      totalBytesWritten: 0,
      running: true,
      child,
      readyPromise,
      signalReady: readyResolve,
      closedPromise,
      signalClosed: closedResolve,
      outputWaiters: new Set(),
    };
    this.jobs.set(id, job);

    let readyMatched = false;
    let recentForReady = "";
    const READY_WINDOW = 1024;
    const onData = (chunk: Buffer | string) => {
      const s = chunk.toString();
      job.totalBytesWritten += s.length;
      job.output += s;
      if (job.output.length > maxBytes) {
        const overflow = job.output.length - maxBytes;
        const cut = job.output.indexOf("\n", overflow);
        const start = cut >= 0 ? cut + 1 : overflow;
        job.output = `[—older output dropped —]\n${job.output.slice(start)}`;
      }
      if (!readyMatched) {
        recentForReady = (recentForReady + s).slice(-READY_WINDOW);
        for (const re of READY_SIGNALS) {
          if (re.test(recentForReady)) {
            readyMatched = true;
            job.signalReady();
            break;
          }
        }
      }
      if (job.outputWaiters.size > 0) {
        const waiters = [...job.outputWaiters];
        job.outputWaiters.clear();
        for (const wake of waiters) wake();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      job.running = false;
      job.spawnError = err.message;
      job.signalReady();
      job.signalClosed();
    });
    const settleClosed = (code: number | null) => {
      if (!job.running && job.exitCode !== null) return;
      job.running = false;
      job.exitCode = code;
      job.signalReady();
      job.signalClosed();
      this.maybeCleanup();
    };
    child.on("exit", settleClosed);
    child.on("close", settleClosed);

    const onAbort = () => this.stop(id, { graceMs: 100 });
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      readyPromise,
      new Promise<void>((res) => {
        timer = setTimeout(res, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    return {
      jobId: id,
      pid: job.pid,
      stillRunning: job.running,
      readyMatched,
      preview: job.output,
      exitCode: job.exitCode,
    };
  }

  read(id: number, opts: { since?: number; tailLines?: number } = {}): JobReadResult | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const full = job.output;
    let slice = full;
    if (typeof opts.since === "number" && opts.since >= 0 && opts.since < full.length) {
      slice = full.slice(opts.since);
    }
    if (typeof opts.tailLines === "number" && opts.tailLines > 0) {
      const lines = slice.split("\n");
      const keep = lines.slice(Math.max(0, lines.length - opts.tailLines));
      slice = keep.join("\n");
    }
    return {
      output: slice,
      byteLength: full.length,
      running: job.running,
      exitCode: job.exitCode,
      command: job.command,
      pid: job.pid,
      spawnError: job.spawnError,
    };
  }

  async waitForJob(
    id: number,
    opts: { timeoutMs?: number; waitFor?: "exit" | "output-or-exit" } = {},
  ): Promise<JobWaitResult | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!job.running) {
      return { exited: true, exitCode: job.exitCode, latestOutput: job.output };
    }
    const timeoutMs = Math.max(0, Math.min(300_000, opts.timeoutMs ?? 5_000));
    const waitFor = opts.waitFor ?? "exit";
    const startOutput = job.output;
    const racers: Promise<void>[] = [job.closedPromise];
    let wakeOutput: (() => void) | null = null;
    if (waitFor === "output-or-exit") {
      racers.push(
        new Promise<void>((resolve) => {
          wakeOutput = resolve;
          job.outputWaiters.add(resolve);
        }),
      );
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    racers.push(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    );
    await Promise.race(racers);
    if (timer) clearTimeout(timer);
    if (wakeOutput) job.outputWaiters.delete(wakeOutput);
    return {
      exited: !job.running,
      exitCode: job.exitCode,
      latestOutput: latestOutputSince(startOutput, job.output),
    };
  }

  async stop(id: number, opts: { graceMs?: number } = {}): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!job.running || !job.child) return snapshot(job);
    const graceMs = Math.max(0, opts.graceMs ?? 2000);
    if (job.pid !== null) killProcessTree(job.pid, "SIGTERM");
    else
      try {
        job.child.kill("SIGTERM");
      } catch {}
    await Promise.race([job.closedPromise, new Promise<void>((res) => setTimeout(res, graceMs))]);
    if (job.running) {
      if (job.pid !== null) killProcessTree(job.pid, "SIGKILL");
      else
        try {
          job.child.kill("SIGKILL");
        } catch {}
      await Promise.race([job.closedPromise, new Promise<void>((res) => setTimeout(res, 5000))]);
      if (job.running) {
        job.running = false;
        job.signalClosed();
      }
    }
    return snapshot(job);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map(snapshot);
  }

  async shutdown(deadlineMs = 5000): Promise<void> {
    const start = Date.now();
    const runningJobs = [...this.jobs.values()].filter((j) => j.running && j.child);
    if (runningJobs.length === 0) return;
    for (const job of runningJobs) {
      if (job.pid !== null) killProcessTree(job.pid, "SIGTERM");
      else
        try {
          job.child?.kill("SIGTERM");
        } catch {}
    }
    const allClose = Promise.all(runningJobs.map((j) => j.readyPromise));
    const elapsed = () => Date.now() - start;
    const graceMs = Math.min(1500, Math.max(0, deadlineMs / 2));
    await Promise.race([allClose, new Promise<void>((res) => setTimeout(res, graceMs))]);
    for (const job of runningJobs) {
      if (!job.running) continue;
      if (job.pid !== null) killProcessTree(job.pid, "SIGKILL");
      else
        try {
          job.child?.kill("SIGKILL");
        } catch {}
    }
    const remaining = Math.max(800, deadlineMs - elapsed());
    await Promise.race([allClose, new Promise<void>((res) => setTimeout(res, remaining))]);
    for (const job of runningJobs) {
      if (job.running) {
        job.running = false;
        job.signalClosed();
      }
    }
  }

  runningCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.running) n++;
    return n;
  }

  private maybeCleanup(): void {
    const completed: Array<{ id: number; startedAt: number }> = [];
    for (const [id, job] of this.jobs) {
      if (!job.running) completed.push({ id, startedAt: job.startedAt });
    }
    if (completed.length <= JobRegistry.MAX_COMPLETED_JOBS) return;
    completed.sort((a, b) => a.startedAt - b.startedAt);
    const toRemove = completed.length - JobRegistry.MAX_COMPLETED_JOBS;
    for (let i = 0; i < toRemove; i++) {
      this.jobs.delete(completed[i]!.id);
    }
  }
}

interface InternalJob extends JobRecord {
  child: ChildProcess | null;
  readyPromise: Promise<void>;
  signalReady: () => void;
  closedPromise: Promise<void>;
  signalClosed: () => void;
  outputWaiters: Set<() => void>;
}

export interface JobReadResult {
  output: string;
  byteLength: number;
  running: boolean;
  exitCode: number | null;
  command: string;
  pid: number | null;
  spawnError?: string;
}

export interface JobWaitResult {
  exited: boolean;
  exitCode: number | null;
  latestOutput: string;
}

function snapshot(job: InternalJob): JobRecord {
  return {
    id: job.id,
    command: job.command,
    pid: job.pid,
    startedAt: job.startedAt,
    exitCode: job.exitCode,
    output: job.output,
    totalBytesWritten: job.totalBytesWritten,
    running: job.running,
    spawnError: job.spawnError,
  };
}

function latestOutputSince(before: string, after: string): string {
  if (!before) return after;
  if (after.startsWith(before)) return after.slice(before.length);
  return after;
}
