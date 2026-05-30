/** schedule — persistent cron tasks, stored in ~/.reasonix/scheduled_tasks.json. */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  if (pattern.startsWith("*/")) {
    const step = Number.parseInt(pattern.slice(2), 10);
    return step > 0 && val % step === 0;
  }
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
  lastMatch: string | null; // ISO date of last cron match (updated on check / background fire)
  createdAt: string;
}

interface TaskStore {
  tasks: ScheduledTask[];
  nextId: number;
}

async function load(): Promise<TaskStore> {
  try {
    if (!existsSync(STORE_PATH)) return { tasks: [], nextId: 1 };
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

async function save(store: TaskStore): Promise<void> {
  const dir = join(homedir(), ".reasonix");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const labels = ["分", "时", "日", "月", "周"];
  return parts.map((p, i) => (p === "*" ? `每${labels[i]}` : `${p}${labels[i]}`)).join(" ");
}

/* ------------------------------------------------------------------ */
/*  Background scheduler loop                                         */
/* ------------------------------------------------------------------ */

let _schedulerTimer: ReturnType<typeof setInterval> | null = null;
/** Track the last minute each task was fired in, so we don't re-fire within the same minute. */
const _lastFiredMinute = new Map<number, number>();
let _registry: ToolRegistry | null = null;

const SCHEDULER_INTERVAL_MS = 15_000; // check every 15 seconds

async function schedulerTick(): Promise<void> {
  const store = await load();
  if (store.tasks.length === 0) return;
  const now = new Date();
  const minuteKey =
    now.getFullYear() * 1000000 +
    now.getMonth() * 10000 +
    now.getDate() * 100 +
    now.getHours() * 60 +
    now.getMinutes();

  let modified = false;
  for (const task of store.tasks) {
    if (!matchCron(task.cron, now)) continue;
    const last = _lastFiredMinute.get(task.id);
    if (last === minuteKey) continue; // already fired this minute

    // Mark fired
    _lastFiredMinute.set(task.id, minuteKey);
    task.lastMatch = now.toISOString();
    modified = true;

    // Fire notification via send_message if registry is available
    if (_registry?.has("send_message")) {
      const msg = `⏰ 定时任务 #${task.id} 触发\n  cron: ${task.cron} (${cronToHuman(task.cron)})\n  任务: ${task.prompt}`;
      _registry
        .dispatch("send_message", JSON.stringify({ message: msg, level: "info" }))
        .catch(() => {});
    }
  }
  if (modified) await save(store);
}

/** Clear scheduler state — call on session reset (/new) to prevent state leaks. */
export function resetScheduleState(): void {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
  }
  _lastFiredMinute.clear();
  _registry = null;
}

/* ------------------------------------------------------------------ */
/*  Tool registration
 */
/* ------------------------------------------------------------------ */

export function registerScheduleTool(registry: ToolRegistry): ToolRegistry {
  _registry = registry;

  registry.register({
    name: "schedule",
    description:
      "定时任务管理。支持创建 cron 任务、列出任务、删除任务、检查到期任务、启动/停止后台调度器。\n" +
      "cron 格式: 5 字段 (分 时 日 月 周)，如 '*/5 * * * *' = 每5分钟, '30 14 * * *' = 每天14:30\n" +
      "start — 启动后台调度器（每15秒自动检查到期任务并推送通知）\n" +
      "stop — 停止后台调度器\n" +
      "任务持久化到 ~/.reasonix/scheduled_tasks.json，跨会话保存。后台调度器仅在当前会话运行。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["create", "list", "delete", "check", "start", "stop", "status"],
          description:
            "create=创建, list=列出, delete=删除, check=检查到期, start=启动调度器, stop=停止调度器, status=调度器状态",
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
      const store = await load();

      switch (args.command) {
        case "create": {
          if (!args.cron || !args.prompt)
            throw new Error("schedule: create 需要 cron 和 prompt 参数");
          const parts = args.cron.trim().split(/\s+/);
          if (parts.length !== 5)
            throw new Error("schedule: cron 格式错误，需要 5 字段 (分 时 日 月 周)");

          for (const part of parts) {
            if (part === "*" || /^\d+$/.test(part)) continue;
            const stepMatch = part.match(/^\*\/(\d+)$/);
            if (stepMatch) {
              if (Number.parseInt(stepMatch[1]!, 10) > 0) continue;
              throw new Error(`schedule: cron 步进 "${part}" 无效（步进必须 >0）`);
            }
            const rangeMatch = part.match(/^(\d+)-(\d+)$/);
            if (rangeMatch) {
              if (Number.parseInt(rangeMatch[1]!, 10) <= Number.parseInt(rangeMatch[2]!, 10))
                continue;
              throw new Error(`schedule: cron 范围 "${part}" 无效（起始值须 ≤ 终止值）`);
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
          await save(store);
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
          _lastFiredMinute.delete(Number.parseInt(args.id!));
          await save(store);
          return `✅ 已删除任务 #${args.id}`;
        }

        case "check": {
          const now = new Date();
          const due = store.tasks.filter((t) => matchCron(t.cron, now));
          for (const t of due) t.lastMatch = now.toISOString();
          if (due.length === 0) return "当前没有到期需要执行的任务。";
          return `到期任务 (${due.length} 个):\n${due.map((t) => `  #${t.id} ${t.cron} → ${t.prompt}`).join("\n")}`;
        }

        case "start": {
          if (_schedulerTimer) return "⚠️ 后台调度器已在运行。";
          _schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
          _schedulerTimer.unref(); // don't keep process alive for scheduler
          return "✅ 后台调度器已启动（每15秒检查一次到期任务，通过 send_message 推送通知）。";
        }

        case "stop": {
          if (!_schedulerTimer) return "⚠️ 后台调度器未运行。";
          clearInterval(_schedulerTimer);
          _schedulerTimer = null;
          _lastFiredMinute.clear();
          return "✅ 后台调度器已停止。";
        }

        case "status": {
          const running = _schedulerTimer !== null;
          const taskCount = store.tasks.length;
          const due =
            taskCount > 0 ? store.tasks.filter((t) => matchCron(t.cron, new Date())).length : 0;
          return `当前到期任务: ${due}\n任务总数: ${taskCount}\n后台调度器: ${running ? "🟢 运行中" : "⚪ 已停止"}`;
        }

        default:
          throw new Error(`schedule: 未知命令 "${args.command}"`);
      }
    },
  });
  return registry;
}
