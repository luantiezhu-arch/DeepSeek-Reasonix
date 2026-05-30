/** watch — watch files/directories for changes. */

import { watch } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { ToolRegistry } from "../tools.js";

/** Reject obvious system paths that shouldn't be watched. */
function rejectSystemPaths(p: string): void {
  // Normalize: lowercase, forward slashes, strip Windows drive letter
  const normalized = p
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^[a-z]:\/?/, "");
  const dangerous = [
    "/etc",
    "/bin",
    "/sbin",
    "/usr",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/windows",
    "/windows/system32",
    "/system volume information",
    "/program files",
    "/program files (x86)",
  ];
  for (const d of dangerous) {
    if (normalized.startsWith(`${d}/`) || normalized === d) {
      throw new Error(`[watch] 不支持的监控目标: ${pathResolve(p, "..")} (系统关键路径)`);
    }
  }
}

export function registerWatchTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "watch",
    description: "监听文件或目录变化，返回修改/创建/删除事件。适合等待构建完成或监控日志。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要监听的文件或目录路径。",
        },
        timeout: {
          type: "number",
          description: "可选。最长等待秒数（默认 60，最大 300）。到期返回超时提示。",
        },
        pattern: {
          type: "string",
          description: "可选。文件名关键词过滤，只返回匹配的文件变更。",
        },
      },
      required: ["path"],
    },
    fn: async (args: { path: string; timeout?: number; pattern?: string }, ctx) => {
      const watchPath = pathResolve(args.path);
      rejectSystemPaths(watchPath);
      const timeoutMs = Math.min(300_000, Math.max(5_000, (args.timeout ?? 60) * 1000));
      const pattern = args.pattern ? args.pattern.toLowerCase() : null;

      return new Promise<string>((resolvePromise, reject) => {
        let aborted = false;
        const cleanup = () => {
          aborted = true;
          watcher.close();
        };

        const timer = setTimeout(() => {
          cleanup();
          resolvePromise(`[watch] 已监听 ${args.path} ${args.timeout ?? 60} 秒，未检测到变化。`);
        }, timeoutMs);

        // Respect abort signal (Esc during watch)
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          resolvePromise("[watch] 监听已取消。");
        };
        ctx?.signal?.addEventListener("abort", onAbort, { once: true });

        const watcher = watch(watchPath, { recursive: true }, (eventType, filename) => {
          if (aborted) return;
          if (pattern && filename && !filename.toLowerCase().includes(pattern)) return;
          clearTimeout(timer);
          ctx?.signal?.removeEventListener("abort", onAbort);
          watcher.close();
          resolvePromise(`[watch] 检测到变化: ${eventType} — ${filename ?? watchPath}`);
        });

        watcher.on("error", (err) => {
          clearTimeout(timer);
          ctx?.signal?.removeEventListener("abort", onAbort);
          reject(new Error(`[watch] 监听失败: ${err.message}`));
        });
      });
    },
  });
  return registry;
}
