/** tool_search — search and recommend tools by keyword. */

import type { ToolRegistry } from "../tools.js";

/** Heuristic relevance score: name match > description match > partial match. */
function scoreTool(name: string, desc: string, query: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const d = desc.toLowerCase();
  let score = 0;
  if (n === q)
    score += 100; // exact name match
  else if (n.startsWith(q)) score += 80;
  else if (n.includes(q)) score += 60;
  // Token-level description match
  const tokens = q.split(/[\s_]+/).filter(Boolean);
  for (const token of tokens) {
    if (d.includes(token)) score += 15;
    if (n.includes(token)) score += 10;
  }
  return score;
}

/** Category hints mapped to common query terms. */
const CATEGORY_MAP: Record<string, string[]> = {
  代码: ["code", "edit", "file", "diff", "git"],
  文件: ["file", "read", "write", "edit", "search", "filesystem"],
  网络: ["web", "fetch", "search", "url", "http"],
  运行: ["command", "run", "shell", "process", "job", "background"],
  工具: ["tool", "search", "help", "skill"],
  系统: ["sysinfo", "system", "cpu", "memory", "info"],
  定时: ["schedule", "cron", "timer", "定时"],
  通知: ["send_message", "notify", "notification"],
};

export function registerToolSearchTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "tool_search",
    description:
      "搜索当前可用的工具列表。按名称和描述匹配关键词。当你不知道用什么工具时，可以用这个来发现。\n" +
      '推荐用法: tool_search query:"推荐: 我要搜索文件内容" — 智能推荐工具。',
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: '搜索关键词，或 "推荐: 要做的事" 来智能推荐工具。',
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string }) => {
      const raw = args.query.trim();
      const isRecommend = raw.startsWith("推荐:") || raw.startsWith("推荐：");

      // Extract keywords from natural language query
      const stopWords = new Set([
        "如何",
        "怎么",
        "需要",
        "一个",
        "这个",
        "那个",
        "什么",
        "哪里",
        "什么",
        "把",
        "要",
        "用",
        "的",
        "了",
        "在",
        "是",
        "有",
      ]);
      const keywords = raw
        .toLowerCase()
        .replace(/^推荐[:：]\s*/i, "")
        .split(/[\s,，。、；;]+/)
        .filter((w) => w.length > 1 && !stopWords.has(w));

      // Expand keywords via category map
      for (const cat of Object.keys(CATEGORY_MAP)) {
        if (keywords.some((k) => cat.includes(k))) {
          keywords.push(...CATEGORY_MAP[cat]!);
        }
      }

      const specs = registry.specs();
      const scored = specs
        .map((s) => ({
          name: s.function.name,
          desc: s.function.description,
          score: scoreTool(s.function.name, s.function.description, keywords.join(" ")),
        }))
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        const simple = raw.replace(/^推荐[:：]\s*/i, "");
        // Fallback: plain keyword match
        const matches = specs
          .map((s) => ({ name: s.function.name, desc: s.function.description }))
          .filter(
            (t) =>
              t.name.toLowerCase().includes(simple.toLowerCase()) ||
              t.desc.toLowerCase().includes(simple.toLowerCase()),
          );
        if (matches.length === 0) return `没有找到匹配「${raw}」的工具。`;
        const lines = matches.map((t) => `  ${t.name} — ${t.desc.slice(0, 120)}`);
        return `找到 ${matches.length} 个匹配工具：\n${lines.join("\n")}`;
      }

      const top = scored.slice(0, 10);
      if (isRecommend) {
        const lines = top.map((t) => `  ⭐ ${t.name} (${t.score}分) — ${t.desc.slice(0, 100)}`);
        return `推荐工具（前${top.length}个）：\n${lines.join("\n")}`;
      }
      const lines = top.map((t) => `  ${t.name} — ${t.desc.slice(0, 120)}`);
      return `找到 ${scored.length} 个匹配工具（显示前${top.length}个）：\n${lines.join("\n")}`;
    },
  });
  return registry;
}
