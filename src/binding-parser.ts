/**
 * Runtime-neutral binding document parser.
 *
 * Contains the pure parsing logic shared by {@link BindingLoader} — it takes
 * a pre-loaded `bindings` document (e.g. the result of `yaml.load()` or a
 * JSON fetch response) and returns `ScannedModule[]`. No filesystem access.
 *
 * `BindingLoader` (in `binding-loader.ts`) extends {@link BindingParser} to
 * add the `load(filePath)` entry point that reads from disk with `node:fs`.
 * Consumers that only need in-memory parsing — browsers, edge runtimes,
 * workers — import {@link BindingParser} or {@link parseBindingDocument}
 * from here (or via `apcore-toolkit/browser`).
 */

import type { ModuleAnnotations, ModuleExample } from 'apcore-js';
import { annotationsFromJSON } from 'apcore-js';
import type { ScannedModule } from './types.js';
import { createScannedModule } from './types.js';
import { PROTO_DENY } from './safe-keys.js';

const SUPPORTED_SPEC_VERSIONS = new Set(['1.0']);
const LOOSE_REQUIRED = ['module_id', 'target'] as const;
const STRICT_EXTRA = ['input_schema', 'output_schema'] as const;

/** Options for {@link BindingParser} / {@link BindingLoader} methods. */
export interface BindingLoadOptions {
  /**
   * When `true`, also require `input_schema` and `output_schema`.
   * Default: `false` (loose mode — only `module_id` and `target` required).
   */
  strict?: boolean;
  /**
   * Ignored by every consumer of this type.
   *
   * `BindingLoadOptions` is only ever passed to {@link BindingParser.loadData}
   * and {@link parseBindingDocument}, neither of which touches the
   * filesystem, so there is nothing for a traversal flag to govern.
   * `BindingLoader.load` does **not** take an options object — it takes
   * `recursive` as a positional boolean, `load(path, strict?, recursive?,
   * pattern?)` — so setting this field there is impossible.
   *
   * Retained for backwards compatibility with callers that already pass it.
   */
  recursive?: boolean;
}

/** Thrown when a binding YAML entry cannot be parsed. */
export class BindingLoadError extends Error {
  filePath: string | null;
  moduleId: string | null;
  missingFields: string[];
  reason: string;

  constructor(params: {
    reason: string;
    filePath?: string | null;
    moduleId?: string | null;
    missingFields?: string[];
  }) {
    const parts = [params.reason];
    if (params.filePath) parts.push(`file=${params.filePath}`);
    if (params.moduleId) parts.push(`module_id=${params.moduleId}`);
    if (params.missingFields && params.missingFields.length > 0) {
      parts.push(`missing=[${params.missingFields.join(', ')}]`);
    }
    super(parts.join(' | '));
    this.name = 'BindingLoadError';
    this.reason = params.reason;
    this.filePath = params.filePath ?? null;
    this.moduleId = params.moduleId ?? null;
    this.missingFields = params.missingFields ?? [];
  }
}

/**
 * Parse a binding document (already-loaded data, no filesystem access) into
 * `ScannedModule[]`.
 *
 * Equivalent to {@link BindingParser.loadData} but lets callers supply an
 * explicit `filePath` string that will be embedded in any
 * {@link BindingLoadError} thrown for malformed entries — useful when you
 * know the document came from a specific file (e.g. a server endpoint
 * identifies it by path). Pass `null` when no file context applies.
 */
export function parseBindingDocument(
  raw: unknown,
  options?: BindingLoadOptions,
  filePath: string | null = null,
): ScannedModule[] {
  const strict = options?.strict ?? false;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BindingLoadError({
      reason: 'top-level binding document must be a mapping',
      filePath,
    });
  }
  const data = raw as Record<string, unknown>;
  checkSpecVersion(data['spec_version'], filePath);

  const bindings = data['bindings'];
  if (!Array.isArray(bindings)) {
    throw new BindingLoadError({
      reason: "'bindings' key missing or not a list",
      filePath,
    });
  }

  return bindings.map((entry) => {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BindingLoadError({
        reason: 'binding entry must be a mapping',
        filePath,
      });
    }
    return parseEntry(entry as Record<string, unknown>, filePath, strict);
  });
}

/**
 * Runtime-neutral binding parser.
 *
 * Parses pre-loaded `bindings` data (e.g. from `yaml.load()`, `fetch()` +
 * `JSON.parse()`, etc.) into `ScannedModule[]`. Does not touch the
 * filesystem — safe for browsers, edge runtimes, and workers.
 *
 * For filesystem-based loading, use {@link BindingLoader} (subclass,
 * Node-only) which adds the `load(filePath)` entry point.
 *
 * @example
 * ```ts
 * import { BindingParser } from 'apcore-toolkit/browser';
 *
 * const resp = await fetch('/api/bindings.yaml');
 * const doc  = yaml.load(await resp.text());
 * const mods = new BindingParser().loadData(doc);
 * ```
 */
export class BindingParser {
  /** Parse a pre-loaded binding dict (`{ bindings: [...] }`). */
  loadData(data: Record<string, unknown>, options?: BindingLoadOptions): ScannedModule[] {
    return parseBindingDocument(data, options, null);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — module-private parsing primitives.
// ---------------------------------------------------------------------------

function checkSpecVersion(specVersion: unknown, filePath: string | null): void {
  const where = filePath ?? '<inline>';
  if (specVersion == null) {
    console.warn(`BindingLoader: ${where} missing 'spec_version'; defaulting to '1.0'.`);
    return;
  }
  if (typeof specVersion !== 'string' || !SUPPORTED_SPEC_VERSIONS.has(specVersion)) {
    console.warn(
      `BindingLoader: ${where} has spec_version=${JSON.stringify(specVersion)} ` +
        `newer than supported [${[...SUPPORTED_SPEC_VERSIONS].sort().join(', ')}]; proceeding best-effort.`,
    );
  }
}

function parseEntry(
  entry: Record<string, unknown>,
  filePath: string | null,
  strict: boolean,
): ScannedModule {
  const required: readonly string[] = strict
    ? [...LOOSE_REQUIRED, ...STRICT_EXTRA]
    : LOOSE_REQUIRED;
  // A required field is "missing or invalid" when absent, null, or of the
  // wrong type. Previously only null/absent was rejected, so
  // ``module_id: 42`` or ``target: true`` silently coerced to
  // ``String(42) = "42"`` downstream and corrupted the registered module.
  // This now matches the Rust loader's strict behaviour.
  const missing = required.filter((f) => isRequiredFieldInvalid(f, entry));
  if (missing.length > 0) {
    throw new BindingLoadError({
      reason: 'missing or invalid required fields',
      filePath,
      moduleId: typeof entry['module_id'] === 'string' ? entry['module_id'] : null,
      missingFields: missing,
    });
  }

  const moduleId = String(entry['module_id']);
  return createScannedModule({
    moduleId,
    description: (entry['description'] as string | undefined) ?? '',
    inputSchema: asRecord(entry['input_schema'], 'input_schema', moduleId),
    outputSchema: asRecord(entry['output_schema'], 'output_schema', moduleId),
    tags: asStringArray(entry['tags']),
    target: String(entry['target']),
    version: (entry['version'] as string | undefined) ?? '1.0.0',
    annotations: parseAnnotations(entry['annotations'], moduleId),
    documentation: (entry['documentation'] as string | null | undefined) ?? null,
    suggestedAlias: (entry['suggested_alias'] as string | null | undefined) ?? null,
    examples: parseExamples(entry['examples'], moduleId),
    metadata: asRecord(entry['metadata'], 'metadata', moduleId),
    display: asRecordOrNull(entry['display'], 'display', moduleId),
    warnings: asStringArray(entry['warnings']),
  });
}

/**
 * Return ``true`` when a required field is absent, null, or of the wrong
 * type. Schema fields (``input_schema``, ``output_schema``) must be plain
 * objects; other required fields (``module_id``, ``target``) must be
 * non-empty strings.
 */
function isRequiredFieldInvalid(field: string, entry: Record<string, unknown>): boolean {
  if (!(field in entry)) return true;
  const value = entry[field];
  if (value == null) return true;
  if (field === 'input_schema' || field === 'output_schema') {
    return typeof value !== 'object' || Array.isArray(value);
  }
  // module_id, target — must be non-empty strings
  return typeof value !== 'string' || value.length === 0;
}

/**
 * Parse a field expected to be a mapping. When the value is present but is
 * not a mapping (e.g. a string or array from user-edited YAML), emit a
 * warning and fall back to an empty record so the malformed data does not
 * silently persist through round-trip.
 *
 * Returned values are deep-cloned via ``structuredClone`` so later caller
 * mutation of a ``ScannedModule.inputSchema/outputSchema/metadata`` cannot
 * leak back into the parsed YAML source graph. Matches the Rust loader
 * (``serde_json::Value.clone`` is deep) and the Python loader
 * (``copy.deepcopy``).
 */
function asRecord(value: unknown, fieldName: string, moduleId: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!PROTO_DENY.has(k)) safe[k] = v;
    }
    return structuredClone(safe);
  }
  console.warn(
    `BindingLoader: ${fieldName} for module ${moduleId} is not a dict (${typeof value}); using empty {}`,
  );
  return {};
}

/**
 * Same as {@link asRecord}, but returns `null` for absent values
 * (used for optional fields like `display`).
 */
function asRecordOrNull(
  value: unknown,
  fieldName: string,
  moduleId: string,
): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const src = value as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (!PROTO_DENY.has(k)) filtered[k] = v;
    }
    return structuredClone(filtered);
  }
  console.warn(
    `BindingLoader: ${fieldName} for module ${moduleId} is not a dict (${typeof value}); treating as null`,
  );
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseAnnotations(value: unknown, moduleId: string): ModuleAnnotations | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    console.warn(
      `BindingLoader: annotations for module ${moduleId} is not a dict; treating as null`,
    );
    return null;
  }
  try {
    return annotationsFromJSON(value as Record<string, unknown>);
  } catch (exc) {
    console.warn(
      `BindingLoader: failed to parse annotations for module ${moduleId}: ${
        (exc as Error).message
      }; treating as null`,
    );
    return null;
  }
}

function parseExamples(value: unknown, moduleId: string): ModuleExample[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    console.warn(`BindingLoader: examples for module ${moduleId} is not a list; ignoring`);
    return [];
  }
  const result: ModuleExample[] = [];
  value.forEach((ex, i) => {
    if (ex == null || typeof ex !== 'object' || Array.isArray(ex)) {
      console.warn(
        `BindingLoader: examples[${i}] of module ${moduleId} is not a dict; ignoring`,
      );
      return;
    }
    // Deep clone so caller mutation of the returned ScannedModule's
    // examples cannot leak back into the parsed YAML source graph.
    result.push(structuredClone(ex) as ModuleExample);
  });
  return result;
}
