/** watch — watch files/directories for changes. */

import { watch } from "node:fs";
import { resolve } from "node:path";
import type { ToolRegistry } from "../tools.js";

export function registerWatchTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "watch",
    description:
      "监听文件或目录的变化。当文件被修改、创建或删除时返回通知。适合监控日志文件、等待构建完成等场景。默认超时 60 秒。",
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
    fn: async (args: { path: string; timeout?: number; pattern?: string }) => {
      const watchPath = resolve(args.path);
      const timeoutMs = Math.min(300_000, Math.max(5_000, (args.timeout ?? 60) * 1000));
      const pattern = args.pattern ? args.pattern.toLowerCase() : null;

      return new Promise<string>((resolvePromise, reject) => {
        let aborted = false;
        const timer = setTimeout(() => {
          aborted = true;
          watcher.close();
          resolvePromise(`[watch] 已监听 ${args.path} ${args.timeout ?? 60} 秒，未检测到变化。`);
        }, timeoutMs);

        const watcher = watch(watchPath, { recursive: true }, (eventType, filename) => {
          if (aborted) return;
          if (pattern && filename && !filename.toLowerCase().includes(pattern)) return;
          clearTimeout(timer);
          watcher.close();
          resolvePromise(`[watch] 检测到变化: ${eventType} — ${filename ?? watchPath}`);
        });

        watcher.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`[watch] 监听失败: ${err.message}`));
        });

        // Also resolve on abort signal
      });
    },
  });
  return registry;
}
