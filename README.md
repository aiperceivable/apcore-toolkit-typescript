# apcore-toolkit

Shared scanner, schema extraction, and output toolkit for apcore framework adapters (TypeScript).

## Install

```bash
npm install apcore-toolkit
```

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
| `VERSION` | Package version string |

## License

Apache-2.0
