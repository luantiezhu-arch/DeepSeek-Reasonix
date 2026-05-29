/**
 * Sandbox — native execution isolation for Reasonix.
 *
 * Provides a reusable Sandbox class that wraps subprocess spawn with:
 * - Pre-spawn security checks (command substitution, env hijack, dangerous patterns)
 * - Temp directory isolation (auto-create + auto-cleanup)
 * - Environment variable sanitization
 * - Hard timeout + forced kill
 * - Process tree tracking for cleanup
 * - Integration with the permission rule system
 *
 * Usage:
 *   const box = new Sandbox({ isolate: true, sanitizeEnv: true, timeoutMs: 30000 });
 *   const { child } = box.spawn("ls", ["-la"]);
 *   await box.waitFor(child);
 *   box.cleanup(); // kills process + removes temp dir
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PermissionAction, type PermissionResult, globalPermissions } from "./permissions.js";
import { checkCommandSafety } from "./security.js";

export interface SandboxOptions {
  /** Create an isolated temp directory as the sandbox root. */
  isolate?: boolean;
  /** Strip dangerous env vars (LD_PRELOAD, etc.) and optional allowlist. */
  sanitizeEnv?: boolean;
  /** Env vars to KEEP when sanitizeEnv is true (besides PATH/TMP/SystemRoot). */
  envAllowlist?: string[];
  /** Max execution time before forced kill. 0 = no timeout. */
  timeoutMs?: number;
  /** Max output bytes. 0 = no limit. */
  maxOutputBytes?: number;
  /** When set to "deny", reject commands that don't pass permissions. */
  permissionMode?: PermissionAction;
}

export interface SandboxSpawnResult {
  child: ChildProcess;
  sandbox: Sandbox;
  /** Resolved working directory (temp dir if isolate=true). */
  cwd: string;
  /** Resolved environment. */
  env: NodeJS.ProcessEnv;
  /** Permission check result (if permissionMode is set). */
  permission?: PermissionResult;
  /** Security check result. */
  security?: { safe: boolean; reason?: string };
}

const SANITIZE_KEEP = new Set([
  "PATH",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SystemRoot",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
]);

const HIJACK_BLOCK = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "LD_AUDIT",
  "LD_DEBUG",
]);

export class Sandbox {
  readonly options: SandboxOptions;
  private tempDir: string | null = null;
  private children: ChildProcess[] = [];
  private cleaned = false;
  /** True when the hard timeout fired. Read after exec()/waitFor() to check for timeout exit. */
  timedOut = false;

  constructor(options: SandboxOptions = {}) {
    this.options = {
      isolate: false,
      sanitizeEnv: false,
      timeoutMs: 0,
      maxOutputBytes: 0,
      permissionMode: undefined,
      ...options,
    };
  }

  /** Create temp directory if isolation requested. Auto-cleaned on process exit. */
  init(): void {
    if (this.options.isolate && !this.tempDir) {
      this.tempDir = mkdtempSync(join(tmpdir(), "reasonix-sandbox-"));
      // Auto-cleanup on unexpected exit (crash, kill)
      const cleanupSelf = () => this.cleanup();
      process.once("exit", cleanupSelf);
      process.once("SIGTERM", cleanupSelf);
    }
  }

  /** Resolve the effective working directory. */
  getCwd(originalCwd?: string): string {
    return this.tempDir ?? originalCwd ?? process.cwd();
  }

  /** Build sanitized environment. */
  buildEnv(originalEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    if (!this.options.sanitizeEnv) return { ...originalEnv };

    const out: NodeJS.ProcessEnv = {};
    for (const [key, val] of Object.entries(originalEnv)) {
      if (!key) continue;
      const upper = key.toUpperCase();
      if (HIJACK_BLOCK.has(upper)) continue; // strip hijack vars
      if (SANITIZE_KEEP.has(upper) || this.options.envAllowlist?.includes(key)) {
        if (val !== undefined) out[key] = val;
        continue;
      }
      // Strip unknown vars unless they look like safe system vars
      if (
        upper.startsWith("SYSTEM") ||
        upper.startsWith("WINDOWS") ||
        upper === "PROCESSOR_ARCHITECTURE"
      ) {
        if (val !== undefined) out[key] = val;
      }
    }
    return out;
  }

  /**
   * Pre-flight checks: security + permissions.
   * Throws if blocked by security checks.
   * Returns permission result if permissionMode is set.
   */
  preflight(cmd: string): {
    security: { safe: boolean; reason?: string };
    permission?: PermissionResult;
  } {
    // Security check
    const security = checkCommandSafety(cmd);
    if (!security.safe) {
      throw new Error(`[沙箱安全检查未通过] ${security.reason}`);
    }

    // Permission check (optional)
    let permission: PermissionResult | undefined;
    if (this.options.permissionMode) {
      permission = globalPermissions.evaluate(cmd);
      if (this.options.permissionMode === "deny" && permission.action !== "allow") {
        throw new Error(`[沙箱权限拒绝] ${permission.message}`);
      }
    }

    return { security, permission };
  }

  /**
   * Spawn a command inside the sandbox.
   * Runs pre-flight checks, creates temp dir, sanitizes env, then spawns.
   */
  spawn(bin: string, args: readonly string[], spawnOpts: SpawnOptions = {}): SandboxSpawnResult {
    if (this.cleaned) throw new Error("Sandbox has already been cleaned up");

    const command = [bin, ...args].join(" ");
    const { permission } = this.preflight(command);

    this.init();
    const cwd = this.getCwd(spawnOpts.cwd as string | undefined);
    const env = this.buildEnv(spawnOpts.env as NodeJS.ProcessEnv | undefined);

    const effectiveOpts: SpawnOptions = {
      ...spawnOpts,
      cwd,
      env,
      shell: false,
      windowsHide: true,
    };

    const child = spawn(bin, args as string[], effectiveOpts);
    this.children.push(child);

    // Hard timeout
    if (this.options.timeoutMs && this.options.timeoutMs > 0) {
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.kill(child);
      }, this.options.timeoutMs);
      child.on("close", () => clearTimeout(timer));
    }

    return { child, sandbox: this, cwd, env, permission, security: { safe: true } };
  }

  /** Kill a specific child (tree kill). */
  kill(child: ChildProcess): void {
    if (!child.pid || child.killed) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    } catch {
      // already dead
    }
  }

  /** Cleanup: kill all children + remove temp dir. */
  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;

    for (const child of this.children) {
      this.kill(child);
    }
    this.children = [];

    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.tempDir = null;
    }
  }

  /** Promise wrapper: spawn, wait for exit, cleanup, return output. */
  async exec(
    bin: string,
    args: readonly string[],
    opts: { signal?: AbortSignal; cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const { child } = this.spawn(bin, args, opts);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

    const onAbort = () => this.kill(child);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    return new Promise((resolve, reject) => {
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        this.cleanup();
        resolve({
          stdout: Buffer.concat(chunks).toString("utf-8"),
          stderr: Buffer.concat(errChunks).toString("utf-8"),
          exitCode: code,
        });
      });
      child.on("error", (err) => {
        opts.signal?.removeEventListener("abort", onAbort);
        this.cleanup();
        reject(err);
      });
    });
  }

  getTempDir(): string | null {
    return this.tempDir;
  }
}

/**
 * Quick one-shot: create Sandbox, exec, cleanup.
 * Returns { stdout, stderr, exitCode }.
 */
export async function sandboxExec(
  bin: string,
  args: readonly string[],
  opts: SandboxOptions & { signal?: AbortSignal; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const box = new Sandbox(opts);
  return box.exec(bin, args, opts);
}
