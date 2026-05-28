/** schedule — persistent scheduled tasks (cron-style). Tasks are stored in ~/.reasonix/scheduled_tasks.json */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext, ToolRegistry } from "../tools.js";

/** Simple 5-field cron matcher: minute hour day month weekday */
function matchCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const m = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const mo = date.getMonth() + 1;
  const w = date.getDay();
  return (
    matchField(parts[0]!, m) &&
    matchField(parts[1]!, h) &&
    matchField(parts[2]!, d) &&
    matchField(parts[3]!, mo) &&
    matchField(parts[4]!, w)
  );
}

function matchField(pattern: string, val: number): boolean {
  if (pattern === "*") return true;
  // Handle "*/N" step
  if (pattern.startsWith("*/")) {
    const step = Number.parseInt(pattern.slice(2), 10);
    return step > 0 && val % step === 0;
  }
  // Handle "N-M" range
  if (pattern.includes("-")) {
    const [a, b] = pattern.split("-").map(Number);
    return val >= (a ?? 0) && val <= (b ?? 59);
  }
  return Number.parseInt(pattern, 10) === val;
}

const STORE_PATH = join(homedir(), ".reasonix", "scheduled_tasks.json");

interface ScheduledTask {
  id: number;
  cron: string;
  prompt: string;
  lastMatch: string | null; // ISO date of last cron match (updated on check)
  createdAt: string;
}

interface TaskStore {
  tasks: ScheduledTask[];
  nextId: number;
}

function load(): TaskStore {
  try {
    if (!existsSync(STORE_PATH)) return { tasks: [], nextId: 1 };
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as TaskStore;
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function save(store: TaskStore): void {
  const dir = join(homedir(), ".reasonix");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const labels = ["分", "时", "日", "月", "周"];
  return parts.map((p, i) => (p === "*" ? `每${labels[i]}` : `${p}${labels[i]}`)).join(" ");
}

export function registerScheduleTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "schedule",
    description:
      "定时任务管理。支持创建 cron 任务、列出任务、删除任务、检查到期任务。\n" +
      "cron 格式: 5 字段 (分 时 日 月 周)，如 '*/5 * * * *' = 每5分钟, '30 14 * * *' = 每天14:30\n" +
      "check 仅检查不自动执行，需要 LLM 主动调用后根据返回结果执行对应任务。任务持久化到 ~/.reasonix/scheduled_tasks.json，跨会话保存。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["create", "list", "delete", "check"],
          description: "create=创建任务, list=列出任务, delete=删除任务, check=检查到期任务",
        },
        cron: { type: "string", description: "cron 表达式（5字段）。仅 create 需要。" },
        prompt: { type: "string", description: "到期执行的任务提示。仅 create 需要。" },
        id: { type: "string", description: "任务 ID。仅 delete 需要。" },
      },
      required: ["command"],
    },
    fn: async (
      args: { command: string; cron?: string; prompt?: string; id?: string },
      _ctx?: ToolCallContext,
    ) => {
      const store = load();

      switch (args.command) {
        case "create": {
          if (!args.cron || !args.prompt)
            throw new Error("schedule: create 需要 cron 和 prompt 参数");
          const parts = args.cron.trim().split(/\s+/);
          if (parts.length !== 5)
            throw new Error("schedule: cron 格式错误，需要 5 字段 (分 时 日 月 周)");

          // Validate each field is a recognizable cron sub-expression
          for (const part of parts) {
            if (
              part === "*" ||
              /^\*\/\d+$/.test(part) ||
              /^\d+-\d+$/.test(part) ||
              /^\d+$/.test(part)
            ) {
              continue;
            }
            throw new Error(`schedule: cron 字段 "${part}" 格式无效`);
          }

          const now = new Date();
          const task: ScheduledTask = {
            id: store.nextId++,
            cron: args.cron,
            prompt: args.prompt,
            lastMatch: null,
            createdAt: now.toISOString(),
          };
          store.tasks.push(task);
          save(store);
          return `✅ 已创建定时任务 #${task.id}\n  cron: ${args.cron} (${cronToHuman(args.cron)})\n  prompt: ${args.prompt}`;
        }

        case "list": {
          if (store.tasks.length === 0) return "没有定时任务。";
          return store.tasks
            .map((t) => `  #${t.id} ${t.cron} (${cronToHuman(t.cron)}) → ${t.prompt.slice(0, 60)}`)
            .join("\n");
        }

        case "delete": {
          if (!args.id || !/^\d+$/.test(args.id))
            throw new Error("schedule: delete 需要有效的数字 id 参数");
          const idx = store.tasks.findIndex((t) => t.id === Number.parseInt(args.id!));
          if (idx < 0) throw new Error(`schedule: 找不到任务 #${args.id}`);
          store.tasks.splice(idx, 1);
          save(store);
          return `✅ 已删除任务 #${args.id}`;
        }

        case "check": {
          const now = new Date();
          const due = store.tasks.filter((t) => matchCron(t.cron, now));
          // Update lastMatch for matched tasks
          for (const t of due) t.lastMatch = now.toISOString();
          if (due.length === 0) return "当前没有到期需要执行的任务。";
          return `到期任务 (${due.length} 个):\n${due.map((t) => `  #${t.id} ${t.cron} → ${t.prompt}`).join("\n")}`;
        }

        default:
          throw new Error(`schedule: 未知命令 "${args.command}"`);
      }
    },
  });
  return registry;
}
