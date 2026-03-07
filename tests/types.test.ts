import { describe, it, expect } from 'vitest';
import { createScannedModule, cloneModule } from '../src/types.js';
import type { ScannedModule } from '../src/types.js';

const REQUIRED_FIELDS = {
  moduleId: 'test-module',
  description: 'A test module',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  tags: ['test', 'example'],
  target: 'http://localhost:8080/api/test',
} as const;

describe('createScannedModule', () => {
  it('returns correct defaults for optional fields', () => {
    const mod = createScannedModule({ ...REQUIRED_FIELDS });

    // Required fields preserved
    expect(mod.moduleId).toBe('test-module');
    expect(mod.description).toBe('A test module');
    expect(mod.inputSchema).toEqual({ type: 'object' });
    expect(mod.outputSchema).toEqual({ type: 'string' });
    expect(mod.tags).toEqual(['test', 'example']);
    expect(mod.target).toBe('http://localhost:8080/api/test');

    // Defaults
    expect(mod.version).toBe('1.0.0');
    expect(mod.annotations).toBeNull();
    expect(mod.documentation).toBeNull();
    expect(mod.examples).toEqual([]);
    expect(mod.metadata).toEqual({});
    expect(mod.warnings).toEqual([]);
  });

  it('preserves optional overrides', () => {
    const annotations = {
      readonly: true,
      destructive: false,
      idempotent: true,
      requiresApproval: false,
      openWorld: false,
      streaming: false,
    };
    const examples = [
      { title: 'ex1', inputs: { a: 1 }, output: { b: 2 } },
    ];

    const mod = createScannedModule({
      ...REQUIRED_FIELDS,
      version: '2.0.0',
      annotations,
      documentation: 'Some docs',
      examples,
      metadata: { key: 'value' },
      warnings: ['deprecation warning'],
    });

    expect(mod.version).toBe('2.0.0');
    expect(mod.annotations).toEqual(annotations);
    expect(mod.documentation).toBe('Some docs');
    expect(mod.examples).toEqual(examples);
    expect(mod.metadata).toEqual({ key: 'value' });
    expect(mod.warnings).toEqual(['deprecation warning']);
  });

  it('creates independent arrays/objects per instance (mutable default independence)', () => {
    const mod1 = createScannedModule({ ...REQUIRED_FIELDS });
    const mod2 = createScannedModule({ ...REQUIRED_FIELDS });

    // They should be equal in value
    expect(mod1.examples).toEqual(mod2.examples);
    expect(mod1.metadata).toEqual(mod2.metadata);
    expect(mod1.warnings).toEqual(mod2.warnings);

    // But not the same reference
    expect(mod1.examples).not.toBe(mod2.examples);
    expect(mod1.metadata).not.toBe(mod2.metadata);
    expect(mod1.warnings).not.toBe(mod2.warnings);
    expect(mod1.tags).not.toBe(mod2.tags);
  });
});

describe('cloneModule', () => {
  it('returns a new object with overrides applied', () => {
    const original = createScannedModule({ ...REQUIRED_FIELDS });
    const cloned = cloneModule(original, {
      moduleId: 'cloned-module',
      version: '3.0.0',
      documentation: 'Cloned docs',
    });

    // Overrides applied
    expect(cloned.moduleId).toBe('cloned-module');
    expect(cloned.version).toBe('3.0.0');
    expect(cloned.documentation).toBe('Cloned docs');

    // Non-overridden fields preserved
    expect(cloned.description).toBe(original.description);
    expect(cloned.target).toBe(original.target);
    expect(cloned.tags).toEqual(original.tags);

    // Different object identity
    expect(cloned).not.toBe(original);

    // Original unchanged
    expect(original.moduleId).toBe('test-module');
    expect(original.version).toBe('1.0.0');
    expect(original.documentation).toBeNull();
  });

  it('returns an exact copy when no overrides are provided', () => {
    const original = createScannedModule({
      ...REQUIRED_FIELDS,
      version: '2.0.0',
      warnings: ['w1'],
    });
    const cloned = cloneModule(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it('defensively copies overridden arrays and objects', () => {
    const original = createScannedModule({ ...REQUIRED_FIELDS });
    const overrideTags = ['new-tag'];
    const overrideWarnings = ['new-warning'];

    const cloned = cloneModule(original, {
      tags: overrideTags,
      warnings: overrideWarnings,
    });

    // Values match
    expect(cloned.tags).toEqual(['new-tag']);
    expect(cloned.warnings).toEqual(['new-warning']);

    // But NOT the same reference (defensive copy applied after override)
    expect(cloned.tags).not.toBe(overrideTags);
    expect(cloned.warnings).not.toBe(overrideWarnings);
  });
});
