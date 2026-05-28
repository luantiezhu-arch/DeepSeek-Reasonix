/** Task board persistence — reads/writes ~/.reasonix/tasks.json */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task, TaskColumn, TaskPriority, TaskStore } from "./types.js";

const STORE_PATH = join(homedir(), ".reasonix", "tasks.json");

function defaultStore(): TaskStore {
  return { tasks: [], nextId: 1 };
}

function ensureDir(): void {
  const dir = join(homedir(), ".reasonix");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadTasks(): TaskStore {
  try {
    if (!existsSync(STORE_PATH)) return defaultStore();
    const raw = readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    return defaultStore();
  }
}

export function saveTasks(store: TaskStore): void {
  try {
    ensureDir();
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // persistence must never crash the tool
  }
}

let _memoryStore: TaskStore | null = null;

/** Session-scoped store (in-memory, falls back to file on load/save). */
function store(): TaskStore {
  if (!_memoryStore) _memoryStore = loadTasks();
  return _memoryStore;
}

function persist(): void {
  if (_memoryStore) saveTasks(_memoryStore);
}

export function createTask(
  title: string,
  opts?: { description?: string; column?: TaskColumn; priority?: TaskPriority; tags?: string[] },
): Task {
  const s = store();
  const now = new Date().toISOString();
  const task: Task = {
    id: String(s.nextId++),
    title,
    description: opts?.description ?? "",
    column: opts?.column ?? "backlog",
    priority: opts?.priority ?? "p2",
    tags: opts?.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  s.tasks.push(task);
  persist();
  return task;
}

export function moveTask(id: string, column: TaskColumn): Task | null {
  const s = store();
  const task = s.tasks.find((t) => t.id === id);
  if (!task) return null;
  task.column = column;
  task.updatedAt = new Date().toISOString();
  persist();
  return task;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "description" | "priority" | "tags">>,
): Task | null {
  const s = store();
  const task = s.tasks.find((t) => t.id === id);
  if (!task) return null;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.tags !== undefined) task.tags = updates.tags;
  task.updatedAt = new Date().toISOString();
  persist();
  return task;
}

export function deleteTask(id: string): boolean {
  const s = store();
  const idx = s.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  s.tasks.splice(idx, 1);
  persist();
  return true;
}

export function listTasks(opts?: {
  column?: TaskColumn;
  priority?: TaskPriority;
  tag?: string;
  search?: string;
}): Task[] {
  const s = store();
  let results = [...s.tasks];
  if (opts?.column) results = results.filter((t) => t.column === opts.column);
  if (opts?.priority) results = results.filter((t) => t.priority === opts.priority);
  if (opts?.tag) results = results.filter((t) => t.tags.includes(opts.tag!));
  if (opts?.search) {
    const q = opts.search.toLowerCase();
    results = results.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }
  // Sort: newest first
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return results;
}

export function getTask(id: string): Task | undefined {
  return store().tasks.find((t) => t.id === id);
}

/** Count tasks in each column — useful for summary display. */
export function countByColumn(): Record<string, number> {
  const s = store();
  const counts: Record<string, number> = {};
  for (const t of s.tasks) {
    counts[t.column] = (counts[t.column] ?? 0) + 1;
  }
  return counts;
}

/** Sync in-memory store from disk (for cross-session consistency). */
export function reloadTasks(): void {
  _memoryStore = loadTasks();
}
