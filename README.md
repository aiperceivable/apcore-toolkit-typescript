<div align="center">
  <img src="https://raw.githubusercontent.com/aiperceivable/apcore-toolkit/main/apcore-toolkit-logo.svg" alt="apcore-toolkit logo" width="200"/>
</div>

# apcore-toolkit

Shared scanner, schema extraction, and output toolkit for apcore framework adapters (TypeScript).

## Install

```bash
npm install apcore-toolkit
```

## Features

- Abstract `BaseScanner` for framework-specific endpoint scanning
- OpenAPI schema extraction (`extractInputSchema`, `extractOutputSchema`)
- Multi-format output writers (YAML, TypeScript, Registry, HTTP-proxy) with pluggable verification
- `assertAnnotationsPreserved` conformance check — guards that a writer keeps behavioral annotations through registration (so approval/ACL gating cannot be silently disabled)
- Markdown formatting with depth control and table heuristics
- Module serialization utilities
- Runtime-neutral subset via `apcore-toolkit/browser` for browser / edge / worker environments

## Usage

### ScannedModule

The canonical representation of a scanned endpoint:

```typescript
import { createScannedModule, cloneModule } from 'apcore-toolkit';

const mod = createScannedModule({
  moduleId: 'users.get_user',
  description: 'Get a user by ID',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  tags: ['users'],
  target: 'myapp/users:getUser',
});
```

### BaseScanner

Abstract base class for framework-specific scanners:

```typescript
import { BaseScanner } from 'apcore-toolkit';
import type { ScannedModule } from 'apcore-toolkit';

class MyScanner extends BaseScanner {
  scan(): ScannedModule[] {
    // scan your framework endpoints
    return [];
  }
  getSourceName(): string {
    return 'my-framework';
  }
}
```

### Output Writers

Three output strategies for scanned modules:

```typescript
import { YAMLWriter, TypeScriptWriter, RegistryWriter, getWriter } from 'apcore-toolkit';

// YAML binding files
const yamlWriter = new YAMLWriter();
yamlWriter.write(modules, './output');

// TypeScript module wrappers
const tsWriter = new TypeScriptWriter();
tsWriter.write(modules, './output');

// Direct registry registration
const regWriter = new RegistryWriter();
await regWriter.write(modules, registry);

// Or use the factory
const writer = getWriter('yaml'); // 'yaml' | 'typescript' | 'registry' | 'http-proxy'
```

### Conformance Verification

Approval and ACL gating key on a module's `requiresApproval` annotation, which is
only reachable if annotations survive `scan → register → getDefinition`. A writer
that drops them disables that gate **silently**. Run the shared check in your
adapter's test suite so any such regression fails loudly:

```typescript
import { Registry, createAnnotations } from 'apcore-js';
import { assertAnnotationsPreserved } from 'apcore-toolkit';

// Throws if annotations were dropped or changed during registration.
await assertAnnotationsPreserved(
  new MyRegistryWriter(),
  myScannedModule({ annotations: createAnnotations({ destructive: true, requiresApproval: true }) }),
  new Registry(),
);
```

### OpenAPI Schema Extraction

```typescript
import { extractInputSchema, extractOutputSchema } from 'apcore-toolkit';

const inputSchema = extractInputSchema(operation, openapiDoc);
const outputSchema = extractOutputSchema(operation, openapiDoc);
```

### Markdown Formatting

```typescript
import { toMarkdown } from 'apcore-toolkit';

const md = toMarkdown(data, {
  title: 'Report',
  fields: ['name', 'status'],
  exclude: ['internal'],
  maxDepth: 3,
  tableThreshold: 5,
});
```

### Tabular Formats (v0.7.0)

Byte-equivalent CSV / JSONL emitters with a cross-SDK conformance contract — TypeScript, Python, and Rust produce identical bytes for the same input.

```typescript
import { formatCsv, formatJsonl } from 'apcore-toolkit';

const rows = [
  { sn: 1, title: 'First', score: 78 },
  { sn: 2, title: 'Second', score: 82, description: 'later-only field' },
];

// CSV: header = union of keys across all rows (no silent data loss on
// heterogeneous rows); nested values serialized via JSON.stringify; RFC 4180
// CRLF line terminator.
process.stdout.write(formatCsv(rows));
// sn,title,score,description\r\n1,First,78,\r\n2,Second,82,later-only field\r\n

// JSONL: canonical compact JSON per row, LF terminator, no trailing blank.
process.stdout.write(formatJsonl(rows));

// UTF-8 BOM for Excel locales (default off for pipeline consumers):
process.stdout.write(formatCsv(rows, { bom: true }));
```

See `apcore-toolkit/docs/features/formatting.md` § Tabular Formats for the full contract and `apcore-toolkit/conformance/fixtures/format_csv.json` / `format_jsonl.json` for the shared cross-SDK test corpus.

### Serializers

```typescript
import { moduleToDict, modulesToDicts, annotationsToDict } from 'apcore-toolkit';

const dict = moduleToDict(mod);       // snake_case keys
const dicts = modulesToDicts(modules); // batch conversion
```

## Browser / edge runtime

The default entry point (`apcore-toolkit`) targets Node: it exposes writers
that touch the filesystem (`YAMLWriter`, `TypeScriptWriter`), a binding
loader that reads from disk (`BindingLoader`), display / target resolvers,
and the `VERSION` constant — all of which transitively pull in `node:fs`,
`node:path`, `node:module`, or `process.*` and would break a browser
bundle.

For browser, edge-runtime, or worker consumers, `apcore-toolkit/browser`
exports the runtime-neutral subset — schema / OpenAPI utilities, the
abstract scanner, serializers, Markdown formatting, the binding **parser**
(no filesystem access), the write-pipeline types, the runtime-neutral
verifier primitives (`RegistryVerifier`, `runVerifierChain`), and the
`HTTPProxyRegistryWriter` (uses only global `fetch` / `AbortController`).

```typescript
import {
  BaseScanner,
  BindingParser,
  parseBindingDocument,
  HTTPProxyRegistryWriter,
  toMarkdown,
} from 'apcore-toolkit/browser';

// Parse a binding document fetched from a backend (no fs access).
const resp   = await fetch('/api/bindings');
const doc    = await resp.json();
const modules = new BindingParser().loadData(doc);

// Register each module as an HTTP proxy in an in-browser registry.
const writer = new HTTPProxyRegistryWriter({ baseUrl: '/api' });
await writer.write(modules, registry);
```

The default entry continues to re-export every symbol it always did (for
tri-SDK parity with the Python and Rust toolkits and for unchanged behaviour
in `nestjs-apcore` etc.). The `/browser` subpath is strictly additive — it
exposes a subset of the same underlying classes, not a forked implementation.
A static import-graph check in the test suite fails CI if any Node-only
reference leaks into the subpath.

## API

The **Browser** column marks whether a symbol is also re-exported from
`apcore-toolkit/browser`. All symbols without a ✓ touch `node:fs`,
`node:path`, `node:module`, or `process.*` and are Node-only.

| Export | Browser | Description |
|--------|:---:|-------------|
| `ScannedModule` | ✓ | Interface for scanned endpoint data |
| `createScannedModule()` | ✓ | Factory with defaults for optional fields |
| `cloneModule()` | ✓ | Defensive copy with optional overrides |
| `BaseScanner` | ✓ | Abstract base class for scanners |
| `YAMLWriter` | | Writes YAML binding files |
| `BindingLoader` | | Reads `.binding.yaml` files from disk and parses them back into `ScannedModule` objects. Subclass of `BindingParser`. |
| `BindingParser` | ✓ | Runtime-neutral half of `BindingLoader`. `loadData(data)` parses an already-loaded binding document into `ScannedModule[]` — no filesystem access. |
| `parseBindingDocument()` | ✓ | Standalone-function form of `BindingParser.loadData`, with an optional `filePath` for richer error messages. |
| `BindingLoadError` | ✓ | Error class raised when binding parsing fails; carries `filePath`, `moduleId`, `missingFields`, `reason` |
| `TypeScriptWriter` | | Generates TypeScript module wrappers |
| `RegistryWriter` | | Registers modules into an apcore Registry |
| `HTTPProxyRegistryWriter` | ✓ | Registers modules as HTTP-proxied entries in an in-memory registry. Each module's `execute()` forwards inputs to a backend URL via global `fetch`. Works in any runtime with `fetch` (Node 20+, browsers, edge, workers). |
| `HTTPProxyRegistryWriterError` | ✓ | Error class thrown when HTTP fields cannot be extracted from a `ScannedModule` |
| `getWriter()` | | Factory for writer instances |
| `assertAnnotationsPreserved()` | | Conformance check for adapter test suites: registers a module and asserts its behavioral annotations (`requiresApproval` / `destructive`) survive `getDefinition`; throws otherwise. Guards against a writer silently disabling approval/ACL gating |
| `extractInputSchema()` | ✓ | Extract input schema from OpenAPI operation |
| `extractOutputSchema()` | ✓ | Extract output schema from OpenAPI operation |
| `resolveRef()` | ✓ | Resolve `$ref` in OpenAPI documents |
| `resolveSchema()` | ✓ | Resolve schema with single-level `$ref` support |
| `deepResolveRefs()` | ✓ | Recursively resolve all nested `$ref` pointers in a schema |
| `enrichSchemaDescriptions()` | ✓ | Merge parameter descriptions into schema |
| `OpenAPIScanner` _(v0.11.0)_ | ✓ | Turn an OpenAPI 3.x document into `ScannedModule[]`. Pure and synchronous — no I/O. Every `moduleId` is in apcore's Canonical ID alphabet, including IDs from `basePathPrefix` and the hooks, and an ID apcore already accepts is never rewritten (FastAPI's `read_item_items__item_id__get` passes through); one still illegal (a digit-leading segment such as `v1.2fa.post`) is emitted with a warning naming the emitted ID |
| `OpenAPIScanOptions` _(v0.11.0)_ | ✓ | Options for `OpenAPIScanner.scan()` |
| `deriveModuleId()` _(v0.11.0)_ | ✓ | Derive a stable, byte-identical `moduleId` for an OpenAPI operation, in snake_case (`getUserById` → `get_user_by_id`, `GET /user-profiles/{userId}` → `user_profiles.user_id.get`); primary subject of the cross-SDK conformance corpus |
| `InvalidSpecError` _(v0.11.0)_ | ✓ | Thrown by `OpenAPIScanner.scan()` when the input isn't a recognisable OpenAPI 3.0.x/3.1.x document |
| `loadSpec()` _(v0.11.0)_ | | Fetch/parse an OpenAPI document from a local filesystem path or an `http(s)://` URL |
| `LoadSpecOptions` _(v0.11.0)_ | | Options for `loadSpec()` |
| `toMarkdown()` | ✓ | Convert dict to formatted Markdown |
| `formatCsv()` _(v0.7.0)_ | | Byte-equivalent RFC 4180 CSV. Header = union of keys; canonical JSON for nested cells; CRLF terminator |
| `formatJsonl()` _(v0.7.0)_ | | Byte-equivalent JSON Lines. Compact JSON per row, LF terminator |
| `TuiViewModel` _(v0.11.0)_ | ✓ | The V1 `TuiViewModel` wire-format envelope: columns, rows, sort/filter intent, tone palette |
| `modulesToViewModel()` _(v0.11.0)_ | ✓ | Build a byte-equivalent `TuiViewModel` from scanned modules |
| `formatViewModel()` _(v0.11.0)_ | ✓ | Canonical, byte-identical compact JSON encoding of a `TuiViewModel` |
| `Column` _(v0.11.0)_ | ✓ | A view-model column: render order and `Row.cells` index lookup |
| `Row` _(v0.11.0)_ | ✓ | A view-model row; `cells[i]` corresponds to `columns[i]` |
| `Cell` _(v0.11.0)_ | ✓ | A single table cell (discriminated union by `kind`) |
| `Sort` _(v0.11.0)_ | ✓ | Annotates which sort the toolkit (or the caller) applied |
| `Filter` _(v0.11.0)_ | ✓ | Annotates which filter the toolkit applied |
| `TonePalette` _(v0.11.0)_ | ✓ | A named, ordered set of `ToneRule` |
| `ToneRule` _(v0.11.0)_ | ✓ | First-match-wins rule mapping a tag to a semantic tone |
| `Group` _(v0.11.0)_ | ✓ | A named group of row indices, present only when `kind === "grouped"` |
| `moduleToDict()` | ✓ | Serialize module to snake_case dict |
| `modulesToDicts()` | ✓ | Batch serialize modules |
| `annotationsToDict()` | ✓ | Convert annotations to plain dict |
| `resolveTarget()` | | Dynamic import + named export resolution (supports `allowedPrefixes` allowlist) |
| `WriteResult` | ✓ | Structured result type for writer operations |
| `Verifier` | ✓ | Interface for pluggable output verification |
| `VerifyResult` | ✓ | Result type for verification operations |
| `WriteError` | ✓ | Error class for I/O failures during write |
| `InvalidFormatError` | ✓ | Error thrown by `getWriter` for unrecognised format names |
| `YAMLVerifier` | | Verifies YAML binding file structure (reads file) |
| `SyntaxVerifier` | | Verifies file is non-empty and parses as TypeScript (reads file) |
| `RegistryVerifier` | ✓ | Verifies module registered in a registry (pure; no filesystem) |
| `MagicBytesVerifier` | | Verifies file header matches expected bytes (reads file) |
| `JSONVerifier` | | Verifies valid JSON, optional schema check (reads file) |
| `createWriteResult()` | ✓ | Factory for WriteResult with defaults |
| `runVerifierChain()` | ✓ | Run verifier chain, short-circuit on first failure |
| `Enhancer` | | Pluggable interface for metadata enhancement |
| `AIEnhancer` | | SLM-based metadata enhancement for scanned modules |
| `DisplayResolver` | | Sparse binding.yaml overlay — resolves alias, description, guidance, tags into `metadata["display"]` |
| `VERSION` | | Package version string |

## Documentation

See the [apcore-toolkit documentation](https://github.com/aiperceivable/apcore-toolkit) for full API reference and guides.

## License

Apache-2.0
