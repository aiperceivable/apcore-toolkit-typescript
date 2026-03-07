import { describe, it, expect, vi } from 'vitest';
import { annotationsToDict, moduleToDict, modulesToDicts } from '../src/serializers.js';
import { createScannedModule } from '../src/types.js';

const REQUIRED_FIELDS = {
  moduleId: 'test-module',
  description: 'A test module',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  tags: ['test', 'example'],
  target: 'http://localhost:8080/api/test',
} as const;

describe('annotationsToDict', () => {
  it('returns null for null', () => {
    expect(annotationsToDict(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(annotationsToDict(undefined)).toBeNull();
  });

  it('returns the object as-is for a plain object', () => {
    const annotations = { readOnly: true, destructive: false, idempotent: true };
    const result = annotationsToDict(annotations);
    expect(result).toEqual({ readOnly: true, destructive: false, idempotent: true });
  });

  it('logs warning and returns null for unrecognized types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(annotationsToDict('invalid')).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Unrecognised annotations type');

    warnSpy.mockRestore();
  });

  it('logs warning and returns null for a number', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(annotationsToDict(42)).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('logs warning and returns null for an array', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(annotationsToDict([1, 2, 3])).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });
});

describe('moduleToDict', () => {
  it('serializes all 12 fields with correct snake_case keys', () => {
    const mod = createScannedModule({
      ...REQUIRED_FIELDS,
      version: '2.0.0',
      annotations: { readOnly: true },
      documentation: 'Some docs',
      examples: [{ name: 'ex1', input: {}, output: {} }],
      metadata: { author: 'test' },
      warnings: ['warn1'],
    });

    const result = moduleToDict(mod);

    expect(result).toEqual({
      module_id: 'test-module',
      description: 'A test module',
      input_schema: { type: 'object' },
      output_schema: { type: 'string' },
      tags: ['test', 'example'],
      target: 'http://localhost:8080/api/test',
      version: '2.0.0',
      annotations: { readOnly: true },
      documentation: 'Some docs',
      examples: [{ name: 'ex1', input: {}, output: {} }],
      metadata: { author: 'test' },
      warnings: ['warn1'],
    });
  });

  it('outputs null annotations when module has null annotations', () => {
    const mod = createScannedModule({ ...REQUIRED_FIELDS });
    const result = moduleToDict(mod);

    expect(result.annotations).toBeNull();
  });

  it('outputs empty array for examples when module has no examples', () => {
    const mod = createScannedModule({ ...REQUIRED_FIELDS });
    const result = moduleToDict(mod);

    expect(result.examples).toEqual([]);
  });

  it('has exactly 12 keys', () => {
    const mod = createScannedModule({ ...REQUIRED_FIELDS });
    const result = moduleToDict(mod);

    expect(Object.keys(result)).toHaveLength(12);
  });
});

describe('modulesToDicts', () => {
  it('converts multiple modules to an array of dicts', () => {
    const mod1 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod-1' });
    const mod2 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod-2' });

    const results = modulesToDicts([mod1, mod2]);

    expect(results).toHaveLength(2);
    expect(results[0].module_id).toBe('mod-1');
    expect(results[1].module_id).toBe('mod-2');
  });

  it('returns empty array for empty input', () => {
    expect(modulesToDicts([])).toEqual([]);
  });
});
