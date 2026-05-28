import { describe, expect, it } from "vitest";

describe("registerSleepTool", () => {
  it("returns Slept for message with duration", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSleepTool } = await import("../src/tools/sleep.js");
    const tools = new ToolRegistry();
    registerSleepTool(tools);

    const out = await tools.dispatch("sleep", JSON.stringify({ duration: 0.01 }));
    expect(out).toContain("Slept");
  });

  it("clamps negative duration to 0 (no error)", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerSleepTool } = await import("../src/tools/sleep.js");
    const tools = new ToolRegistry();
    registerSleepTool(tools);

    const start = Date.now();
    const out = await tools.dispatch("sleep", JSON.stringify({ duration: -5 }));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(out).toContain("Slept");
  });
});
