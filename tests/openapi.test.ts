import { describe, it, expect } from "vitest";
import {
  resolveRef,
  resolveSchema,
  deepResolveRefs,
  extractInputSchema,
  extractOutputSchema,
} from "../src/openapi";

const OPENAPI_DOC = {
  components: {
    schemas: {
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
      Address: {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
        },
      },
      UserWithAddress: {
        type: "object",
        properties: {
          id: { type: "integer" },
          address: { $ref: "#/components/schemas/Address" },
        },
      },
      AdminUser: {
        allOf: [
          { $ref: "#/components/schemas/User" },
          {
            type: "object",
            properties: { role: { type: "string" } },
          },
        ],
      },
      SelfRef: {
        type: "object",
        properties: {
          child: { $ref: "#/components/schemas/SelfRef" },
        },
      },
    },
  },
};

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

describe("deepResolveRefs", () => {
  it("resolves a top-level $ref", () => {
    const schema = { $ref: "#/components/schemas/User" };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    expect(result).toMatchObject({
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
      },
    });
  });

  it("resolves nested $ref inside properties", () => {
    const schema = {
      type: "object",
      properties: {
        address: { $ref: "#/components/schemas/Address" },
      },
    };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    expect(result.properties).toMatchObject({
      address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
      },
    });
  });

  it("resolves $ref inside allOf", () => {
    const schema = {
      allOf: [
        { $ref: "#/components/schemas/User" },
        { type: "object", properties: { extra: { type: "boolean" } } },
      ],
    };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    expect((result.allOf as Record<string, unknown>[])[0]).toMatchObject({
      type: "object",
      properties: { id: { type: "integer" } },
    });
    expect((result.allOf as Record<string, unknown>[])[1]).toMatchObject({
      properties: { extra: { type: "boolean" } },
    });
  });

  it("resolves $ref inside anyOf", () => {
    const schema = {
      anyOf: [
        { $ref: "#/components/schemas/User" },
        { $ref: "#/components/schemas/Address" },
      ],
    };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    const items = result.anyOf as Record<string, unknown>[];
    expect((items[0] as Record<string, unknown>).type).toBe("object");
    expect((items[1] as Record<string, Record<string, unknown>>).properties).toHaveProperty("street");
  });

  it("resolves $ref in array items", () => {
    const schema = {
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    expect(result.items).toMatchObject({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  it("resolves deeply nested refs (UserWithAddress -> Address)", () => {
    const schema = { $ref: "#/components/schemas/UserWithAddress" };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.address).toMatchObject({
      type: "object",
      properties: { street: { type: "string" } },
    });
  });

  it("handles circular $ref via depth limit without throwing", () => {
    const schema = { $ref: "#/components/schemas/SelfRef" };
    const result = deepResolveRefs(schema, OPENAPI_DOC);
    expect(result).toMatchObject({ type: "object" });
    expect(result.properties).toHaveProperty("child");
  });

  it("does not mutate the original openapi doc", () => {
    const addressBefore = JSON.stringify(OPENAPI_DOC.components.schemas.Address);
    deepResolveRefs({ $ref: "#/components/schemas/UserWithAddress" }, OPENAPI_DOC);
    expect(JSON.stringify(OPENAPI_DOC.components.schemas.Address)).toBe(addressBefore);
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

  it("deep-resolves nested $ref in body properties", () => {
    const operation = {
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UserWithAddress" },
          },
        },
      },
    };
    const result = extractInputSchema(operation, OPENAPI_DOC);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.address).toMatchObject({
      type: "object",
      properties: { street: { type: "string" } },
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
    const operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/User" },
              },
            },
          },
        },
      },
    };
    const result = extractOutputSchema(operation, OPENAPI_DOC);
    expect(result).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    });
  });

  it("deep-resolves nested $ref in response properties", () => {
    const operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserWithAddress" },
            },
          },
        },
      },
    };
    const result = extractOutputSchema(operation, OPENAPI_DOC);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.address).toMatchObject({
      type: "object",
      properties: { street: { type: "string" } },
    });
  });

  it("deep-resolves allOf composition in response", () => {
    const operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminUser" },
            },
          },
        },
      },
    };
    const result = extractOutputSchema(operation, OPENAPI_DOC);
    const allOf = result.allOf as Record<string, unknown>[];
    expect(allOf[0]).toMatchObject({
      type: "object",
      properties: { id: { type: "integer" } },
    });
    expect(allOf[1]).toMatchObject({
      properties: { role: { type: "string" } },
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
