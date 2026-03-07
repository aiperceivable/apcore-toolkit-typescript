/**
 * Enrich a JSON Schema's property descriptions from an external map.
 *
 * Returns the original schema reference when no enrichment is needed;
 * otherwise returns a deep copy with descriptions merged in.
 */
export function enrichSchemaDescriptions(
  schema: Record<string, unknown>,
  paramDescriptions: Record<string, string>,
  options?: { overwrite?: boolean },
): Record<string, unknown> {
  if (Object.keys(paramDescriptions).length === 0) {
    return schema;
  }

  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    return schema;
  }

  const overwrite = options?.overwrite ?? false;
  const result = structuredClone(schema);
  const resultProps = result.properties as Record<
    string,
    Record<string, unknown>
  >;

  for (const [name, desc] of Object.entries(paramDescriptions)) {
    if (name in resultProps) {
      const prop = resultProps[name];
      if (overwrite || !("description" in prop)) {
        prop.description = desc;
      }
    }
  }

  return result;
}
