import { YAMLWriter } from './yaml-writer.js';
import { TypeScriptWriter } from './typescript-writer.js';
import { RegistryWriter } from './registry-writer.js';

export function getWriter(
  format: string,
): YAMLWriter | TypeScriptWriter | RegistryWriter {
  if (format === 'yaml') return new YAMLWriter();
  if (format === 'typescript') return new TypeScriptWriter();
  if (format === 'registry') return new RegistryWriter();
  throw new Error(`Unknown output format: "${format}"`);
}
