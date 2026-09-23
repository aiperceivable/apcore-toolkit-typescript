// OpenAPI schema extraction utilities

import { PROTO_DENY as PROTO_DENY_LIST } from './safe-keys.js';

/**
 * Resolve a JSON `$ref` pointer like `#/components/schemas/Foo`.
 *
 * Decodes RFC 6901 escape sequences in path segments (`~1` → `/`, `~0` → `~`).
 *
 * @param refString - The `$ref` value (e.g., `#/components/schemas/Foo`).
 * @param openapiDoc - The full OpenAPI document.
 * @returns The resolved schema, or an empty object on failure.
 */
export function resolveRef(
  refString: string,
  openapiDoc: Record<string, unknown>,
): Record<string, unknown> {
  if (!refString.startsWith("#/")) {
    return {};
  }
  const parts = refString.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = openapiDoc;
  for (const part of parts) {
    if (PROTO_DENY_LIST.has(part)) return {};
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return {};
    }
    current = (current as Record<string, unknown>)[part] ?? {};
  }
  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
}

/**
 * If `schema` contains a `$ref`, resolve it; otherwise return as-is.
 *
 * @param schema - A JSON Schema object (possibly containing `$ref`).
 * @param openapiDoc - The full OpenAPI document (needed for ref resolution),
 *   or `null` when no document is available.
 * @returns The resolved schema, or the original `schema` unchanged.
 */
export function resolveSchema(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null,
): Record<string, unknown> {
  if (openapiDoc && "$ref" in schema) {
    const ref = schema["$ref"];
    if (typeof ref !== 'string') return schema;
    return resolveRef(ref, openapiDoc);
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
    console.warn('deepResolveRefs: max depth reached; returning schema as-is');
    return schema;
  }

  if ("$ref" in schema) {
    const ref = schema["$ref"];
    if (typeof ref !== 'string') return schema;
    // Resolve the target, then merge back any keys that sat BESIDE the `$ref`.
    // Discarding them silently drops `x-sensitive`, which apcore reads off the
    // *resolved* schema to decide what to redact — a field the OpenAPI document
    // marked sensitive then reaches apcore carrying nothing to redact on.
    // apcore closed the same hole in its own resolver as D-98 in 0.31.0;
    // see docs/features/openapi.md.
    const resolved = deepResolveRefs(resolveRef(ref, openapiDoc), openapiDoc, depth + 1);
    const siblings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k !== "$ref") siblings[k] = v;
    }
    if (Object.keys(siblings).length === 0) return resolved;
    // Siblings are walked at the SAME depth: following the reference has
    // already consumed a level and they are not a second hop.
    return { ...resolved, ...deepResolveRefs(siblings, openapiDoc, depth) };
  }

  const result = { ...schema };

  // Resolve inside allOf/anyOf/oneOf
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (key in result && Array.isArray(result[key])) {
      result[key] = (result[key] as unknown[])
        .filter((item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
        )
        .map((item) => deepResolveRefs(item, openapiDoc, depth + 1));
    }
  }

  // Resolve array items (single-schema form)
  if (
    "items" in result &&
    !Array.isArray(result["items"]) &&
    typeof result["items"] === "object" &&
    result["items"] !== null
  ) {
    result["items"] = deepResolveRefs(
      result["items"] as Record<string, unknown>,
      openapiDoc,
      depth + 1,
    );
  }

  // Resolve tuple-form items (when items is an array of schemas)
  if (Array.isArray(result["items"])) {
    result["items"] = (result["items"] as unknown[]).map(item =>
      typeof item === "object" && item !== null
        ? deepResolveRefs(item as Record<string, unknown>, openapiDoc, depth + 1)
        : item,
    );
  }

  // Resolve nested properties
  if (
    "properties" in result &&
    typeof result["properties"] === "object" &&
    result["properties"] !== null
  ) {
    const props = result["properties"] as Record<string, Record<string, unknown>>;
    const resolvedProps: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(props)) {
      if (PROTO_DENY_LIST.has(k)) continue;
      resolvedProps[k] = deepResolveRefs(v, openapiDoc, depth + 1);
    }
    result["properties"] = resolvedProps;
  }

  // additionalProperties when it is a schema (not a boolean)
  if (result["additionalProperties"] && typeof result["additionalProperties"] === "object") {
    result["additionalProperties"] = deepResolveRefs(
      result["additionalProperties"] as Record<string, unknown>,
      openapiDoc,
      depth + 1,
    );
  }

  // patternProperties — each value is a schema
  if (result["patternProperties"] && typeof result["patternProperties"] === "object") {
    result["patternProperties"] = Object.fromEntries(
      Object.entries(result["patternProperties"] as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "object" && v !== null
          ? deepResolveRefs(v as Record<string, unknown>, openapiDoc, depth + 1)
          : v,
      ]),
    );
  }

  // not / if / then / else — each is a schema
  for (const key of ["not", "if", "then", "else"] as const) {
    if (result[key] && typeof result[key] === "object") {
      result[key] = deepResolveRefs(
        result[key] as Record<string, unknown>,
        openapiDoc,
        depth + 1,
      );
    }
  }

  // prefixItems — array of schemas
  if (Array.isArray(result["prefixItems"])) {
    result["prefixItems"] = (result["prefixItems"] as unknown[]).map(item =>
      typeof item === "object" && item !== null
        ? deepResolveRefs(item as Record<string, unknown>, openapiDoc, depth + 1)
        : item,
    );
  }

  return result;
}

/**
 * Extract input schema from an OpenAPI operation.
 *
 * Combines query/path parameters and request body properties into a
 * single `{"type": "object", "properties": ..., "required": [...]}` schema.
 *
 * @param operation - An OpenAPI operation object (e.g., from `paths["/users"]["get"]`).
 * @param openapiDoc - The full OpenAPI document (for `$ref` resolution), or `null`.
 * @returns A merged JSON Schema object for all input parameters.
 */
export function extractInputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  } = { type: "object", properties: {}, required: [] };

  const rawParameters = operation["parameters"] ?? [];
  if (!Array.isArray(rawParameters)) {
    console.warn('extractInputSchema: operation.parameters is not an array — ignoring');
  }
  const parameters = Array.isArray(rawParameters)
    ? (rawParameters as unknown[]).filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null && !Array.isArray(p),
      )
    : [];
  for (const param of parameters) {
    if (param["in"] === "query" || param["in"] === "path") {
      const name = param["name"];
      if (typeof name !== 'string' || PROTO_DENY_LIST.has(name)) continue;
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
  // Accept application/json (exact or with parameters like charset=utf-8),
  // application/vnd.api+json, or any key starting with "application/json".
  // Mirrors Python's startswith("application/json") behaviour.
  const contentKeys = Object.keys(content);
  const jsonKey = contentKeys.find(k => k === 'application/json')
    ?? contentKeys.find(k => k.startsWith('application/json'))
    ?? contentKeys.find(k => k === 'application/vnd.api+json');
  const jsonContent = (jsonKey ? content[jsonKey] : {}) as Record<string, unknown>;
  const bodySchema = (jsonContent["schema"] ?? {}) as Record<string, unknown>;

  if (Object.keys(bodySchema).length > 0) {
    const resolved = resolveSchema(bodySchema, openapiDoc);
    const bodyProps = (resolved["properties"] ?? {}) as Record<string, unknown>;
    const bodyRequired = (resolved["required"] ?? []) as string[];
    for (const [k, v] of Object.entries(bodyProps)) {
      if (!PROTO_DENY_LIST.has(k)) {
        schema.properties[k] = v;
      }
    }
    schema.required.push(...bodyRequired.filter(r => typeof r === 'string' && !PROTO_DENY_LIST.has(r)));
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

  // Deduplicate required[] — path params and body schema may both declare the same field
  schema.required = [...new Set(schema.required)];

  return schema;
}

/**
 * Extract output schema from OpenAPI operation responses.
 *
 * Accepts any 2xx status code (200–299). Response codes are checked in
 * lexicographic order, so 200 is preferred over 201, 201 over 202, and so on.
 *
 * @param operation - An OpenAPI operation object.
 * @param openapiDoc - The full OpenAPI document (for `$ref` resolution), or `null`.
 * @returns The output JSON Schema, or a default empty object schema.
 */
export function extractOutputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const responses = (operation["responses"] ?? {}) as Record<string, unknown>;

  const successCodes = Object.keys(responses).filter(
    k => /^2\d\d$/.test(k),
  ).sort();

  for (const statusCode of successCodes) {
    const response = responses[statusCode] as Record<string, unknown>;
    const content = (response["content"] ?? {}) as Record<string, unknown>;
    // Accept application/json (exact or with parameters like charset=utf-8),
    // application/vnd.api+json, or any key starting with "application/json".
    // Mirrors Python's startswith("application/json") behaviour.
    const respContentKeys = Object.keys(content);
    const respJsonKey = respContentKeys.find(k => k === 'application/json')
      ?? respContentKeys.find(k => k.startsWith('application/json'))
      ?? respContentKeys.find(k => k === 'application/vnd.api+json');
    const jsonContent = (respJsonKey ? content[respJsonKey] : {}) as Record<string, unknown>;

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
