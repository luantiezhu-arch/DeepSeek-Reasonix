/** Task board data types. */

export type TaskColumn = "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked";
export type TaskPriority = "p0" | "p1" | "p2" | "p3";

export interface Task {
  id: string;
  title: string;
  description: string;
  column: TaskColumn;
  priority: TaskPriority;
  tags: string[];
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface TaskStore {
  tasks: Task[];
  nextId: number;
}

export const COLUMNS: TaskColumn[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
];

export const COLUMN_LABELS: Record<TaskColumn, string> = {
  backlog: "待办池",
  todo: "待执行",
  in_progress: "进行中",
  review: "审查中",
  done: "已完成",
  blocked: "已阻塞",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  p0: "紧急",
  p1: "高",
  p2: "中",
  p3: "低",
};
