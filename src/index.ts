export type { ScannedModule } from './types.js';
export { createScannedModule, cloneModule } from './types.js';
export { BaseScanner } from './scanner.js';
export { enrichSchemaDescriptions } from './schema-utils.js';
export {
  resolveRef,
  resolveSchema,
  deepResolveRefs,
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
export { flattenParams } from './flatten-params.js';
export { AIEnhancer } from './ai-enhancer.js';
export type { AIEnhancerOptions, Enhancer } from './ai-enhancer.js';
export { YAMLWriter } from './output/yaml-writer.js';
export { TypeScriptWriter } from './output/typescript-writer.js';
export { RegistryWriter } from './output/registry-writer.js';
export { getWriter } from './output/factory.js';
export type { WriteResult, VerifyResult, Verifier } from './output/types.js';
export { createWriteResult } from './output/types.js';
export { WriteError } from './output/errors.js';
export {
  YAMLVerifier,
  SyntaxVerifier,
  RegistryVerifier,
  MagicBytesVerifier,
  JSONVerifier,
  runVerifierChain,
} from './output/verifiers.js';

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json') as { version: string };
export const VERSION: string = _pkg.version;
