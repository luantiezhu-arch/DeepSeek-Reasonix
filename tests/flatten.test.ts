/** Tests for repair/flatten.ts — schema analysis and flatten/nest logic. */

import { describe, expect, it } from "vitest";
import { analyzeSchema, flattenSchema, nestArguments } from "../src/repair/flatten.js";

describe("analyzeSchema", () => {
  it("returns shouldFlatten=false for simple schemas with few leaves", () => {
    const schema = JSON.parse('{"type":"object","properties":{"x":{"type":"string"}}}');
    const r = analyzeSchema(schema);
    expect(r.shouldFlatten).toBe(false);
    expect(r.leafCount).toBe(1);
    expect(r.maxDepth).toBe(1);
  });

  it("returns shouldFlatten=true for deeply nested schemas (>2 levels)", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"a":{"type":"object","properties":{"b":{"type":"object","properties":{"c":{"type":"string"}}}}}}}',
    );
    const r = analyzeSchema(schema);
    expect(r.shouldFlatten).toBe(true);
    expect(r.maxDepth).toBeGreaterThanOrEqual(3);
  });

  it("returns shouldFlatten=true for wide schemas (>10 leaves)", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      props[`field${i}`] = { type: "string" };
    }
    const schema = JSON.parse(JSON.stringify({ type: "object", properties: props }));
    const r = analyzeSchema(schema);
    expect(r.shouldFlatten).toBe(true);
    expect(r.leafCount).toBe(12);
  });

  it("handles undefined gracefully", () => {
    const r = analyzeSchema(undefined);
    expect(r.shouldFlatten).toBe(false);
    expect(r.leafCount).toBe(0);
  });

  it("handles schema with required fields correctly", () => {
    const schema = JSON.parse(
      '{"type":"object","required":["name","email"],"properties":{"name":{"type":"string"},"email":{"type":"string"},"age":{"type":"integer"}}}',
    );
    const r = analyzeSchema(schema);
    expect(r.leafCount).toBe(3); // three leaf properties
    expect(r.shouldFlatten).toBe(false); // only 3 leaves, depth 1
  });
});

describe("flattenSchema", () => {
  it("flattens nested object into flat keys", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"user":{"type":"object","properties":{"name":{"type":"string"},"email":{"type":"string"}}}}}',
    );
    const flat = flattenSchema(schema);
    expect(flat.properties).toHaveProperty("user.name");
    expect(flat.properties).toHaveProperty("user.email");
  });

  it("preserves non-nested properties", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"id":{"type":"integer"},"user":{"type":"object","properties":{"name":{"type":"string"}}}}}',
    );
    const flat = flattenSchema(schema);
    expect(flat.properties).toHaveProperty("id");
    expect(flat.properties).toHaveProperty("user.name");
  });

  it("handles deeply nested objects (3 levels)", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"a":{"type":"object","properties":{"b":{"type":"object","properties":{"c":{"type":"string"}}}}}}}',
    );
    const flat = flattenSchema(schema);
    expect(flat.properties).toHaveProperty("a.b.c");
  });
});

describe("nestArguments", () => {
  it("nests flat keys back into nested object", () => {
    const flat = {
      "user.name": "Alice",
      "user.email": "alice@example.com",
    };
    const nested = nestArguments(flat);
    expect(nested.user).toBeDefined();
    expect((nested.user as Record<string, string>).name).toBe("Alice");
    expect((nested.user as Record<string, string>).email).toBe("alice@example.com");
  });

  it("preserves non-nested keys", () => {
    const flat: Record<string, unknown> = {
      id: 42,
      "user.name": "Alice",
    };
    const nested = nestArguments(flat);
    expect(nested.id).toBe(42);
    expect((nested.user as Record<string, string>).name).toBe("Alice");
  });

  it("handles empty input", () => {
    const nested = nestArguments({});
    expect(Object.keys(nested).length).toBe(0);
  });

  it("handles deeply nested (3 levels)", () => {
    const flat: Record<string, unknown> = {
      "a.b.c": "deep value",
    };
    const nested = nestArguments(flat);
    expect(((nested.a as Record<string, unknown>).b as Record<string, unknown>).c).toBe(
      "deep value",
    );
  });

  it("handles nested keys alongside top-level keys at same prefix", () => {
    const flat: Record<string, unknown> = {
      "user.name": "Alice",
      user_id: 123,
    };
    const nested = nestArguments(flat);
    expect(nested.user_id).toBe(123);
    expect((nested.user as Record<string, string>).name).toBe("Alice");
  });
});
