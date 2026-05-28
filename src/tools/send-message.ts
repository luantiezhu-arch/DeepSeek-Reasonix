/** send_message — push a message to the user. */

import type { ToolRegistry } from "../tools.js";

export function registerSendMessageTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "send_message",
    description: "向用户推送一条消息。适合后台任务完成通知、提醒等场景。消息会直接显示在聊天中。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "要推送的消息内容。",
        },
        level: {
          type: "string",
          enum: ["info", "success", "warning", "error"],
          description: "消息级别。info=信息, success=成功, warning=警告, error=错误。默认 info。",
        },
      },
      required: ["message"],
    },
    fn: async (args: { message: string; level?: string }) => {
      const icons: Record<string, string> = {
        info: "ℹ️",
        success: "✅",
        warning: "⚠️",
        error: "❌",
      };
      const icon = icons[args.level ?? "info"] ?? "ℹ️";
      return `${icon} ${args.message}`;
    },
  });
  return registry;
}
