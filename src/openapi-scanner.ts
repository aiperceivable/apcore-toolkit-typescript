/**
 * OpenAPIScanner — turn an OpenAPI 3.x document into a `ScannedModule[]`.
 *
 * Document-level traversal layered on top of the shipped operation-level
 * primitives in `./openapi.js` (`extractInputSchema`, `extractOutputSchema`,
 * `resolveRef`) and `BaseScanner.inferAnnotationsFromMethod`.
 *
 * Pure and synchronous — no I/O. See `./openapi-loader.js` for the
 * (Node-only) `loadSpec` convenience helper, which is intentionally kept in
 * a separate file so this module stays importable from
 * `apcore-toolkit/browser` (see `src/browser/index.ts`).
 *
 * See `apcore-toolkit/docs/features/openapi-scanner.md` for the full
 * specification, worked examples, and conformance corpus.
 */

import { BaseScanner } from './scanner.js';
import type { ScannedModule } from './types.js';
import { cloneModule, createScannedModule } from './types.js';
import { extractInputSchema, extractOutputSchema, resolveRef } from './openapi.js';

/**
 * Thrown by {@link OpenAPIScanner.scan} when the input document is not a
 * recognisable OpenAPI 3.0.x/3.1.x document (missing `openapi` key, or an
 * OpenAPI 2.0 / Swagger document). Matches the doc's Contract: "TypeScript
 * throws `InvalidSpecError`".
 */
export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSpecError';
  }
}

// Only these path-item keys are treated as HTTP operations (OpenAPI 3.x Path
// Item Object). Everything else (`summary`, `parameters`, `servers`, `$ref`,
// vendor `x-*` extensions, ...) is skipped.
const RECOGNIZED_METHODS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

// `normalizeModuleId` regexes. Every class is a literal ASCII range: no
// `\d`, `\w` or `i` flag, each of which is Unicode-aware in at least one of
// the three SDK regex engines (with `iu`, JS matches U+212A KELVIN SIGN
// against `[a-z]`).
//
// OUTSIDE_ALPHABET_RE MUST carry the `u` flag: step 2 replaces per CODE
// POINT. Without `u`, JS matches UTF-16 code units, so an astral character
// (an emoji, a surrogate pair) would become `__` where Python and Rust emit
// one `_` — and runs of `_` are deliberately kept, so the IDs would differ
// (fixture case 025 pins `a\u{1F600}b` -> `a_b`). The boundary regexes only
// ever match ASCII, where `u` changes nothing.
// `([A-Z])`, not `([A-Z]+)`: the output is identical, but the `+` form makes
// the backtracking engine rescan a long run of capitals from every start
// position — quadratic time on a crafted operationId.
const BOUNDARY_ACRONYM_RE = /([A-Z])([A-Z][a-z])/g;
const BOUNDARY_WORD_RE = /([a-z0-9])([A-Z])/g;
const OUTSIDE_ALPHABET_RE = /[^A-Za-z0-9_.]/gu;
const LEADING_UNDERSCORES_RE = /^_+/;
const TRAILING_UNDERSCORES_RE = /_+$/;
// A full match: without the `m` flag, JS `$` matches only at the end of the
// input (unlike Python's `re.match(r"...$")`, which also accepts a trailing
// newline — the spec requires `fullmatch` there).
const LEGAL_SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Project a module-ID candidate into apcore's Canonical ID alphabet
 * (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, PROTOCOL_SPEC §2.7).
 *
 * Implements `normalize_module_id` from
 * `apcore-toolkit/docs/features/openapi-scanner.md` § `module_id`
 * Derivation, byte-for-byte:
 *
 * 1. insert `_` at word boundaries: `([A-Z])([A-Z][a-z])` and
 *    `([a-z0-9])([A-Z])`, each a single left-to-right replace-all;
 * 2. replace every code point not in `[A-Za-z0-9_.]` with `_`;
 * 3. lowercase (only ASCII letters remain, so this cannot reintroduce a
 *    non-ASCII character — U+212A lowercases to ASCII `k`, which is why this
 *    step comes after step 2);
 * 4. split on `.`; strip leading `_` from each segment; drop empty
 *    segments; join the rest with `.`.
 *
 * **A legal apcore ID is returned unchanged** (a MUST in the spec): every
 * step is the identity on the Canonical ID grammar. So runs of `_` are kept
 * (FastAPI's `read_item_items__item_id__get` passes through) and a trailing
 * `_` is kept (a hook's `abc_` passes through). The function is also
 * idempotent. The result can still be illegal (a segment beginning with a
 * digit, or empty); the scanner reports that, this function does not.
 *
 * @internal Exported from this file for unit tests only. It is deliberately
 * not re-exported from `apcore-toolkit` or `apcore-toolkit/browser`: the
 * public surface is {@link deriveModuleId} and {@link OpenAPIScanner.scan}.
 */
export function normalizeModuleId(s: string): string {
  const ascii = s
    .replace(BOUNDARY_ACRONYM_RE, '$1_$2')
    .replace(BOUNDARY_WORD_RE, '$1_$2')
    .replace(OUTSIDE_ALPHABET_RE, '_')
    .toLowerCase();
  return ascii
    .split('.')
    .map((seg) => seg.replace(LEADING_UNDERSCORES_RE, ''))
    .filter((seg) => seg !== '')
    .join('.');
}

/**
 * The first dot-separated segment of `moduleId` that is not a full match of
 * `^[a-z][a-z0-9_]*$`, or `null` when every segment is legal. An empty ID
 * has one segment, the empty string, which fails.
 */
function illegalSegment(moduleId: string): string | null {
  for (const seg of moduleId.split('.')) {
    if (!LEGAL_SEGMENT_RE.test(seg)) return seg;
  }
  return null;
}

/**
 * The pinned legality warning (spec § What normalisation will not repair).
 * The snake_case names are part of the byte-pinned text in every SDK.
 */
function legalityWarning(moduleId: string, segment: string): string {
  return (
    `module_id '${moduleId}' is not a legal apcore module ID: segment '${segment}' ` +
    'must match ^[a-z][a-z0-9_]*$; name this operation with a derive_module_id ' +
    'or transform_module hook'
  );
}

/**
 * Derive a stable, byte-identical `moduleId` for an OpenAPI operation, in
 * apcore's Canonical ID alphabet.
 *
 * A non-empty string `operationId` is converted to snake_case
 * (`getUserById` → `get_user_by_id`), with a trailing `_` stripped
 * (`getUser_` → `get_user`, as 0.11.0 did); apart from that trailing `_`,
 * an `operationId` that is already a legal apcore ID is used as it is.
 * Otherwise each path segment is
 * normalised on its own and the method appended (`GET /users/{user_id}` →
 * `users.user_id.get`); a path with no segment that survives normalisation
 * falls back to `"root.<method>"` (`GET /-` → `root.get`). See
 * `apcore-toolkit/docs/features/openapi-scanner.md` § `module_id`
 * Derivation for the algorithm and worked examples. This function is the
 * primary subject of the cross-SDK conformance corpus — implementations
 * MUST match it byte-for-byte.
 *
 * The result is a legal apcore ID unless a segment begins with a digit
 * (`POST /v1/2fa` → `v1.2fa.post`). This function does not warn about
 * that; {@link OpenAPIScanner.scan} does.
 *
 * @param path - The OpenAPI path template (e.g. `"/users/{user_id}"`).
 * @param method - The HTTP method key as written in the document (e.g. `"get"`).
 * @param operation - The operation object, consulted only for `operationId`.
 * @returns The derived module ID. Never empty — falls back to `"root.<method>"`.
 */
export function deriveModuleId(
  path: string,
  method: string,
  operation: Record<string, unknown>,
): string {
  const operationId = operation['operationId'];
  if (typeof operationId === 'string' && operationId !== '') {
    // The trailing-`_` strip lives here, and only here: the scanner's final
    // normalisation must not rewrite a legal ID (`abc_`) a hook returned.
    const candidate = normalizeModuleId(operationId).replace(TRAILING_UNDERSCORES_RE, '');
    if (candidate) return candidate;
  }

  const parts = path
    .split('/')
    .map((seg) =>
      normalizeModuleId(
        seg.length >= 2 && seg.startsWith('{') && seg.endsWith('}') ? seg.slice(1, -1) : seg,
      ),
    )
    .filter((part) => part !== '');
  if (parts.length > 0) {
    return [...parts, method.toLowerCase()].join('.');
  }

  return `root.${method.toLowerCase()}`;
}

/** Depth-first collect every `$ref` string appearing under `node`. */
function collectRefs(node: unknown): string[] {
  const refs: string[] = [];
  if (Array.isArray(node)) {
    for (const item of node) refs.push(...collectRefs(item));
  } else if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string') refs.push(ref);
    for (const value of Object.values(obj)) refs.push(...collectRefs(value));
  }
  return refs;
}

/**
 * Warn on unresolvable internal refs and refuse external refs.
 *
 * Internal refs (`#/...`) that resolve successfully are silent — this only
 * flags the failure cases enumerated in the Error Model: unresolvable
 * internal `$ref` and external `$ref` (never fetched).
 */
function refWarnings(operation: Record<string, unknown>, spec: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const refs = [
    ...collectRefs(operation['requestBody'] ?? {}),
    ...collectRefs(operation['responses'] ?? {}),
  ];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (!ref.startsWith('#/')) {
      warnings.push(`external $ref not fetched: ${ref}`);
    } else if (Object.keys(resolveRef(ref, spec)).length === 0) {
      warnings.push(`unresolvable $ref: ${ref}`);
    }
  }
  return warnings;
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (stripped) return stripped;
  }
  return null;
}

const ABS_URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const TEMPLATE_VAR_RE = /\{([^}]+)\}/g;

/**
 * Best-effort resolution of `servers[0].url`.
 *
 * Absolute URLs are used verbatim. Templated URLs are substituted from
 * `servers[0].variables[*].default` when every variable has one; otherwise
 * the URL is unusable and omitted. Relative URLs require the spec's
 * *source* URL to resolve against, which `scan()` — pure and I/O-free —
 * does not have; they are omitted here (advisory only; the caller supplies
 * `baseUrl` to the writer regardless).
 */
function resolveServerUrl(spec: Record<string, unknown>): string | null {
  const servers = spec['servers'];
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const first = servers[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  const firstObj = first as Record<string, unknown>;
  const url = firstObj['url'];
  if (typeof url !== 'string' || url === '') return null;
  if (!ABS_URL_RE.test(url)) return null;

  let resultUrl = url;
  const variables = firstObj['variables'];
  if (
    variables !== null &&
    typeof variables === 'object' &&
    !Array.isArray(variables) &&
    Object.keys(variables as Record<string, unknown>).length > 0
  ) {
    const varsObj = variables as Record<string, unknown>;
    const substitutions: Record<string, string> = {};
    for (const [name, v] of Object.entries(varsObj)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v) || !('default' in v)) {
        return null;
      }
      substitutions[name] = String((v as Record<string, unknown>)['default']);
    }
    resultUrl = resultUrl.replace(TEMPLATE_VAR_RE, (match, varName: string) => substitutions[varName] ?? match);
    if (resultUrl.includes('{') || resultUrl.includes('}')) return null;
  }

  return resultUrl;
}

function validateSpec(spec: unknown): asserts spec is Record<string, unknown> {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new InvalidSpecError('OpenAPIScanner.scan: spec must be an object');
  }
  const openapiVersion = (spec as Record<string, unknown>)['openapi'];
  if (
    typeof openapiVersion !== 'string' ||
    !(openapiVersion.startsWith('3.0') || openapiVersion.startsWith('3.1'))
  ) {
    throw new InvalidSpecError(
      'OpenAPIScanner.scan: unsupported spec — expected OpenAPI 3.0.x or 3.1.x, ' +
        `got 'openapi': ${JSON.stringify(openapiVersion ?? null)} (swagger 2.0 is not supported in V1)`,
    );
  }
}

/**
 * Options for {@link OpenAPIScanner.scan}. See
 * `apcore-toolkit/docs/features/openapi-scanner.md` § Contract:
 * OpenAPIScanner.scan and § Extension Hooks.
 */
export interface OpenAPIScanOptions {
  /** Regex forwarded to `filterModules`; only matching module IDs are kept. */
  include?: string;
  /** Regex forwarded to `filterModules`; matching module IDs are removed. */
  exclude?: string;
  /**
   * Prepended to every derived `moduleId` as `"<prefix>.<id>"`, before
   * filtering/dedup. Part of the final ID, so it is normalised with it
   * (`"Pet-Store"` → `pet_store.users.get`).
   */
  basePathPrefix?: string;
  /** When `false`, operations with `deprecated: true` are omitted entirely. Default `true`. */
  includeDeprecated?: boolean;
  /** Patch or normalise an operation before extraction. Returning `null` skips it entirely. */
  transformOperation?: (
    path: string,
    method: string,
    operation: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  /**
   * Override the naming algorithm. Returning `null` falls back to
   * {@link deriveModuleId}. The hook chooses the words; the scanner owns the
   * alphabet — the returned ID is normalised like the default derivation
   * (`"Custom-Space.GetThing"` → `custom_space.get_thing`), and a legal ID
   * it returns is kept exactly (`abc_` stays `abc_`).
   */
  deriveModuleId?: (path: string, method: string, operation: Record<string, unknown>) => string | null;
  /**
   * Adjust the finished module. Returning `null` drops it from the result.
   * A `moduleId` it sets is normalised afterwards, and checked for legality
   * after deduplication.
   */
  transformModule?: (module: ScannedModule) => ScannedModule | null;
}

/**
 * Turn an OpenAPI 3.0/3.1 document into a list of `ScannedModule`.
 *
 * Pure and synchronous: `scan()` accepts an already-parsed document and
 * performs no I/O. Use `loadSpec` (from `./openapi-loader.js`) to
 * fetch/parse a document first.
 *
 * Every emitted `moduleId` is in apcore's Canonical ID alphabet, and one
 * that was already a legal apcore ID is never rewritten. One that is still
 * not legal (a segment beginning with a digit, or an empty ID from a hook) is
 * emitted anyway; after deduplication it gets a legality warning in
 * `warnings` naming the ID actually emitted. No `suggestedAlias` is set — a
 * deliberate spec decision; the raw `operationId` is in
 * `metadata.openapi.operation_id` for a surface that wants it.
 */
export class OpenAPIScanner extends BaseScanner {
  scan(spec: Record<string, unknown>, options: OpenAPIScanOptions = {}): ScannedModule[] {
    validateSpec(spec);

    const {
      include,
      exclude,
      basePathPrefix,
      includeDeprecated = true,
      transformOperation,
      deriveModuleId: deriveModuleIdHook,
      transformModule,
    } = options;

    const rawPaths = spec['paths'];
    const paths =
      rawPaths !== null && typeof rawPaths === 'object' && !Array.isArray(rawPaths)
        ? (rawPaths as Record<string, unknown>)
        : {};

    const openapiVersion = spec['openapi'];
    const info = spec['info'];
    const infoVersion =
      info !== null && typeof info === 'object' && !Array.isArray(info)
        ? (info as Record<string, unknown>)['version']
        : undefined;
    const docVersion = typeof infoVersion === 'string' && infoVersion ? infoVersion : '1.0.0';
    const serverUrl = resolveServerUrl(spec);

    let modules: ScannedModule[] = [];

    for (const [path, rawPathItem] of Object.entries(paths)) {
      if (typeof rawPathItem !== 'object' || rawPathItem === null || Array.isArray(rawPathItem)) continue;
      const pathItem = rawPathItem as Record<string, unknown>;

      for (const [key, rawOperation] of Object.entries(pathItem)) {
        const method = key.toLowerCase();
        if (
          !RECOGNIZED_METHODS.has(method) ||
          typeof rawOperation !== 'object' ||
          rawOperation === null ||
          Array.isArray(rawOperation)
        ) {
          continue;
        }

        let operation = rawOperation as Record<string, unknown>;

        if (transformOperation) {
          const transformed = transformOperation(path, method, operation);
          if (transformed === null) continue;
          operation = transformed;
        }

        // Strict boolean check (not truthy coercion): OpenAPI's `deprecated`
        // is typed `boolean` in the spec, so a malformed non-boolean value
        // (e.g. the string `"false"`) should not flip this on. Matches
        // Rust's `and_then(Value::as_bool)` behavior.
        const deprecated = operation['deprecated'] === true;
        if (deprecated && !includeDeprecated) continue;

        let mid = deriveModuleIdHook ? deriveModuleIdHook(path, method, operation) : null;
        if (mid === null || mid === undefined) {
          mid = deriveModuleId(path, method, operation);
        }
        if (basePathPrefix) {
          mid = `${basePathPrefix}.${mid}`;
        }

        const warnings = refWarnings(operation, spec);

        const inputSchema = extractInputSchema(operation, spec);
        const outputSchema = extractOutputSchema(operation, spec);
        const responses = operation['responses'];
        const hasSuccess =
          responses !== null && typeof responses === 'object' && !Array.isArray(responses)
            ? Object.keys(responses as Record<string, unknown>).some((status) => /^2\d\d$/.test(status))
            : false;
        if (!hasSuccess) {
          warnings.push('no 2xx response defined; output_schema is empty');
        }

        let annotations = BaseScanner.inferAnnotationsFromMethod(method);
        if (deprecated) {
          // ModuleAnnotations has no first-class `deprecated` field; the
          // toolkit convention is `annotations.extra.deprecated` (see also
          // tui-view-model.ts's Filter.deprecated handling).
          annotations = { ...annotations, extra: { ...annotations.extra, deprecated: true } };
        }

        const summaryVal = operation['summary'];
        const summary = typeof summaryVal === 'string' && summaryVal ? summaryVal : null;
        const descriptionVal = operation['description'];
        const documentation = typeof descriptionVal === 'string' ? descriptionVal : null;
        const description = summary ?? firstLine(documentation) ?? '';

        const openapiMeta: Record<string, unknown> = { spec_version: openapiVersion };
        const operationIdVal = operation['operationId'];
        if (typeof operationIdVal === 'string' && operationIdVal) {
          openapiMeta['operation_id'] = operationIdVal;
        }
        if (serverUrl) {
          openapiMeta['server_url'] = serverUrl;
        }
        if (summary) {
          openapiMeta['summary'] = summary;
        }

        const rawTags = operation['tags'];
        const tags = Array.isArray(rawTags)
          ? rawTags.filter((t): t is string => typeof t === 'string')
          : [];

        let module: ScannedModule = createScannedModule({
          moduleId: mid,
          description,
          inputSchema,
          outputSchema,
          tags,
          target: `${method.toUpperCase()} ${path}`,
          version: docVersion,
          annotations,
          documentation,
          metadata: {
            http_method: method.toUpperCase(),
            url_path: path,
            openapi: openapiMeta,
          },
          warnings,
        });

        if (transformModule) {
          const transformed = transformModule(module);
          if (transformed === null) continue;
          module = transformed;
        }

        // The scanner owns the alphabet: normalise the FINAL ID — after the
        // derive_module_id hook, basePathPrefix and transformModule — so the
        // filters match, and deduplication resolves, the ID actually emitted.
        // A legal ID is returned unchanged, so default-derived IDs and any
        // legal ID a hook returns pass through as they are.
        const finalId = normalizeModuleId(module.moduleId);
        if (finalId !== module.moduleId) {
          module = cloneModule(module, { moduleId: finalId });
        }

        modules.push(module);
      }
    }

    modules = this.filterModules(modules, include, exclude);
    modules = this.deduplicateIds(modules);

    // Last of all: what normalisation cannot repair (a digit-leading
    // segment, or an empty ID from a hook) is reported, not invented. The
    // module is still emitted; running after deduplication means the warning
    // names the ID actually emitted (`3ds_2`, not `3ds`) and follows any
    // rename warning.
    return modules.map((m) => {
      const badSegment = illegalSegment(m.moduleId);
      return badSegment === null
        ? m
        : cloneModule(m, { warnings: [...m.warnings, legalityWarning(m.moduleId, badSegment)] });
    });
  }

  getSourceName(): string {
    return 'openapi';
  }
}
