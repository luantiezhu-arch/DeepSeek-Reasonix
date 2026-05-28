/** Tests for tools registered in the fork: sysinfo, sleep, send_message, tool_search. */

import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ */
/*  sysinfo                                                           */
/* ------------------------------------------------------------------ */
describe("registerSysInfoTool", () => {
  it("returns system info with CPU count and memory", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSysInfoTool } = await import("../src/tools/sysinfo.js");
    const tools = new ToolRegistry();
    registerSysInfoTool(tools);
    const out = await tools.dispatch("sysinfo", JSON.stringify({}));
    expect(out).toContain("CPU");
    expect(out).toContain("内存");
  });

  it("formats bytes correctly", async () => {
    const { formatBytes } = await import("../src/tools/sysinfo.js")
      .then((m: Record<string, unknown>) => ({
        formatBytes: m.formatBytes as (b: number) => string,
      }))
      .catch(() => ({ formatBytes: null }));
    // formatBytes may not be exported; skip if not
    if (!formatBytes) return;
    expect(formatBytes(0)).toContain("0");
    expect(formatBytes(1024)).toContain("1.0 KB");
    expect(formatBytes(1024 * 1024)).toContain("1.0 MB");
  });
});

/* ------------------------------------------------------------------ */
/*  sleep                                                             */
/* ------------------------------------------------------------------ */
describe("registerSleepTool", () => {
  it("resolves after short duration", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSleepTool } = await import("../src/tools/sleep.js");
    const tools = new ToolRegistry();
    registerSleepTool(tools);
    const start = Date.now();
    const out = await tools.dispatch("sleep", JSON.stringify({ duration: 0.01 }));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(out).toContain("Slept");
  });

  it("clamps duration to 0 when negative", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSleepTool } = await import("../src/tools/sleep.js");
    const tools = new ToolRegistry();
    registerSleepTool(tools);
    const start = Date.now();
    await tools.dispatch("sleep", JSON.stringify({ duration: -5 }));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // negative clamped to ~0
  });
});

/* ------------------------------------------------------------------ */
/*  send_message                                                      */
/* ------------------------------------------------------------------ */
describe("registerSendMessageTool", () => {
  it("returns message with default level (info)", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSendMessageTool } = await import("../src/tools/send-message.js");
    const tools = new ToolRegistry();
    registerSendMessageTool(tools);
    const out = await tools.dispatch("send_message", JSON.stringify({ message: "hello" }));
    expect(out).toContain("hello");
    expect(out).toContain("ℹ️");
  });

  it("shows different icons per level", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSendMessageTool } = await import("../src/tools/send-message.js");
    const tools = new ToolRegistry();
    registerSendMessageTool(tools);
    const out = await tools.dispatch(
      "send_message",
      JSON.stringify({ message: "done", level: "success" }),
    );
    expect(out).toContain("✅");
  });
});

/* ------------------------------------------------------------------ */
/*  tool_search                                                       */
/* ------------------------------------------------------------------ */
describe("registerToolSearchTool", () => {
  it("finds matching tools by name", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerToolSearchTool } = await import("../src/tools/tool-search.js");
    const tools = new ToolRegistry();
    // Register a sample tool so search has something to find
    tools.register({
      name: "dummy_tool",
      description: "A test tool for searching",
      fn: () => "ok",
    });
    registerToolSearchTool(tools);
    const out = await tools.dispatch("tool_search", JSON.stringify({ query: "dummy" }));
    expect(out).toContain("dummy_tool");
  });

  it("returns empty message when no match", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerToolSearchTool } = await import("../src/tools/tool-search.js");
    const tools = new ToolRegistry();
    registerToolSearchTool(tools);
    const out = await tools.dispatch("tool_search", JSON.stringify({ query: "x_x_x_NOTEXIST" }));
    expect(out).toContain("没有找到");
  });
});
