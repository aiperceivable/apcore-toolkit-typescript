import { describe, it, expect } from 'vitest';
import { getWriter } from '../src/output/factory.js';
import { YAMLWriter } from '../src/output/yaml-writer.js';
import { TypeScriptWriter } from '../src/output/typescript-writer.js';
import { RegistryWriter } from '../src/output/registry-writer.js';

describe('getWriter', () => {
  it('returns YAMLWriter for "yaml"', () => {
    expect(getWriter('yaml')).toBeInstanceOf(YAMLWriter);
  });

  it('returns TypeScriptWriter for "typescript"', () => {
    expect(getWriter('typescript')).toBeInstanceOf(TypeScriptWriter);
  });

  it('returns RegistryWriter for "registry"', () => {
    expect(getWriter('registry')).toBeInstanceOf(RegistryWriter);
  });

  it('throws for unknown format', () => {
    expect(() => getWriter('unknown')).toThrow('Unknown output format: "unknown"');
  });

  it('throws for empty string', () => {
    expect(() => getWriter('')).toThrow('Unknown output format');
  });
});
