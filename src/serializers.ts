import type { ScannedModule } from './types.js';

/**
 * Converts annotations to a plain dictionary.
 * Returns null for null/undefined or unrecognised types.
 */
export function annotationsToDict(
  annotations: unknown,
): Record<string, unknown> | null {
  if (annotations == null) {
    return null;
  }
  if (
    typeof annotations === 'object' &&
    !Array.isArray(annotations)
  ) {
    return { ...(annotations as Record<string, unknown>) };
  }
  console.warn(
    'Unrecognised annotations type %s: %o — returning null',
    typeof annotations,
    annotations,
  );
  return null;
}

/**
 * Serializes a ScannedModule to a plain dictionary with snake_case keys,
 * matching the Python SDK's output format.
 */
export function moduleToDict(
  module: ScannedModule,
): Record<string, unknown> {
  return {
    module_id: module.moduleId,
    description: module.description,
    documentation: module.documentation,
    tags: [...module.tags],
    version: module.version,
    target: module.target,
    annotations: annotationsToDict(module.annotations),
    examples: module.examples.length > 0
      ? module.examples.map((e) => ({ ...e }))
      : [],
    metadata: { ...module.metadata },
    input_schema: { ...module.inputSchema },
    output_schema: { ...module.outputSchema },
    warnings: [...module.warnings],
  };
}

/**
 * Batch-converts an array of ScannedModules to plain dictionaries.
 */
export function modulesToDicts(
  modules: ScannedModule[],
): Record<string, unknown>[] {
  return modules.map(moduleToDict);
}
