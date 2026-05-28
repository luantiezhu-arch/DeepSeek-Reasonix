/** powershell — execute PowerShell commands natively on Windows with proper encoding. */

import { spawn } from "node:child_process";
import type { ToolRegistry } from "../tools.js";
import { smartDecodeOutput } from "./shell/exec.js";

export function registerPowerShellTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "powershell",
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
    fn: async (args: { command: string; timeout?: number }) => {
      if (process.platform !== "win32") {
        throw new Error("powershell: 仅在 Windows 上可用");
      }

      const timeoutMs = Math.min(120_000, Math.max(5_000, (args.timeout ?? 30) * 1000));
      const ps = process.env.PROCESSOR_ARCHITECTURE?.toLowerCase().includes("arm")
        ? "pwsh.exe"
        : "powershell.exe";

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

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("powershell: 命令执行超时"));
        }, timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timer);
          const output = smartDecodeOutput(Buffer.concat(chunks));
          const errOutput = smartDecodeOutput(Buffer.concat(errChunks));
          const combined = [output, errOutput].filter(Boolean).join("\n").trim();
          if (code !== 0 && !combined) {
            reject(new Error(`powershell: 命令以退出码 ${code} 结束`));
            return;
          }
          resolve(combined || "(命令执行完毕，无输出)");
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`powershell: ${err.message}`));
        });
      });
    },
  });
  return registry;
}
