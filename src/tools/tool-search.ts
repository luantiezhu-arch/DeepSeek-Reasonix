/** tool_search — search available tools by keyword. */

import type { ToolRegistry } from "../tools.js";

export function registerToolSearchTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "tool_search",
    description:
      "搜索当前可用的工具列表。按名称和描述匹配关键词。当你不知道用什么工具时，可以用这个来发现。",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词，匹配工具名称和描述。",
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string }) => {
      const q = args.query.toLowerCase();
      const specs = registry.specs();
      const matches = specs
        .map((s) => ({ name: s.function.name, desc: s.function.description }))
        .filter((t) => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q));
      if (matches.length === 0) return `没有找到匹配「${args.query}」的工具。`;
      const lines = matches.map((t) => `  ${t.name} — ${t.desc.slice(0, 120)}`);
      return `找到 ${matches.length} 个匹配工具：\n${lines.join("\n")}`;
    },
  });
  return registry;
}
