/** send_message — push a message to the user. Optionally wires external notification (QQ, etc). */

import type { ToolRegistry } from "../tools.js";

/** Global notify hook — set by chat.tsx / App.tsx when QQ channel is available. */
let _notifyHook: ((message: string, level: string) => void) | null = null;

/** Wire an external notification channel (e.g. QQ sendResponse) to send_message. */
/** Clear notification hook on /new — prevents stale QQ references. */
export function resetSendMessageNotify(): void {
  _notifyHook = null;
}

export function setSendMessageNotify(
  hook: ((message: string, level: string) => void) | null,
): void {
  _notifyHook = hook;
}

export function registerSendMessageTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "send_message",
    description: "向用户推送消息。支持 info/success/warning/error 级别。绑定了 QQ 时自动推送。",
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
      const level = args.level ?? "info";
      const icon = icons[level] ?? "ℹ️";
      // Fire external notification (QQ, etc.) asynchronously
      _notifyHook?.(args.message, level);
      return `${icon} ${args.message}`;
    },
  });
  return registry;
}
