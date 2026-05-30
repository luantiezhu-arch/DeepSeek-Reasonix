/** sleep — wait for a specified duration without holding a shell process. */

import type { ToolRegistry } from "../tools.js";

export function registerSleepTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "sleep",
    description: "等待指定秒数。适合等待服务启动、文件出现等场景。比 run_command sleep 更轻量。",
    parameters: {
      type: "object",
      properties: {
        duration: {
          type: "number",
          description: "How long to wait, in seconds (e.g. 5 for 5 seconds). Max 300 (5 minutes).",
        },
        reason: {
          type: "string",
          description: "Optional reason for the sleep — helps the user understand why.",
        },
      },
      required: ["duration"],
    },
    fn: async (args: { duration: number; reason?: string }) => {
      const ms = Math.max(0, Math.min(300_000, args.duration * 1000));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Slept for ${args.duration}s${args.reason ? ` (${args.reason})` : ""}.`;
    },
  });

  return registry;
}
