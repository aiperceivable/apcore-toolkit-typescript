# apcore-toolkit-typescript — Implementation Plan

> Ported from `apcore-toolkit-python` (reference implementation)
> Target: TypeScript (ESM, apcore-js >=0.9.0)

## Feature Manifest

| ID  | Feature             | Source (Python)          | Target (TypeScript)           | Deps | Priority |
|-----|---------------------|--------------------------|-------------------------------|------|----------|
| F01 | types               | types.py                 | src/types.ts                  | —    | P0       |
| F02 | scanner             | scanner.py               | src/scanner.ts                | F01  | P0       |
| F03 | schema-utils        | schema_utils.py          | src/schema-utils.ts           | —    | P0       |
| F04 | openapi             | openapi.py               | src/openapi.ts                | —    | P0       |
| F05 | serializers         | serializers.py           | src/serializers.ts            | F01  | P0       |
| F06 | resolve-target      | pydantic_utils.py        | src/resolve-target.ts         | —    | P0       |
| F07 | formatting/markdown | formatting/markdown.py   | src/formatting/markdown.ts    | —    | P1       |
| F08 | output/yaml-writer  | output/yaml_writer.py    | src/output/yaml-writer.ts     | F01,F05 | P1   |
| F09 | output/ts-writer    | output/python_writer.py  | src/output/typescript-writer.ts| F01 | P1       |
| F10 | output/reg-writer   | output/registry_writer.py| src/output/registry-writer.ts | F01,F05,F06 | P1 |
| F11 | output/factory      | output/__init__.py       | src/output/factory.ts         | F08,F09,F10 | P1 |

## Porting Notes

### What stays the same
- ScannedModule field structure (12 fields)
- BaseScanner abstract interface pattern
- JSON Schema enrichment logic
- OpenAPI utilities (language-agnostic)
- Serialization logic
- Markdown rendering algorithm
- YAML writer structure and security (sanitization, path traversal checks)
- Output factory pattern

### What changes
- **PythonWriter → TypeScriptWriter**: Generates `.ts` files with `module()` decorator from apcore-js
- **pydantic_utils.flatten_pydantic_params → DROPPED**: Not applicable in TypeScript ecosystem; framework scanners (nestjs-apcore, tiptap-apcore) handle schema extraction directly
- **pydantic_utils.resolve_target → resolveTarget**: Adapted for TypeScript dynamic `import()` — async instead of sync
- **RegistryWriter**: Uses apcore-js `FunctionModule` constructor (different API from Python apcore)
- **ModuleAnnotations/ModuleExample**: Re-exported from `apcore-js` instead of `apcore`
- **dataclasses.replace() → spread operator**: For immutable ScannedModule updates
- **logging → console.warn**: Standard console logging (no Python logging module)

### Scanner design informed by real-world usage
Based on analysis of `nestjs-apcore` and `tiptap-apcore`:
- **nestjs-apcore** uses NestJS DI + Reflect metadata for scanning — the BaseScanner provides the abstract scan() + utilities
- **tiptap-apcore** uses runtime extension iteration — similar pattern, custom scan logic
- BaseScanner provides: `filterModules()`, `deduplicateIds()`, `inferAnnotationsFromMethod()`
- `extractDocstring` is Python-specific → replaced with optional `extractDescription(func)` that reads JSDoc if available

---

## F01: types — ScannedModule Interface

**Source:** `apcore-toolkit-python/src/apcore_toolkit/types.py`
**Target:** `src/types.ts`
**Test:** `tests/types.test.ts`

### API Surface

```typescript
import type { ModuleAnnotations, ModuleExample } from 'apcore-js';

export interface ScannedModule {
  readonly moduleId: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly target: string;
  readonly version: string;
  readonly annotations: ModuleAnnotations | null;
  readonly documentation: string | null;
  readonly examples: readonly ModuleExample[];
  readonly metadata: Record<string, unknown>;
  readonly warnings: readonly string[];
}

export function createScannedModule(options: {
  moduleId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tags: string[];
  target: string;
  version?: string;
  annotations?: ModuleAnnotations | null;
  documentation?: string | null;
  examples?: ModuleExample[];
  metadata?: Record<string, unknown>;
  warnings?: string[];
}): ScannedModule;

export function cloneModule(
  module: ScannedModule,
  overrides?: Partial<Omit<ScannedModule, 'readonly'>>,
): ScannedModule;
```

### TDD Tasks

1. RED: Test `createScannedModule` with all required fields → returns ScannedModule with correct defaults
2. GREEN: Implement `createScannedModule` with default values (version="1.0.0", annotations=null, etc.)
3. RED: Test `createScannedModule` preserves optional overrides
4. GREEN: Wire optional fields through
5. RED: Test `cloneModule` returns new object with overrides applied
6. GREEN: Implement `cloneModule` using spread operator
7. RED: Test mutable default independence (two modules with independent arrays)
8. GREEN: Ensure factory creates fresh arrays/objects per instance
9. REFACTOR: Ensure readonly types are enforced at compile time

---

## F02: scanner — BaseScanner Abstract Class

**Source:** `apcore-toolkit-python/src/apcore_toolkit/scanner.py`
**Target:** `src/scanner.ts`
**Test:** `tests/scanner.test.ts`

### API Surface

```typescript
import type { ModuleAnnotations } from 'apcore-js';
import type { ScannedModule } from './types.js';

export abstract class BaseScanner {
  abstract scan(...args: unknown[]): ScannedModule[] | Promise<ScannedModule[]>;
  abstract getSourceName(): string;

  filterModules(
    modules: ScannedModule[],
    options?: { include?: string; exclude?: string },
  ): ScannedModule[];

  static inferAnnotationsFromMethod(method: string): ModuleAnnotations;

  deduplicateIds(modules: ScannedModule[]): ScannedModule[];
}
```

### TDD Tasks

1. RED: Test `filterModules` with include pattern → only matching modules returned
2. GREEN: Implement regex-based include filtering
3. RED: Test `filterModules` with exclude pattern → matching modules removed
4. GREEN: Implement regex-based exclude filtering
5. RED: Test `filterModules` with both include and exclude → include applied first, then exclude
6. GREEN: Chain both filters
7. RED: Test `inferAnnotationsFromMethod("GET")` → `{ readonly: true }`
8. GREEN: Implement HTTP method to annotations mapping (GET→readonly, DELETE→destructive, PUT→idempotent)
9. RED: Test `deduplicateIds` with duplicate module IDs → appends _2, _3
10. GREEN: Implement deduplication with warning tracking
11. RED: Test `deduplicateIds` preserves original modules (returns new instances)
12. GREEN: Use `cloneModule()` for immutable updates
13. RED: Test abstract interface — subclass must implement scan() and getSourceName()
14. GREEN: Verify TypeScript compiler enforces abstract methods
15. REFACTOR: Clean up, ensure scan() supports both sync and async return

---

## F03: schema-utils — JSON Schema Enrichment

**Source:** `apcore-toolkit-python/src/apcore_toolkit/schema_utils.py`
**Target:** `src/schema-utils.ts`
**Test:** `tests/schema-utils.test.ts`

### API Surface

```typescript
export function enrichSchemaDescriptions(
  schema: Record<string, unknown>,
  paramDescriptions: Record<string, string>,
  options?: { overwrite?: boolean },
): Record<string, unknown>;
```

### TDD Tasks

1. RED: Test returns original schema when paramDescriptions is empty
2. GREEN: Early return on empty descriptions
3. RED: Test returns original schema when no "properties" key
4. GREEN: Early return on missing properties
5. RED: Test merges descriptions into properties that lack them
6. GREEN: Deep copy schema and merge descriptions
7. RED: Test does NOT overwrite existing descriptions by default
8. GREEN: Check for existing "description" before setting
9. RED: Test overwrite=true replaces existing descriptions
10. GREEN: Implement overwrite flag
11. RED: Test original schema is not mutated
12. GREEN: Verify deep copy behavior

---

## F04: openapi — OpenAPI Schema Extraction

**Source:** `apcore-toolkit-python/src/apcore_toolkit/openapi.py`
**Target:** `src/openapi.ts`
**Test:** `tests/openapi.test.ts`

### API Surface

```typescript
export function resolveRef(
  refString: string,
  openapiDoc: Record<string, unknown>,
): Record<string, unknown>;

export function resolveSchema(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null,
): Record<string, unknown>;

export function extractInputSchema(
  operation: Record<string, unknown>,
  openapiDoc?: Record<string, unknown> | null,
): Record<string, unknown>;

export function extractOutputSchema(
  operation: Record<string, unknown>,
  openapiDoc?: Record<string, unknown> | null,
): Record<string, unknown>;
```

### TDD Tasks

1. RED: Test `resolveRef` with valid `#/components/schemas/Foo` → returns schema
2. GREEN: Implement JSON pointer traversal
3. RED: Test `resolveRef` with non-`#/` prefix → returns `{}`
4. GREEN: Guard against invalid ref formats
5. RED: Test `resolveRef` with missing intermediate path → returns `{}`
6. GREEN: Safe navigation with fallback
7. RED: Test `resolveSchema` with `$ref` → resolves reference
8. GREEN: Delegate to `resolveRef`
9. RED: Test `resolveSchema` without `$ref` → returns as-is
10. GREEN: Pass-through logic
11. RED: Test `extractInputSchema` merges query, path, and body params
12. GREEN: Implement parameter merging with required tracking
13. RED: Test `extractInputSchema` resolves `$ref` in parameter schemas
14. GREEN: Call `resolveSchema` on each param schema
15. RED: Test `extractOutputSchema` from 200 response
16. GREEN: Implement response extraction with status code fallback
17. RED: Test `extractOutputSchema` handles array with `$ref` items
18. GREEN: Recursively resolve `$ref` in array items
19. RED: Test `extractOutputSchema` returns default schema when no responses
20. GREEN: Return `{ type: "object", properties: {} }` as fallback

---

## F05: serializers — Module Serialization

**Source:** `apcore-toolkit-python/src/apcore_toolkit/serializers.py`
**Target:** `src/serializers.ts`
**Test:** `tests/serializers.test.ts`

### API Surface

```typescript
import type { ScannedModule } from './types.js';

export function annotationsToDict(
  annotations: unknown,
): Record<string, unknown> | null;

export function moduleToDict(
  module: ScannedModule,
): Record<string, unknown>;

export function modulesToDicts(
  modules: ScannedModule[],
): Record<string, unknown>[];
```

### TDD Tasks

1. RED: Test `annotationsToDict(null)` → returns null
2. GREEN: Handle null case
3. RED: Test `annotationsToDict(plainObject)` → returns as-is
4. GREEN: Return plain objects directly
5. RED: Test `annotationsToDict` with apcore-js ModuleAnnotations → returns dict
6. GREEN: Handle ModuleAnnotations conversion (already a plain object in TS)
7. RED: Test `moduleToDict` serializes all 12 fields correctly
8. GREEN: Implement field-by-field mapping
9. RED: Test `modulesToDicts` batch conversion
10. GREEN: Map over array

---

## F06: resolve-target — Dynamic Import Resolution

**Source:** `apcore-toolkit-python/src/apcore_toolkit/pydantic_utils.py` (resolve_target only)
**Target:** `src/resolve-target.ts`
**Test:** `tests/resolve-target.test.ts`

### API Surface

```typescript
export async function resolveTarget(target: string): Promise<unknown>;
```

### Adaptation Notes

In Python, `resolve_target("json:loads")` synchronously imports the module. In TypeScript,
this must be async due to dynamic `import()`. The format is `"module/path:exportName"`.

### TDD Tasks

1. RED: Test rejects target without `:` separator → throws ValueError
2. GREEN: Validate format
3. RED: Test resolves `"node:path:join"` style targets → handles module:export split correctly
4. GREEN: Use partition on last `:` for module path
5. RED: Test throws ImportError for nonexistent module
6. GREEN: Catch and rethrow import() errors
7. RED: Test throws AttributeError for nonexistent export
8. GREEN: Check export exists on imported module

---

## F07: formatting/markdown — Dict-to-Markdown Conversion

**Source:** `apcore-toolkit-python/src/apcore_toolkit/formatting/markdown.py`
**Target:** `src/formatting/markdown.ts`
**Test:** `tests/markdown.test.ts`

### API Surface

```typescript
export function toMarkdown(
  data: Record<string, unknown>,
  options?: {
    fields?: string[];
    exclude?: string[];
    maxDepth?: number;
    tableThreshold?: number;
    title?: string;
  },
): string;
```

### TDD Tasks

1. RED: Test scalar dict renders as bullet list
2. GREEN: Implement `_renderDict` with scalar handling
3. RED: Test dict throws TypeError for non-dict input
4. GREEN: Add type guard
5. RED: Test `fields` option filters top-level keys
6. GREEN: Implement `_filterKeys` with fields filter
7. RED: Test `exclude` option removes keys at all levels
8. GREEN: Implement exclude filtering at every recursion level
9. RED: Test nested dict renders with headings at top level
10. GREEN: Implement heading generation for depth=0 nested dicts
11. RED: Test `maxDepth` truncates deep nesting with compact repr
12. GREEN: Implement depth tracking and compact repr fallback
13. RED: Test scalar dict with >= tableThreshold keys renders as table
14. GREEN: Implement `_renderTable` with pipe escaping
15. RED: Test list of uniform dicts renders as multi-column table
16. GREEN: Implement `_renderListTable` with `_uniformKeys` check
17. RED: Test special value formatting: null→"*N/A*", bool→Yes/No, float→4-sig-fig
18. GREEN: Implement `_formatScalar` with special cases
19. RED: Test `title` option prepends `# title` heading
20. GREEN: Add title handling to main function
21. REFACTOR: Ensure pipe characters are escaped in table cells

---

## F08: output/yaml-writer — YAML Binding File Generator

**Source:** `apcore-toolkit-python/src/apcore_toolkit/output/yaml_writer.py`
**Target:** `src/output/yaml-writer.ts`
**Test:** `tests/yaml-writer.test.ts`

### API Surface

```typescript
import type { ScannedModule } from '../types.js';

export class YAMLWriter {
  write(
    modules: ScannedModule[],
    outputDir: string,
    options?: { dryRun?: boolean },
  ): Record<string, unknown>[];
}
```

### TDD Tasks

1. RED: Test dry run returns binding data without writing files
2. GREEN: Implement `_buildBinding` and dry run path
3. RED: Test writes `.binding.yaml` files to output directory
4. GREEN: Implement file writing with js-yaml
5. RED: Test filename sanitization (special characters → underscores)
6. GREEN: Implement regex-based sanitization
7. RED: Test path traversal protection (consecutive dots collapsed)
8. GREEN: Implement `is_relative_to` equivalent check
9. RED: Test auto-generated header with timestamp
10. GREEN: Add header to YAML output
11. RED: Test None annotations handled correctly
12. GREEN: Pass through null annotations

---

## F09: output/typescript-writer — TypeScript Code Generator

**Source:** `apcore-toolkit-python/src/apcore_toolkit/output/python_writer.py` (adapted)
**Target:** `src/output/typescript-writer.ts`
**Test:** `tests/typescript-writer.test.ts`

### API Surface

```typescript
import type { ScannedModule } from '../types.js';

export class TypeScriptWriter {
  write(
    modules: ScannedModule[],
    outputDir: string,
    options?: { dryRun?: boolean },
  ): string[];
}
```

### Adaptation Notes

Generates TypeScript files instead of Python. Output format:

```typescript
// Auto-generated apcore module: "module.id"
// Generated: 2026-03-07T...
// Do not edit manually unless you intend to customize behavior.

import { module } from 'apcore-js';
import { Type } from '@sinclair/typebox';

export default module({
  id: 'module.id',
  description: '...',
  inputSchema: Type.Object({ ... }),
  outputSchema: Type.Object({ ... }),
  tags: ['...'],
  version: '1.0.0',
  annotations: { readonly: true },
  async execute(inputs) {
    const { targetExport: _original } = await import('target/module');
    return _original(inputs);
  },
});
```

### TDD Tasks

1. RED: Test generates valid TypeScript code with module() wrapper
2. GREEN: Implement code generation template
3. RED: Test function name sanitization (special chars → underscores)
4. GREEN: Implement identifier sanitization
5. RED: Test JSON Schema to TypeBox schema conversion in generated code
6. GREEN: Implement schema-to-TypeBox code generation
7. RED: Test target module path validation
8. GREEN: Validate module path format
9. RED: Test file writing with path safety
10. GREEN: Implement file output with sanitization and traversal protection
11. RED: Test annotations included in generated code when present
12. GREEN: Conditionally include annotations
13. REFACTOR: Ensure generated code is ESM-compatible

---

## F10: output/registry-writer — Direct Registry Registration

**Source:** `apcore-toolkit-python/src/apcore_toolkit/output/registry_writer.py`
**Target:** `src/output/registry-writer.ts`
**Test:** `tests/registry-writer.test.ts`

### API Surface

```typescript
import type { Registry } from 'apcore-js';
import type { ScannedModule } from '../types.js';

export class RegistryWriter {
  write(
    modules: ScannedModule[],
    registry: Registry,
    options?: { dryRun?: boolean },
  ): Promise<string[]>;
}
```

### Adaptation Notes

- Uses `apcore-js` `FunctionModule` constructor (different from Python `apcore.FunctionModule`)
- Uses `resolveTarget()` (async) instead of sync resolve
- No Pydantic flattening needed — TypeScript functions already use flat params
- The execute function wraps dynamic import + call

### TDD Tasks

1. RED: Test dry run returns module IDs without registration
2. GREEN: Implement dry run path
3. RED: Test registers FunctionModule in registry
4. GREEN: Implement `_toFunctionModule` with apcore-js FunctionModule
5. RED: Test resolves target to callable
6. GREEN: Use `resolveTarget()` for dynamic import
7. RED: Test handles multiple modules
8. GREEN: Iterate and register all modules

---

## F11: output/factory — Writer Factory

**Source:** `apcore-toolkit-python/src/apcore_toolkit/output/__init__.py`
**Target:** `src/output/factory.ts`
**Test:** `tests/output-factory.test.ts`

### API Surface

```typescript
import type { YAMLWriter } from './yaml-writer.js';
import type { TypeScriptWriter } from './typescript-writer.js';
import type { RegistryWriter } from './registry-writer.js';

export function getWriter(format: string): YAMLWriter | TypeScriptWriter | RegistryWriter;
```

### TDD Tasks

1. RED: Test `getWriter("yaml")` → returns YAMLWriter instance
2. GREEN: Dispatch to YAMLWriter
3. RED: Test `getWriter("typescript")` → returns TypeScriptWriter instance
4. GREEN: Dispatch to TypeScriptWriter
5. RED: Test `getWriter("registry")` → returns RegistryWriter instance
6. GREEN: Dispatch to RegistryWriter
7. RED: Test `getWriter("unknown")` → throws ValueError
8. GREEN: Throw on unrecognized format

---

## Implementation Order

### Wave 1 (P0 — No dependencies)
Execute in parallel:
- **F01** types
- **F03** schema-utils
- **F04** openapi
- **F06** resolve-target

### Wave 2 (P0 — Depends on F01)
Execute in parallel:
- **F02** scanner (depends on F01)
- **F05** serializers (depends on F01)

### Wave 3 (P1 — Depends on Wave 1+2)
Execute in parallel:
- **F07** formatting/markdown (no deps, just lower priority)
- **F08** output/yaml-writer (depends on F01, F05)
- **F09** output/typescript-writer (depends on F01)
- **F10** output/registry-writer (depends on F01, F05, F06)

### Wave 4 (P1 — Depends on Wave 3)
- **F11** output/factory (depends on F08, F09, F10)
