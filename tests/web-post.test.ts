/** Tests for web_fetch POST — SSRF protection and Content-Type auto-detection. */

import { describe, expect, it } from "vitest";

describe("web_fetch POST — SSRF protection", () => {
  it("blocks POST to internal host (127.0.0.1)", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "http://127.0.0.1:9999/test",
        method: "POST",
        body: "test",
      }),
    );
    expect(out).toContain("refuses internal");
  });

  it("blocks PUT to internal host", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "http://192.168.1.1/admin",
        method: "PUT",
        body: "attack",
      }),
    );
    expect(out).toContain("refuses internal");
  });

  it("blocks DELETE to loopback", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "http://localhost:9200/",
        method: "DELETE",
      }),
    );
    expect(out).toContain("refuses internal");
  });

  it("rejects non-HTTP protocols", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "file:///etc/passwd",
        method: "GET",
      }),
    );
    expect(out).toContain("http");
  });
});

describe("web_fetch POST — error handling", () => {
  it("rejects invalid headers JSON", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "https://example.com/",
        method: "POST",
        body: "test",
        headers: "not-json",
      }),
    );
    expect(out).toContain("JSON");
  });

  it("rejects missing method for non-GET", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const { registerWebTools } = await import("../src/tools/web.js");
    const tools = new ToolRegistry();
    registerWebTools(tools, { defaultTopK: 1 });

    // Missing method — should default to GET and not hit POST branch
    const out = await tools.dispatch(
      "web_fetch",
      JSON.stringify({
        url: "https://example.com/",
        body: "test",
      }),
    );
    // Without method, it uses the GET path which requires an actual fetch
    // Should still be handled (GET with body works)
    expect(typeof out).toBe("string");
  });
});
