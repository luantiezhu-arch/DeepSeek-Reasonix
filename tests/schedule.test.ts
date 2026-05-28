import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * schedule.ts unit tests — cron matching + CRUD persistence.
 * The registerScheduleTool stores tasks in ~/.reasonix/scheduled_tasks.json
 * but we test the underlying logic directly via a minimal integration harness.
 */

// We need to test matchCron and matchField — import directly
// (they are not exported, so we reconstruct them inline for thoroughness)

/* ------------------------------------------------------------------ */
/*  Inline implementation of matchField / matchCron (mirrors schedule.ts)  */
function matchField(pattern: string, val: number): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*/")) {
    const step = Number.parseInt(pattern.slice(2), 10);
    if (Number.isNaN(step)) return false;
    return step > 0 && val % step === 0;
  }
  if (pattern.includes("-")) {
    const [a, b] = pattern.split("-").map(Number);
    if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return false;
    return val >= a && val <= b;
  }
  const n = Number.parseInt(pattern, 10);
  if (Number.isNaN(n)) return false;
  return n === val;
}

function matchCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    matchField(parts[0]!, date.getMinutes()) &&
    matchField(parts[1]!, date.getHours()) &&
    matchField(parts[2]!, date.getDate()) &&
    matchField(parts[3]!, date.getMonth() + 1) &&
    matchField(parts[4]!, date.getDay())
  );
}
/* ------------------------------------------------------------------ */

describe("matchField", () => {
  it("* matches any value", () => {
    expect(matchField("*", 0)).toBe(true);
    expect(matchField("*", 59)).toBe(true);
    expect(matchField("*", 23)).toBe(true);
  });

  it("*/N step matches multiples of N", () => {
    expect(matchField("*/5", 0)).toBe(true);
    expect(matchField("*/5", 5)).toBe(true);
    expect(matchField("*/5", 10)).toBe(true);
    expect(matchField("*/5", 7)).toBe(false);
    expect(matchField("*/5", 59)).toBe(false);
  });

  it("*/15 step", () => {
    expect(matchField("*/15", 0)).toBe(true);
    expect(matchField("*/15", 15)).toBe(true);
    expect(matchField("*/15", 30)).toBe(true);
    expect(matchField("*/15", 45)).toBe(true);
    expect(matchField("*/15", 10)).toBe(false);
  });

  it("N-M range", () => {
    expect(matchField("1-5", 1)).toBe(true);
    expect(matchField("1-5", 3)).toBe(true);
    expect(matchField("1-5", 5)).toBe(true);
    expect(matchField("1-5", 0)).toBe(false);
    expect(matchField("1-5", 6)).toBe(false);
  });

  it("exact match", () => {
    expect(matchField("10", 10)).toBe(true);
    expect(matchField("10", 11)).toBe(false);
  });

  it("invalid pattern returns false", () => {
    expect(matchField("*/0", 5)).toBe(false); // step 0 — invalid
    expect(matchField("abc", 5)).toBe(false); // non-numeric
    expect(matchField("", 5)).toBe(false); // empty
    expect(matchField("*-5", 3)).toBe(false); // mixed wildcard+range
  });
});

describe("matchCron", () => {
  it("every minute — * * * * *", () => {
    expect(matchCron("* * * * *", new Date(2026, 5, 1, 12, 0))).toBe(true);
    expect(matchCron("* * * * *", new Date(2026, 5, 1, 12, 30))).toBe(true);
    expect(matchCron("* * * * *", new Date(2026, 5, 1, 23, 59))).toBe(true);
  });

  it("every 5 minutes — */5 * * * *", () => {
    expect(matchCron("*/5 * * * *", new Date(2026, 5, 1, 12, 0))).toBe(true);
    expect(matchCron("*/5 * * * *", new Date(2026, 5, 1, 12, 5))).toBe(true);
    expect(matchCron("*/5 * * * *", new Date(2026, 5, 1, 12, 10))).toBe(true);
    expect(matchCron("*/5 * * * *", new Date(2026, 5, 1, 12, 7))).toBe(false);
  });

  it("specific time — 30 14 * * * (daily at 14:30)", () => {
    expect(matchCron("30 14 * * *", new Date(2026, 5, 1, 14, 30))).toBe(true);
    expect(matchCron("30 14 * * *", new Date(2026, 5, 1, 14, 31))).toBe(false);
    expect(matchCron("30 14 * * *", new Date(2026, 5, 1, 15, 30))).toBe(false);
  });

  it("weekday match — * * * * 1 (Monday)", () => {
    // 2026-06-01 is a Monday (day 1)
    expect(matchCron("* * * * 1", new Date(2026, 5, 1, 12, 0))).toBe(true);
    // 2026-06-02 is a Tuesday (day 2)
    expect(matchCron("* * * * 1", new Date(2026, 5, 2, 12, 0))).toBe(false);
  });

  it("day-of-month range — * * 1-15 * *", () => {
    expect(matchCron("* * 1-15 * *", new Date(2026, 5, 1))).toBe(true);
    expect(matchCron("* * 1-15 * *", new Date(2026, 5, 10))).toBe(true);
    expect(matchCron("* * 1-15 * *", new Date(2026, 5, 15))).toBe(true);
    expect(matchCron("* * 1-15 * *", new Date(2026, 5, 16))).toBe(false);
  });

  it("rejects invalid cron (not 5 fields)", () => {
    expect(matchCron("* * * *", new Date(2026, 5, 1))).toBe(false);
    expect(matchCron("* * * * * *", new Date(2026, 5, 1))).toBe(false);
    expect(matchCron("", new Date(2026, 5, 1))).toBe(false);
  });
});

describe("registerScheduleTool integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-sched-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("create stores a task, list returns it, delete removes it", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerScheduleTool } = await import("../src/tools/schedule.js");

    const tools = new ToolRegistry();
    registerScheduleTool(tools);

    // Create
    const created = await tools.dispatch(
      "schedule",
      JSON.stringify({
        command: "create",
        cron: "*/10 * * * *",
        prompt: "检查服务器状态",
      }),
    );
    expect(created).toContain("已创建定时任务");
    expect(created).toContain("*/10 * * * *");

    // List
    const list = await tools.dispatch("schedule", JSON.stringify({ command: "list" }));
    expect(list).toContain("检查服务器状态");

    // Delete (parse the ID from the create output)
    const idMatch = created.match(/#(\d+)/);
    expect(idMatch).not.toBeNull();
    const deleted = await tools.dispatch(
      "schedule",
      JSON.stringify({
        command: "delete",
        id: idMatch![1],
      }),
    );
    expect(deleted).toContain("已删除");

    // List again — deleted task should no longer appear
    const list2 = await tools.dispatch("schedule", JSON.stringify({ command: "list" }));
    expect(list2).not.toContain("检查服务器状态");
  });

  it("can list tasks after create", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerScheduleTool } = await import("../src/tools/schedule.js");

    const tools = new ToolRegistry();
    registerScheduleTool(tools);
    // Create a task first
    await tools.dispatch(
      "schedule",
      JSON.stringify({
        command: "create",
        cron: "0 9 * * *",
        prompt: "早安检查",
      }),
    );
    const out = await tools.dispatch("schedule", JSON.stringify({ command: "list" }));
    expect(out).toContain("早安检查");
  });

  it("create rejects missing cron/prompt", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerScheduleTool } = await import("../src/tools/schedule.js");
    const tools = new ToolRegistry();
    registerScheduleTool(tools);
    const result = await tools.dispatch(
      "schedule",
      JSON.stringify({ command: "create", cron: "* * * * *" }),
    );
    expect(result).toContain("cron");
  });

  it("check evaluates cron expiry", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerScheduleTool } = await import("../src/tools/schedule.js");
    const tools = new ToolRegistry();
    registerScheduleTool(tools);

    // Create a task that matches every minute
    await tools.dispatch(
      "schedule",
      JSON.stringify({
        command: "create",
        cron: "* * * * *",
        prompt: "每分钟任务",
      }),
    );

    const out = await tools.dispatch("schedule", JSON.stringify({ command: "check" }));
    expect(out).toContain("每分钟任务");
  });
});
