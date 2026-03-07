import { describe, it, expect } from "vitest";
import { enrichSchemaDescriptions } from "../src/schema-utils";

describe("enrichSchemaDescriptions", () => {
  it("returns original schema (same reference) when paramDescriptions is empty", () => {
    const schema = { properties: { name: { type: "string" } } };
    const result = enrichSchemaDescriptions(schema, {});
    expect(result).toBe(schema);
  });

  it("returns original schema when no 'properties' key", () => {
    const schema = { type: "object" };
    const result = enrichSchemaDescriptions(schema, { name: "A name" });
    expect(result).toBe(schema);
  });

  it("merges descriptions into properties that lack them", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };
    const result = enrichSchemaDescriptions(schema, {
      name: "The user name",
      age: "The user age",
    });
    expect(result).toEqual({
      properties: {
        name: { type: "string", description: "The user name" },
        age: { type: "number", description: "The user age" },
      },
    });
  });

  it("does NOT overwrite existing descriptions by default", () => {
    const schema = {
      properties: {
        name: { type: "string", description: "Original desc" },
      },
    };
    const result = enrichSchemaDescriptions(schema, {
      name: "New desc",
    });
    expect(result.properties).toBeDefined();
    expect(
      (result.properties as Record<string, Record<string, unknown>>).name
        .description,
    ).toBe("Original desc");
  });

  it("overwrites existing descriptions when overwrite is true", () => {
    const schema = {
      properties: {
        name: { type: "string", description: "Original desc" },
      },
    };
    const result = enrichSchemaDescriptions(
      schema,
      { name: "New desc" },
      { overwrite: true },
    );
    expect(
      (result.properties as Record<string, Record<string, unknown>>).name
        .description,
    ).toBe("New desc");
  });

  it("does not mutate the original schema (deep copy)", () => {
    const schema = {
      properties: {
        name: { type: "string" },
      },
    };
    const result = enrichSchemaDescriptions(schema, { name: "A name" });
    expect(result).not.toBe(schema);
    expect(
      (schema.properties as Record<string, Record<string, unknown>>).name,
    ).not.toHaveProperty("description");
  });

  it("ignores param names not present in properties", () => {
    const schema = {
      properties: {
        name: { type: "string" },
      },
    };
    const result = enrichSchemaDescriptions(schema, {
      notHere: "Should be ignored",
    });
    expect(result).toEqual({
      properties: {
        name: { type: "string" },
      },
    });
    expect(result.properties).not.toHaveProperty("notHere");
  });
});
