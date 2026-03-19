// OpenAPI schema extraction utilities

export function resolveRef(
  refString: string,
  openapiDoc: Record<string, unknown>,
): Record<string, unknown> {
  if (!refString.startsWith("#/")) {
    return {};
  }
  const parts = refString.slice(2).split("/");
  let current: unknown = openapiDoc;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return {};
    }
    current = (current as Record<string, unknown>)[part] ?? {};
  }
  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
}

export function resolveSchema(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null,
): Record<string, unknown> {
  if (openapiDoc && "$ref" in schema) {
    return resolveRef(schema["$ref"] as string, openapiDoc);
  }
  return schema;
}

/**
 * Recursively resolve all `$ref` pointers in a schema.
 *
 * Handles nested `$ref`, `allOf`, `anyOf`, `oneOf`, and `items`.
 * Depth-limited to 16 levels to prevent infinite recursion.
 */
export function deepResolveRefs(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 16) {
    return schema;
  }

  if ("$ref" in schema) {
    const resolved = resolveRef(schema["$ref"] as string, openapiDoc);
    return deepResolveRefs(resolved, openapiDoc, depth + 1);
  }

  const result = { ...schema };

  // Resolve inside allOf/anyOf/oneOf
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (key in result && Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map((item) =>
        deepResolveRefs(item, openapiDoc, depth + 1),
      );
    }
  }

  // Resolve array items
  if (
    "items" in result &&
    typeof result["items"] === "object" &&
    result["items"] !== null
  ) {
    result["items"] = deepResolveRefs(
      result["items"] as Record<string, unknown>,
      openapiDoc,
      depth + 1,
    );
  }

  // Resolve nested properties
  if (
    "properties" in result &&
    typeof result["properties"] === "object" &&
    result["properties"] !== null
  ) {
    const props = result["properties"] as Record<string, Record<string, unknown>>;
    const resolvedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      resolvedProps[k] = deepResolveRefs(v, openapiDoc, depth + 1);
    }
    result["properties"] = resolvedProps;
  }

  return result;
}

export function extractInputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  } = { type: "object", properties: {}, required: [] };

  const parameters = (operation["parameters"] ?? []) as Record<string, unknown>[];
  for (const param of parameters) {
    if (param["in"] === "query" || param["in"] === "path") {
      const name = param["name"] as string;
      let paramSchema = (param["schema"] ?? { type: "string" }) as Record<string, unknown>;
      paramSchema = resolveSchema(paramSchema, openapiDoc);
      schema.properties[name] = paramSchema;
      if (param["required"]) {
        schema.required.push(name);
      }
    }
  }

  const requestBody = (operation["requestBody"] ?? {}) as Record<string, unknown>;
  const content = (requestBody["content"] ?? {}) as Record<string, unknown>;
  const jsonContent = (content["application/json"] ?? {}) as Record<string, unknown>;
  const bodySchema = (jsonContent["schema"] ?? {}) as Record<string, unknown>;

  if (Object.keys(bodySchema).length > 0) {
    const resolved = resolveSchema(bodySchema, openapiDoc);
    const bodyProps = (resolved["properties"] ?? {}) as Record<string, unknown>;
    const bodyRequired = (resolved["required"] ?? []) as string[];
    Object.assign(schema.properties, bodyProps);
    schema.required.push(...bodyRequired);
  }

  // Recursively resolve $ref inside individual properties
  if (openapiDoc) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      schema.properties[propName] = deepResolveRefs(
        propSchema as Record<string, unknown>,
        openapiDoc,
      );
    }
  }

  return schema;
}

export function extractOutputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const responses = (operation["responses"] ?? {}) as Record<string, unknown>;

  for (const statusCode of ["200", "201"]) {
    const response = (responses[statusCode] ?? {}) as Record<string, unknown>;
    const content = (response["content"] ?? {}) as Record<string, unknown>;
    const jsonContent = (content["application/json"] ?? {}) as Record<string, unknown>;

    if ("schema" in jsonContent) {
      let schema = resolveSchema(
        jsonContent["schema"] as Record<string, unknown>,
        openapiDoc,
      );
      // Recursively resolve all nested $ref pointers
      if (openapiDoc) {
        schema = deepResolveRefs(schema, openapiDoc);
      }
      return schema;
    }
  }

  return { type: "object", properties: {} };
}
