/** sysinfo — system resource monitoring (CPU, memory, disk). */

import { existsSync, statSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import type { ToolRegistry } from "../tools.js";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export function registerSysInfoTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "sysinfo",
    description: "查看系统资源：CPU、内存、运行时间、主机信息。适合诊断卡顿和内存问题。",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        disk: {
          type: "string",
          description: "可选。查看指定盘符的使用情况（Windows 如 C:，其他系统如 /）。",
        },
      },
    },
    fn: async (args: { disk?: string }) => {
      const lines: string[] = [];
      const memTotal = totalmem();
      const memFree = freemem();
      const memUsed = memTotal - memFree;
      const memPct = ((memUsed / memTotal) * 100).toFixed(1);

      lines.push(`系统: ${hostname()} — ${platform()} ${release()} (${arch()})`);
      lines.push(`运行时间: ${formatDuration(uptime())}`);
      lines.push(`CPU 核心: ${cpus().length} 核`);
      lines.push(`内存: ${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${memPct}%)`);

      if (args.disk) {
        const disk = args.disk.endsWith(":") ? `${args.disk}\\` : args.disk;
        try {
          if (existsSync(disk)) {
            const st = statSync(disk);
            // stat only gives size for files, not disk info on all platforms
            lines.push(`磁盘 ${args.disk}: 存在`);
          } else {
            lines.push(`磁盘 ${args.disk}: 无法访问`);
          }
        } catch {
          lines.push(`磁盘 ${args.disk}: 无法读取`);
        }
      } else if (process.platform === "win32") {
        lines.push("提示: 用 sysinfo disk:C: 查看 C 盘信息");
      }

      return lines.join("\n");
    },
  });
  return registry;
}
