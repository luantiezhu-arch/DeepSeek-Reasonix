/** powershell — execute PowerShell commands natively on Windows with proper encoding. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolRegistry } from "../tools.js";

const execAsync = promisify(execFile);

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
        ? "powershell.exe"
        : "powershell.exe";

      try {
        const { stdout, stderr } = await execAsync(
          ps,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${args.command}`,
          ],
          {
            timeout: timeoutMs,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
          },
        );

        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        return output || "(命令执行完毕，无输出)";
      } catch (err: unknown) {
        const e = err as Error & { stdout?: string; stderr?: string };
        const msg = e.stdout || e.stderr || e.message || String(err);
        throw new Error(`powershell: ${msg}`);
      }
    },
  });
  return registry;
}
