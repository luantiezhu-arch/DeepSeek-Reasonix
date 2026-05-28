import { describe, expect, it, vi } from "vitest";

describe("registerPowerShellTool — parameter validation", () => {
  it("requires command parameter", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerPowerShellTool } = await import("../src/tools/powershell.js");
    const tools = new ToolRegistry();
    registerPowerShellTool(tools);

    // Missing required "command" — dispatch returns JSON error string
    const result = await tools.dispatch("powershell", JSON.stringify({}));
    expect(result).toContain("command");
  });
});

describe("registerPowerShellTool — platform guard", () => {
  it("rejects with clear message on non-Windows", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerPowerShellTool } = await import("../src/tools/powershell.js");
    const tools = new ToolRegistry();
    registerPowerShellTool(tools);

    if (process.platform === "win32") {
      // On Windows, ensure it doesn't reject with platform error
      const out = await tools.dispatch(
        "powershell",
        JSON.stringify({
          command: "Write-Host 'hello'",
        }),
      );
      expect(typeof out).toBe("string");
    } else {
      // On non-Windows, it should throw
      await expect(
        tools.dispatch("powershell", JSON.stringify({ command: "Write-Host hi" })),
      ).rejects.toThrow(/Windows/);
    }
  });
});

describe("registerPowerShellTool — execution", () => {
  it(
    "returns output on successful command (Windows only)",
    { skip: process.platform !== "win32" },
    async () => {
      const { ToolRegistry } = await import("../src/tools.js");
      const { registerPowerShellTool } = await import("../src/tools/powershell.js");
      const tools = new ToolRegistry();
      registerPowerShellTool(tools);

      const out = await tools.dispatch(
        "powershell",
        JSON.stringify({
          command: "Write-Host ok123",
          timeout: 5,
        }),
      );
      expect(out).toContain("ok123");
    },
  );

  it(
    "returns default message when command produces no output",
    { skip: process.platform !== "win32" },
    async () => {
      const { ToolRegistry } = await import("../src/tools.js");
      const { registerPowerShellTool } = await import("../src/tools/powershell.js");
      const tools = new ToolRegistry();
      registerPowerShellTool(tools);

      // `$null = $null` produces no stdout/stderr
      const out = await tools.dispatch(
        "powershell",
        JSON.stringify({
          command: "$null = $null",
          timeout: 5,
        }),
      );
      expect(out).toMatch(/无输出/);
    },
  );
});
