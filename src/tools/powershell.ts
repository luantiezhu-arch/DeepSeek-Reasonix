/** powershell — execute PowerShell commands natively on Windows with proper encoding. */

import { spawn } from "node:child_process";
import type { ToolRegistry } from "../tools.js";
import { smartDecodeOutput } from "./shell/exec.js";

export function registerPowerShellTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "powershell",
    parallelSafe: false,
    description:
      "在 Windows 上原生执行 PowerShell 命令。支持复杂管线、对象操作和脚本。\n" +
      "自动处理 UTF-8 编码，避免中文乱码。仅 Windows 可用。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 PowerShell 命令或脚本。",
        },
        timeout: {
          type: "integer",
          description: "可选。超时秒数（默认 30，最大 120）。",
        },
      },
      required: ["command"],
    },
    fn: async (args: { command: string; timeout?: number }, ctx) => {
      if (process.platform !== "win32") {
        throw new Error("powershell: 仅在 Windows 上可用");
      }

      const timeoutMs = Math.min(120_000, Math.max(5_000, (args.timeout ?? 30) * 1000));
      const ps = "powershell.exe";

      return new Promise<string>((resolve, reject) => {
        const child = spawn(
          ps,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${args.command}`,
          ],
          {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
          },
        );

        let resolved = false;
        const finish = (result: string) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          ctx?.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const fail = (err: Error) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          ctx?.signal?.removeEventListener("abort", onAbort);
          reject(err);
        };

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

        const timer = setTimeout(() => {
          child.kill();
          fail(new Error("powershell: 命令执行超时"));
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          fail(new Error("powershell: 命令已取消"));
        };
        if (ctx?.signal?.aborted) onAbort();
        else ctx?.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          const output = smartDecodeOutput(Buffer.concat(chunks));
          const errOutput = smartDecodeOutput(Buffer.concat(errChunks));
          const combined = [output, errOutput].filter(Boolean).join("\n").trim();
          if (code !== 0 && !combined) {
            fail(new Error(`powershell: 命令以退出码 ${code} 结束`));
            return;
          }
          finish(combined || "(命令执行完毕，无输出)");
        });

        child.on("error", (err) => {
          fail(new Error(`powershell: ${err.message}`));
        });
      });
    },
  });
  return registry;
}
