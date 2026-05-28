/** task_board — persistent kanban-style task management with CLI kanban view. */

import type { ToolCallContext, ToolRegistry } from "../../tools.js";
import {
  countByColumn,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  moveTask,
  updateTask,
} from "./store.js";
import {
  COLUMNS,
  COLUMN_LABELS,
  PRIORITY_LABELS,
  type TaskColumn,
  type TaskPriority,
} from "./types.js";

function formatTasks(tasks: ReturnType<typeof listTasks>): string {
  if (tasks.length === 0) return "(没有任务)";
  return tasks
    .map((t) => {
      const col = COLUMN_LABELS[t.column] ?? t.column;
      const pri = PRIORITY_LABELS[t.priority] ?? t.priority;
      const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
      return `  #${t.id} [${col}] [${pri}]${tags} ${t.title}`;
    })
    .join("\n");
}

function formatKanban(): string {
  const counts = countByColumn();
  const lines: string[] = [];
  for (const col of COLUMNS) {
    const label = COLUMN_LABELS[col];
    const tasks = listTasks({ column: col });
    const count = counts[col] ?? 0;
    lines.push(`\n【${label}】（${count}）`);
    if (count === 0) {
      lines.push("  (空)");
      continue;
    }
    for (const t of tasks) {
      const pri = PRIORITY_LABELS[t.priority] ?? t.priority;
      const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
      lines.push(`  #${t.id} [${pri}]${tags} ${t.title}`);
    }
  }
  return lines.join("\n");
}

function formatSummary(): string {
  const counts = countByColumn();
  const parts = COLUMNS.map((c) => `${COLUMN_LABELS[c]}: ${counts[c] ?? 0}`);
  return `任务看板总览 — ${parts.join(" · ")}`;
}

export function registerTaskBoardTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "task_board",
    description:
      "持久化任务看板（kanban）。支持创建、移动、更新、删除、列表、看板视图。\n" +
      "列: backlog(待办池) → todo(待执行) → in_progress(进行中) → review(审查中) → done(已完成) | blocked(已阻塞)\n" +
      "优先级: p0(紧急) p1(高) p2(中) p3(低)\n" +
      "使用 command:kanban 以看板视图按列分组显示。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["create", "move", "update", "delete", "list", "show", "summary", "kanban"],
          description:
            "操作: create=新建, move=移动, update=更新, delete=删除, list=列表, show=详情, summary=总览, kanban=看板视图",
        },
        id: { type: "string", description: "任务 ID。用于 move/update/delete/show。" },
        title: { type: "string", description: "任务标题。用于 create。" },
        description: { type: "string", description: "任务描述。用于 create/update。" },
        column: { type: "string", enum: COLUMNS, description: "目标列。用于 move 或 create。" },
        priority: {
          type: "string",
          enum: ["p0", "p1", "p2", "p3"],
          description: "优先级。用于 create/update。",
        },
        tags: { type: "array", items: { type: "string" }, description: "标签列表。" },
        filter_column: { type: "string", enum: COLUMNS, description: "list 时按列筛选。" },
        filter_priority: {
          type: "string",
          enum: ["p0", "p1", "p2", "p3"],
          description: "list 时按优先级筛选。",
        },
        search: { type: "string", description: "list 时关键词搜索。" },
      },
      required: ["command"],
    },
    fn: async (
      args: {
        command: string;
        id?: string;
        title?: string;
        description?: string;
        column?: TaskColumn;
        priority?: TaskPriority;
        tags?: string[];
        filter_column?: TaskColumn;
        filter_priority?: TaskPriority;
        search?: string;
      },
      _ctx?: ToolCallContext,
    ) => {
      switch (args.command) {
        case "create": {
          if (!args.title) throw new Error("task_board: create 需要 title 参数");
          const task = createTask(args.title, {
            description: args.description,
            column: args.column,
            priority: args.priority,
            tags: args.tags,
          });
          const col = COLUMN_LABELS[task.column] ?? task.column;
          const pri = PRIORITY_LABELS[task.priority] ?? task.priority;
          return `✅ 已创建任务 #${task.id}\n  ${task.title}\n  列: ${col} · 优先级: ${pri}`;
        }
        case "move": {
          if (!args.id || !args.column) throw new Error("task_board: move 需要 id 和 column 参数");
          const moved = moveTask(args.id, args.column);
          if (!moved) throw new Error(`task_board: 找不到任务 #${args.id}`);
          const col = COLUMN_LABELS[moved.column] ?? moved.column;
          return `✅ 任务 #${args.id} 已移至「${col}」`;
        }
        case "update": {
          if (!args.id) throw new Error("task_board: update 需要 id 参数");
          const updated = updateTask(args.id, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            tags: args.tags,
          });
          if (!updated) throw new Error(`task_board: 找不到任务 #${args.id}`);
          return `✅ 任务 #${args.id} 已更新`;
        }
        case "delete": {
          if (!args.id) throw new Error("task_board: delete 需要 id 参数");
          if (deleteTask(args.id)) return `✅ 已删除任务 #${args.id}`;
          throw new Error(`task_board: 找不到任务 #${args.id}`);
        }
        case "list": {
          const tasks = listTasks({
            column: args.filter_column,
            priority: args.filter_priority,
            search: args.search,
          });
          return `${formatSummary()}\n${formatTasks(tasks)}`;
        }
        case "kanban": {
          return formatKanban();
        }
        case "show": {
          if (!args.id) throw new Error("task_board: show 需要 id 参数");
          const task = getTask(args.id);
          if (!task) throw new Error(`task_board: 找不到任务 #${args.id}`);
          const col = COLUMN_LABELS[task.column] ?? task.column;
          const pri = PRIORITY_LABELS[task.priority] ?? task.priority;
          const tags = task.tags.length > 0 ? `\n  标签: ${task.tags.join(", ")}` : "";
          const desc = task.description ? `\n  描述: ${task.description}` : "";
          return `#${task.id} ${task.title}\n  列: ${col} · 优先级: ${pri}${tags}${desc}\n  创建: ${task.createdAt}`;
        }
        case "summary":
          return formatSummary();
        default:
          throw new Error(`task_board: 未知命令 "${args.command}"`);
      }
    },
  });
  return registry;
}
