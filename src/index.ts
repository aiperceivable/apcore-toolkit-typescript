export type { ScannedModule } from './types.js';
export { createScannedModule, cloneModule } from './types.js';
export { BaseScanner } from './scanner.js';
export { enrichSchemaDescriptions } from './schema-utils.js';
export {
  resolveRef,
  resolveSchema,
  extractInputSchema,
  extractOutputSchema,
} from './openapi.js';
export {
  annotationsToDict,
  moduleToDict,
  modulesToDicts,
} from './serializers.js';
export { resolveTarget } from './resolve-target.js';
export { toMarkdown } from './formatting/index.js';
export { YAMLWriter } from './output/yaml-writer.js';
export { TypeScriptWriter } from './output/typescript-writer.js';
export { RegistryWriter } from './output/registry-writer.js';
export { getWriter } from './output/factory.js';

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json') as { version: string };
export const VERSION: string = _pkg.version;
