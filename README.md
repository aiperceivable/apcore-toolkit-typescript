<div align="center">
  <img src="https://raw.githubusercontent.com/aipartnerup/apcore-toolkit/main/apcore-toolkit-logo.svg" alt="apcore-toolkit logo" width="200"/>
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
- Multi-format output writers (YAML, TypeScript, Registry) with pluggable verification
- Markdown formatting with depth control and table heuristics
- Module serialization utilities
- `flattenParams` for Zod-based parameter flattening

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
const writer = getWriter('yaml'); // 'yaml' | 'typescript' | 'registry'
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

### Serializers

```typescript
import { moduleToDict, modulesToDicts, annotationsToDict } from 'apcore-toolkit';

const dict = moduleToDict(mod);       // snake_case keys
const dicts = modulesToDicts(modules); // batch conversion
```

## API

| Export | Description |
|--------|-------------|
| `ScannedModule` | Interface for scanned endpoint data |
| `createScannedModule()` | Factory with defaults for optional fields |
| `cloneModule()` | Defensive copy with optional overrides |
| `BaseScanner` | Abstract base class for scanners |
| `YAMLWriter` | Writes YAML binding files |
| `TypeScriptWriter` | Generates TypeScript module wrappers |
| `RegistryWriter` | Registers modules into an apcore Registry |
| `getWriter()` | Factory for writer instances |
| `extractInputSchema()` | Extract input schema from OpenAPI operation |
| `extractOutputSchema()` | Extract output schema from OpenAPI operation |
| `resolveRef()` | Resolve `$ref` in OpenAPI documents |
| `resolveSchema()` | Resolve schema with `$ref` support |
| `enrichSchemaDescriptions()` | Merge parameter descriptions into schema |
| `toMarkdown()` | Convert dict to formatted Markdown |
| `moduleToDict()` | Serialize module to snake_case dict |
| `modulesToDicts()` | Batch serialize modules |
| `annotationsToDict()` | Convert annotations to plain dict |
| `resolveTarget()` | Dynamic import + named export resolution |
| `flattenParams()` | Flatten Zod schema params into keyword args |
| `WriteResult` | Structured result type for writer operations |
| `Verifier` | Interface for pluggable output verification |
| `VerifyResult` | Result type for verification operations |
| `WriteError` | Error class for I/O failures during write |
| `YAMLVerifier` | Verifies YAML binding file structure |
| `SyntaxVerifier` | Verifies file is non-empty and readable |
| `RegistryVerifier` | Verifies module registered in registry |
| `MagicBytesVerifier` | Verifies file header matches expected bytes |
| `JSONVerifier` | Verifies valid JSON, optional schema check |
| `createWriteResult()` | Factory for WriteResult with defaults |
| `runVerifierChain()` | Run verifier chain, short-circuit on first failure |
| `AIEnhancer` | SLM-based metadata enhancement for scanned modules |
| `VERSION` | Package version string |

## Documentation

See the [apcore-toolkit documentation](https://github.com/aipartnerup/apcore-toolkit) for full API reference and guides.

## License

Apache-2.0
