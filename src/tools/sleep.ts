/** sleep — wait for a specified duration without holding a shell process. */

import type { ToolRegistry } from "../tools.js";

export function registerSleepTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "sleep",
    description:
      "Wait for a specified duration (in seconds). Use this when you need to wait before continuing, e.g. waiting for a service to start, a file to appear, or a download to finish. Prefer this over `run_command sleep ...` — it doesn't hold a shell process.",
    parallelSafe: true,
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
