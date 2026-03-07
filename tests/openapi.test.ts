import { describe, it, expect } from "vitest";
import {
  resolveRef,
  resolveSchema,
  extractInputSchema,
  extractOutputSchema,
} from "../src/openapi";

describe("resolveRef", () => {
  it("resolves a valid #/components/schemas/Foo reference", () => {
    const doc = {
      components: {
        schemas: {
          Foo: { type: "object", properties: { id: { type: "integer" } } },
        },
      },
    };
    const result = resolveRef("#/components/schemas/Foo", doc);
    expect(result).toEqual({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  it("returns {} when ref does not start with #/", () => {
    const doc = { components: { schemas: { Foo: { type: "object" } } } };
    expect(resolveRef("components/schemas/Foo", doc)).toEqual({});
    expect(resolveRef("http://example.com/schema", doc)).toEqual({});
  });

  it("returns {} when an intermediate path segment is missing", () => {
    const doc = { components: {} };
    expect(resolveRef("#/components/schemas/Foo", doc)).toEqual({});
  });
});

describe("resolveSchema", () => {
  it("resolves a schema containing $ref", () => {
    const doc = {
      components: {
        schemas: {
          Bar: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    };
    const schema = { $ref: "#/components/schemas/Bar" };
    expect(resolveSchema(schema, doc)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("returns the schema as-is when no $ref is present", () => {
    const schema = { type: "string" };
    expect(resolveSchema(schema, {})).toEqual({ type: "string" });
  });

  it("returns the schema as-is when doc is null", () => {
    const schema = { $ref: "#/components/schemas/X" };
    expect(resolveSchema(schema, null)).toEqual({
      $ref: "#/components/schemas/X",
    });
  });
});

describe("extractInputSchema", () => {
  it("merges query, path, and requestBody parameters", () => {
    const operation = {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "X-Token", in: "header", schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
        },
      },
    };
    const result = extractInputSchema(operation);
    expect(result).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        q: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "title"],
    });
  });

  it("resolves $ref in parameter schemas", () => {
    const doc = {
      components: {
        schemas: {
          IdParam: { type: "integer", minimum: 1 },
        },
      },
    };
    const operation = {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { $ref: "#/components/schemas/IdParam" },
        },
      ],
    };
    const result = extractInputSchema(operation, doc);
    expect(result).toEqual({
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
      },
      required: ["id"],
    });
  });
});

describe("extractOutputSchema", () => {
  it("extracts schema from a 200 response", () => {
    const operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "integer" } },
              },
            },
          },
        },
      },
    };
    const result = extractOutputSchema(operation);
    expect(result).toEqual({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  it("handles array schema with $ref items", () => {
    const doc = {
      components: {
        schemas: {
          Item: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    };
    const operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
    };
    const result = extractOutputSchema(operation, doc);
    expect(result).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    });
  });

  it("returns default schema when no responses match", () => {
    const operation = { responses: { "404": {} } };
    expect(extractOutputSchema(operation)).toEqual({
      type: "object",
      properties: {},
    });
  });
});
