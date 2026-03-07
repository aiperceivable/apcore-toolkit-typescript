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
      if (
        schema["type"] === "array" &&
        typeof schema["items"] === "object" &&
        schema["items"] !== null &&
        "$ref" in (schema["items"] as Record<string, unknown>)
      ) {
        schema = {
          ...schema,
          items: resolveSchema(schema["items"] as Record<string, unknown>, openapiDoc),
        };
      }
      return schema;
    }
  }

  return { type: "object", properties: {} };
}
