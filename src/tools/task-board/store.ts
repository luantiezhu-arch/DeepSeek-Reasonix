/** Task board persistence — reads/writes ~/.reasonix/tasks.json (async, non-blocking). */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task, TaskColumn, TaskPriority, TaskStore } from "./types.js";

const STORE_PATH = join(homedir(), ".reasonix", "tasks.json");
const STORE_DIR = join(homedir(), ".reasonix");

function defaultStore(): TaskStore {
  return { tasks: [], nextId: 1 };
}

async function ensureDir(): Promise<void> {
  if (!existsSync(STORE_DIR)) await mkdir(STORE_DIR, { recursive: true });
}

export async function loadTasks(): Promise<TaskStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    return defaultStore();
  }
}

export async function saveTasks(store: TaskStore): Promise<void> {
  try {
    await ensureDir();
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // persistence must never crash the tool
  }
}

let _memoryStore: TaskStore | null = null;

/** Session-scoped store (in-memory, falls back to file on load/save). */
async function store(): Promise<TaskStore> {
  if (!_memoryStore) _memoryStore = await loadTasks();
  return _memoryStore;
}

async function persist(): Promise<void> {
  if (_memoryStore) await saveTasks(_memoryStore);
}

export async function createTask(
  title: string,
  opts?: { description?: string; column?: TaskColumn; priority?: TaskPriority; tags?: string[] },
): Promise<Task> {
  const s = await store();
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
  await persist();
  return task;
}

export async function moveTask(id: string, column: TaskColumn): Promise<Task | null> {
  const s = await store();
  const task = s.tasks.find((t) => t.id === id);
  if (!task) return null;
  task.column = column;
  task.updatedAt = new Date().toISOString();
  await persist();
  return task;
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "description" | "priority" | "tags">>,
): Promise<Task | null> {
  const s = await store();
  const task = s.tasks.find((t) => t.id === id);
  if (!task) return null;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.tags !== undefined) task.tags = updates.tags;
  task.updatedAt = new Date().toISOString();
  await persist();
  return task;
}

export async function deleteTask(id: string): Promise<boolean> {
  const s = await store();
  const idx = s.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  s.tasks.splice(idx, 1);
  await persist();
  return true;
}

export async function listTasks(opts?: {
  column?: TaskColumn;
  priority?: TaskPriority;
  tag?: string;
  search?: string;
}): Promise<Task[]> {
  const s = await store();
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
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return results;
}

export async function getTask(id: string): Promise<Task | undefined> {
  return (await store()).tasks.find((t) => t.id === id);
}

/** Count tasks in each column — useful for summary display. */
export async function countByColumn(): Promise<Record<string, number>> {
  const s = await store();
  const counts: Record<string, number> = {};
  for (const t of s.tasks) {
    counts[t.column] = (counts[t.column] ?? 0) + 1;
  }
  return counts;
}

/** Sync in-memory store from disk (for cross-session consistency). */
export async function reloadTasks(): Promise<void> {
  _memoryStore = await loadTasks();
}
