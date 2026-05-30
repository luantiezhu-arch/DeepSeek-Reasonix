/** git — structured Git operations (status, diff, log, commit, branch). */

import { execFile } from "node:child_process";
import * as pathMod from "node:path";
import { promisify } from "node:util";
import type { ToolCallContext, ToolRegistry } from "../tools.js";

const execFileAsync = promisify(execFile);

/** Run a git command and return stdout. Supports AbortSignal via ctx. 15s timeout + zombie cleanup. */
async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort("timeout"), 15_000);
  const onAbort = () => {
    clearTimeout(timeout);
    ac.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 0,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      signal: ac.signal,
    });
    return stdout.trim();
  } catch (err) {
    if ((err as { code?: string }).code === "ABORT_ERR") {
      throw new Error("git: 命令执行超时（15秒）");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function registerGitTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "git",
    description:
      "Git 操作：status/diff/log/commit/branch。" +
      '用法示例: git command:status / git command:log count:10 / git command:commit message:"fix: 修复登录bug"',
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["status", "diff", "log", "commit", "branch"],
          description:
            "Git 操作类型: status=查看状态, diff=查看变更, log=提交历史, commit=提交, branch=分支",
        },
        dir: {
          type: "string",
          description: "可选。Git 仓库目录路径。默认当前工作目录。",
        },
        count: {
          type: "integer",
          description: "可选。仅 log 命令有效，显示最近 N 条提交（默认 10）。",
        },
        message: {
          type: "string",
          description: '可选。仅 commit 命令需要：提交消息。如 "fix: 修复登录错误"',
        },
        staged: {
          type: "boolean",
          description: "可选。仅 diff 命令有效。true=只看已暂存(staged)的变更。默认只看未暂存的。",
        },
        all: {
          type: "boolean",
          description: "可选。仅 commit 命令有效。true=自动 git add -A 后再提交。",
        },
      },
      required: ["command"],
    },
    fn: async (
      args: {
        command: string;
        dir?: string;
        count?: number;
        message?: string;
        staged?: boolean;
        all?: boolean;
      },
      ctx,
    ) => {
      const signal = ctx?.signal;
      const cwd = args.dir ? pathMod.resolve(args.dir) : process.cwd();

      switch (args.command) {
        case "status": {
          const short = await git(["status", "--short"], cwd, signal);
          if (!short) {
            const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal).catch(
              () => "unknown",
            );
            return `当前分支: ${branch}\n\n工作区干净，没有未暂存的变更。`;
          }
          const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal).catch(
            () => "unknown",
          );
          const staged: string[] = [];
          const unstaged: string[] = [];
          const untracked: string[] = [];
          for (const line of short.split("\n")) {
            if (!line.trim()) continue;
            const xy = line.slice(0, 2);
            const file = line.slice(3);
            if (xy === "??") untracked.push(file);
            else if (xy.trim()) staged.push(`${xy.trim()} ${file}`);
            else unstaged.push(file);
          }
          const lines = [`当前分支: ${branch}\n`];
          if (staged.length > 0)
            lines.push(`待提交 (staged):\n${staged.map((s) => `  ${s}`).join("\n")}\n`);
          if (unstaged.length > 0)
            lines.push(`未暂存:\n${unstaged.map((s) => `  ${s}`).join("\n")}\n`);
          if (untracked.length > 0)
            lines.push(`未跟踪:\n${untracked.map((s) => `  ${s}`).join("\n")}\n`);
          return lines.join("\n");
        }

        case "diff": {
          const argsList = ["diff", "--no-color"];
          if (args.staged) argsList.push("--cached");
          try {
            const out = await git(argsList, cwd, signal);
            if (!out) return "没有变更。";
            // Truncate very large diffs
            if (out.length > 8000)
              return `${out.slice(0, 8000)}\n\n[... diff 过长，截断了 ${out.length - 8000} 字符]`;
            return out;
          } catch {
            return "无法获取 diff，可能没有 git 仓库。";
          }
        }

        case "log": {
          const count = Math.min(50, Math.max(1, args.count ?? 10));
          const format = "--format=%h %ai %an  %s";
          try {
            const out = await git(["log", `-${count}`, format, "--no-color"], cwd, signal);
            if (!out) return "没有提交记录。";
            return out;
          } catch {
            return "无法获取提交历史，可能没有 git 仓库。";
          }
        }

        case "commit": {
          if (!args.message) throw new Error("git: commit 需要 message 参数");
          try {
            if (args.all) await git(["add", "-A"], cwd, signal);
            const out = await git(["commit", "-m", args.message], cwd, signal);
            return out;
          } catch (err) {
            throw new Error(`git: 提交失败 — ${(err as Error).message}`);
          }
        }

        case "branch": {
          try {
            const out = await git(["branch", "-a"], cwd, signal);
            if (!out) return "没有分支。";
            return out;
          } catch {
            return "无法获取分支列表，可能没有 git 仓库。";
          }
        }

        default:
          throw new Error(`git: 未知命令 "${args.command}"`);
      }
    },
  });

  return registry;
}
