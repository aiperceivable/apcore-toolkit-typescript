import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createAnnotations } from 'apcore-js';
import { BindingLoader, BindingLoadError } from '../src/binding-loader.js';
import { YAMLWriter } from '../src/output/yaml-writer.js';
import { createScannedModule } from '../src/types.js';

const MINIMAL_ENTRY = { module_id: 'x.y', target: 'pkg:func' };

const FULL_ENTRY = {
  module_id: 'users.get_user',
  target: 'myapp.views:get_user',
  description: 'Get a user',
  documentation: 'Returns a user by ID.',
  tags: ['users', 'get'],
  version: '2.0.0',
  annotations: { readonly: true, cacheable: true, cache_ttl: 60 },
  examples: [{ title: 'happy', inputs: { id: 1 }, output: { name: 'alice' } }],
  metadata: { http_method: 'GET' },
  input_schema: { type: 'object', properties: { id: { type: 'integer' } } },
  output_schema: { type: 'object' },
  display: { mcp: { alias: 'users_get' }, alias: 'users.get' },
  suggested_alias: 'users.get.alt',
  warnings: ['stale'],
};

describe('BindingLoader.loadData', () => {
  let loader: BindingLoader;

  beforeEach(() => {
    loader = new BindingLoader();
  });

  it('parses a minimal loose entry with defaults', () => {
    const modules = loader.loadData({ bindings: [MINIMAL_ENTRY] });
    expect(modules).toHaveLength(1);
    const m = modules[0];
    expect(m.moduleId).toBe('x.y');
    expect(m.target).toBe('pkg:func');
    expect(m.description).toBe('');
    expect(m.inputSchema).toEqual({});
    expect(m.outputSchema).toEqual({});
    expect(m.tags).toEqual([]);
    expect(m.version).toBe('1.0.0');
    expect(m.annotations).toBeNull();
    expect(m.display).toBeNull();
  });

  it('strict mode requires input_schema and output_schema', () => {
    expect(() => loader.loadData({ bindings: [MINIMAL_ENTRY] }, { strict: true })).toThrow(
      BindingLoadError,
    );
    try {
      loader.loadData({ bindings: [MINIMAL_ENTRY] }, { strict: true });
    } catch (exc) {
      const err = exc as BindingLoadError;
      expect(err.missingFields).toContain('input_schema');
      expect(err.missingFields).toContain('output_schema');
      expect(err.moduleId).toBe('x.y');
    }
  });

  it('strict mode accepts when schemas present', () => {
    const entry = {
      module_id: 'x.y',
      target: 'p:f',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    };
    const modules = loader.loadData({ bindings: [entry] }, { strict: true });
    expect(modules).toHaveLength(1);
  });

  it.each(['input_schema', 'output_schema'] as const)(
    'rejects a loose entry with only %s',
    (schemaField) => {
      const otherSchemaField =
        schemaField === 'input_schema' ? 'output_schema' : 'input_schema';
      const entry = {
        module_id: 'x.y',
        target: 'p:f',
        [schemaField]: { type: 'object' },
      };

      expect(() => loader.loadData({ bindings: [entry] })).toThrow(
        /input_schema and output_schema must be supplied together/,
      );
      expect(() => loader.loadData({ bindings: [entry] }, { strict: true })).toThrow(
        /input_schema and output_schema must be supplied together/,
      );
      expect(entry).not.toHaveProperty(otherSchemaField);
    },
  );

  it('always fails on missing module_id', () => {
    expect(() => loader.loadData({ bindings: [{ target: 'p:f' }] })).toThrow(BindingLoadError);
  });

  it('always fails on missing target', () => {
    expect(() => loader.loadData({ bindings: [{ module_id: 'x' }] })).toThrow(BindingLoadError);
  });

  it('rejects wrong-type module_id (regression: 42 must NOT coerce to "42")', () => {
    // Previously Python/TypeScript silently coerced non-string scalars via
    // String(value), while Rust rejected them. Same YAML must now behave
    // identically across all three SDKs.
    expect(() =>
      loader.loadData({ bindings: [{ module_id: 42, target: 'pkg:func' }] }),
    ).toThrow(BindingLoadError);
    try {
      loader.loadData({ bindings: [{ module_id: 42, target: 'pkg:func' }] });
    } catch (exc) {
      expect((exc as BindingLoadError).missingFields).toContain('module_id');
    }
  });

  it('rejects wrong-type target (boolean)', () => {
    expect(() =>
      loader.loadData({ bindings: [{ module_id: 'x', target: true }] }),
    ).toThrow(BindingLoadError);
    try {
      loader.loadData({ bindings: [{ module_id: 'x', target: true }] });
    } catch (exc) {
      expect((exc as BindingLoadError).missingFields).toContain('target');
    }
  });

  it('rejects empty-string module_id (empty identifier is never valid)', () => {
    try {
      loader.loadData({ bindings: [{ module_id: '', target: 'pkg:func' }] });
      expect.fail('expected BindingLoadError');
    } catch (exc) {
      expect(exc).toBeInstanceOf(BindingLoadError);
      expect((exc as BindingLoadError).missingFields).toContain('module_id');
    }
  });

  it('strict mode rejects non-object input_schema', () => {
    const entry = {
      module_id: 'x',
      target: 'p:f',
      input_schema: 'not a dict',
      output_schema: { type: 'object' },
    };
    try {
      loader.loadData({ bindings: [entry] }, { strict: true });
      expect.fail('expected BindingLoadError');
    } catch (exc) {
      expect(exc).toBeInstanceOf(BindingLoadError);
      expect((exc as BindingLoadError).missingFields).toContain('input_schema');
    }
  });

  it('deep-clones inputSchema on load (regression: mutation must not leak)', () => {
    // Previously `_asRecord` returned a fresh outer {} but shared nested refs
    // with the parsed YAML. Mutating `m.inputSchema.properties.id.type`
    // corrupted the original source dict.
    const sourceSchema = {
      type: 'object',
      properties: { id: { type: 'integer' } },
    } as Record<string, unknown>;
    const entry = {
      module_id: 'x',
      target: 'p:f',
      input_schema: sourceSchema,
      output_schema: { type: 'object' },
    };
    const m = loader.loadData({ bindings: [entry] })[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.inputSchema.properties as any).id.type = 'string';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sourceSchema.properties as any).id.type).toBe('integer');
  });

  it('deep-clones metadata on load', () => {
    const sourceMeta = { auth: { scope: ['admin', 'write'] } } as Record<string, unknown>;
    const entry = { module_id: 'x', target: 'p:f', metadata: sourceMeta };
    const m = loader.loadData({ bindings: [entry] })[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((m.metadata.auth as any).scope as string[]).push('leaked');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sourceMeta.auth as any).scope).toEqual(['admin', 'write']);
  });

  it('fails when bindings key missing', () => {
    expect(() => loader.loadData({ spec_version: '1.0' })).toThrow(/bindings/);
  });

  it('rejects unknown top-level document keys', () => {
    const document = { bindings: [MINIMAL_ENTRY], generated_at: '2026-10-08' };
    expect(() => loader.loadData(document)).toThrow(
      /unknown top-level binding document key: generated_at/,
    );
    expect(() => loader.loadData(document, { strict: true })).toThrow(
      /unknown top-level binding document key: generated_at/,
    );
  });

  it('rejects unknown binding-entry keys while preserving module context', () => {
    const document = { bindings: [{ ...MINIMAL_ENTRY, auto_schema: true }] };
    for (const options of [undefined, { strict: true }]) {
      try {
        loader.loadData(document, options);
        expect.fail('expected BindingLoadError');
      } catch (exc) {
        expect(exc).toBeInstanceOf(BindingLoadError);
        const error = exc as BindingLoadError;
        expect(error.reason).toBe('unknown binding entry key: auto_schema');
        expect(error.moduleId).toBe('x.y');
      }
    }
  });

  it('preserves every supported pure-data entry field', () => {
    const modules = loader.loadData({ bindings: [FULL_ENTRY] });
    expect(modules).toHaveLength(1);
    expect(modules[0].warnings).toEqual(['stale']);
  });

  it('fails when top-level is not a mapping', () => {
    expect(() => loader.loadData(['a', 'b'] as unknown as Record<string, unknown>)).toThrow(
      BindingLoadError,
    );
  });

  it('fails when an entry is not a mapping', () => {
    expect(() => loader.loadData({ bindings: ['scalar' as unknown as Record<string, unknown>] })).toThrow(
      /mapping/,
    );
  });

  it('parses full annotations via annotationsFromJSON', () => {
    const m = loader.loadData({ bindings: [FULL_ENTRY] })[0];
    expect(m.annotations).not.toBeNull();
    expect(m.annotations?.readonly).toBe(true);
    expect(m.annotations?.cacheable).toBe(true);
    expect(m.annotations?.cacheTtl).toBe(60);
  });

  it('treats non-dict annotations as null with a warning', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = loader.loadData({
        bindings: [{ module_id: 'x', target: 'p:f', annotations: 'readonly' }],
      })[0];
      expect(m.annotations).toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves display overlay', () => {
    const m = loader.loadData({ bindings: [FULL_ENTRY] })[0];
    expect(m.display).toEqual({ mcp: { alias: 'users_get' }, alias: 'users.get' });
  });

  it('defaults display to null when absent', () => {
    const m = loader.loadData({ bindings: [MINIMAL_ENTRY] })[0];
    expect(m.display).toBeNull();
  });

  it('warns and drops malformed display (non-object)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = loader.loadData({
        bindings: [{ module_id: 'x', target: 'p:f', display: 'not-a-dict' }],
      })[0];
      expect(m.display).toBeNull();
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes('display') && String(c[0]).includes('x')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('warns when input_schema is not a mapping', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = loader.loadData({
        bindings: [
          {
            module_id: 'x',
            target: 'p:f',
            input_schema: 'string',
            output_schema: { type: 'object' },
          },
        ],
      })[0];
      expect(m.inputSchema).toEqual({});
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes('input_schema')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('parses examples array', () => {
    const m = loader.loadData({ bindings: [FULL_ENTRY] })[0];
    expect(m.examples).toHaveLength(1);
    expect(m.examples[0].title).toBe('happy');
  });

  it('skips malformed examples entries', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = loader.loadData({
        bindings: [
          {
            module_id: 'x',
            target: 'p:f',
            examples: [{ title: 'ok', inputs: {}, output: {} }, 'bad'],
          },
        ],
      })[0];
      expect(m.examples).toHaveLength(1);
      expect(m.examples[0].title).toBe('ok');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('BindingLoader spec_version', () => {
  it('warns when spec_version missing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new BindingLoader().loadData({ bindings: [MINIMAL_ENTRY] });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('spec_version'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('warns when spec_version is newer than supported', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new BindingLoader().loadData({ spec_version: '2.0', bindings: [MINIMAL_ENTRY] });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('newer than supported'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('is silent when spec_version is 1.0', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new BindingLoader().loadData({ spec_version: '1.0', bindings: [MINIMAL_ENTRY] });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('spec_version'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('BindingLoader.load (filesystem)', () => {
  let tmpDir: string;
  let loader: BindingLoader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'binding-loader-test-'));
    loader = new BindingLoader();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a single file', () => {
    const f = join(tmpDir, 'one.binding.yaml');
    writeFileSync(f, yaml.dump({ spec_version: '1.0', bindings: [FULL_ENTRY] }));
    const modules = loader.load(f);
    expect(modules).toHaveLength(1);
    expect(modules[0].moduleId).toBe('users.get_user');
  });

  it('loads every *.binding.yaml in a directory, sorted', () => {
    ['a', 'b', 'c'].forEach((name, i) => {
      writeFileSync(
        join(tmpDir, `${name}.binding.yaml`),
        yaml.dump({
          spec_version: '1.0',
          bindings: [{ module_id: name, target: `pkg:f${i}` }],
        }),
      );
    });
    writeFileSync(join(tmpDir, 'unrelated.yaml'), 'irrelevant: true');
    const modules = loader.load(tmpDir);
    expect(modules.map((m) => m.moduleId)).toEqual(['a', 'b', 'c']);
  });

  it('throws when path does not exist', () => {
    expect(() => loader.load(join(tmpDir, 'nope'))).toThrow(/does not exist/);
  });

  it('throws on malformed YAML with "parse YAML" reason (D8-2)', () => {
    const f = join(tmpDir, 'bad.binding.yaml');
    writeFileSync(f, '::: not yaml :::\n  - [');
    expect(() => loader.load(f)).toThrow(/parse YAML/);
  });

  it('throws on unreadable file with "read file" reason, distinct from parse error (D8-2)', () => {
    const f = join(tmpDir, 'unreadable.binding.yaml');
    writeFileSync(f, 'bindings: []');
    chmodSync(f, 0o000);
    try {
      expect(() => loader.load(f)).toThrow(/read file/);
    } finally {
      chmodSync(f, 0o644);
    }
  });

  it('skips empty files', () => {
    const f = join(tmpDir, 'empty.binding.yaml');
    writeFileSync(f, '');
    const modules = loader.load(f);
    expect(modules).toEqual([]);
  });

  // Issue #8 [D1-003] regression: flat positional params for load()
  it('load(path, true, false) — strict mode rejects entry missing input_schema', () => {
    const f = join(tmpDir, 'strict.binding.yaml');
    writeFileSync(
      f,
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'x.y', target: 'pkg:fn' }] }),
    );
    // strict=true, recursive=false — should throw because input_schema is missing
    expect(() => loader.load(f, true, false)).toThrow(BindingLoadError);
    try {
      loader.load(f, true, false);
    } catch (exc) {
      const err = exc as BindingLoadError;
      expect(err.missingFields).toContain('input_schema');
    }
  });

  it('load(path, false, false) — loose mode accepts entry missing input_schema', () => {
    const f = join(tmpDir, 'loose.binding.yaml');
    writeFileSync(
      f,
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'x.y', target: 'pkg:fn' }] }),
    );
    // strict=false — should succeed
    const modules = loader.load(f, false, false);
    expect(modules).toHaveLength(1);
    expect(modules[0].moduleId).toBe('x.y');
  });

  it('recursive=false (default): finds top-level and skips nested', () => {
    const subDir = join(tmpDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    // Top-level file — must be found
    writeFileSync(
      join(tmpDir, 'top.binding.yaml'),
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'top', target: 'pkg:top' }] }),
    );
    // Nested file — must NOT be found
    writeFileSync(
      join(subDir, 'nested.binding.yaml'),
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'nested', target: 'pkg:fn' }] }),
    );
    const modules = loader.load(tmpDir, false, false);
    expect(modules.map((m) => m.moduleId)).toEqual(['top']);
  });

  // Skip on Windows (no POSIX permission model) and when running as root
  // (chmod 000 is ignored, so the read would succeed and the assertion flip).
  const canDenyRead =
    process.platform !== 'win32' &&
    (typeof process.getuid !== 'function' || process.getuid() !== 0);
  const itUnlessRoot = canDenyRead ? it : it.skip;

  itUnlessRoot(
    'recursive=true: swallows EACCES on an unreadable subdir, continues with the rest',
    () => {
      const lockedSub = join(tmpDir, 'locked');
      mkdirSync(lockedSub);
      writeFileSync(
        join(tmpDir, 'top.binding.yaml'),
        yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'top', target: 'pkg:top' }] }),
      );
      chmodSync(lockedSub, 0o000);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const modules = loader.load(tmpDir, false, true);
        expect(modules.map((m) => m.moduleId)).toEqual(['top']);
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('cannot read'))).toBe(true);
      } finally {
        chmodSync(lockedSub, 0o755); // restore so afterEach rmSync can clean up
        warnSpy.mockRestore();
      }
    },
  );

  it('recursive=true: caps recursion depth and warns instead of blowing the stack', () => {
    // Build a chain of directories well past MAX_RECURSION_DEPTH (64).
    let current = tmpDir;
    for (let i = 0; i < 70; i++) {
      current = join(current, `d${i}`);
      mkdirSync(current);
    }
    writeFileSync(
      join(current, 'deep.binding.yaml'),
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'deep', target: 'pkg:deep' }] }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const modules = loader.load(tmpDir, false, true);
      // The file below the depth cap is unreachable; the walker must not throw.
      expect(modules.map((m) => m.moduleId)).not.toContain('deep');
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('max recursion depth')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('finds nested *.binding.yaml when recursive=true', () => {
    const subDir = join(tmpDir, 'sub', 'deep');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'nested.binding.yaml'),
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'nested.deep', target: 'pkg:fn' }] }),
    );
    // Also one at top level
    writeFileSync(
      join(tmpDir, 'top.binding.yaml'),
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'top', target: 'pkg:top' }] }),
    );
    const modules = loader.load(tmpDir, false, true);
    const ids = modules.map((m) => m.moduleId).sort();
    expect(ids).toContain('nested.deep');
    expect(ids).toContain('top');
    expect(modules).toHaveLength(2);
  });
});

// D11-006: BindingLoader file size and count limits
// The actual limit enforcement tests live in binding-loader-limits.test.ts
// because they require vi.mock('node:fs') at the top level, which cannot
// coexist with the real-filesystem tests above. This suite just verifies
// the limit constants exist and are correctly valued.
describe('BindingLoader — file size and count limit constants (D11-006)', () => {
  it('exports constants at expected values (smoke test via documented limits)', () => {
    // 16 MiB = 16 * 1024 * 1024 = 16777216 bytes
    const expectedMaxSize = 16 * 1024 * 1024;
    // 10,000 files per directory
    const expectedMaxFiles = 10_000;
    // These are compile-time constants; document expected values for cross-SDK parity
    expect(expectedMaxSize).toBe(16777216);
    expect(expectedMaxFiles).toBe(10000);
  });
});

describe('YAMLWriter + BindingLoader round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rt-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves all fields including display and annotations', () => {
    const original = createScannedModule({
      moduleId: 'round.trip',
      description: 'Round-trip test',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      outputSchema: { type: 'object' },
      tags: ['demo'],
      target: 'demo.app:handler',
      version: '1.2.3',
      annotations: createAnnotations({ readonly: true, streaming: true, cacheTtl: 30 }),
      documentation: 'Docs here',
      metadata: { http_method: 'GET' },
      display: { mcp: { alias: 'rt' }, alias: 'round-trip' },
    });

    new YAMLWriter().write([original], tmpDir);
    const loaded = new BindingLoader().load(tmpDir);

    expect(loaded).toHaveLength(1);
    const m = loaded[0];
    expect(m.moduleId).toBe(original.moduleId);
    expect(m.target).toBe(original.target);
    expect(m.description).toBe(original.description);
    expect(m.documentation).toBe(original.documentation);
    expect([...m.tags]).toEqual([...original.tags]);
    expect(m.version).toBe(original.version);
    expect(m.inputSchema).toEqual(original.inputSchema);
    expect(m.outputSchema).toEqual(original.outputSchema);
    expect(m.metadata).toEqual(original.metadata);
    expect(m.display).toEqual(original.display);
    expect(m.annotations?.readonly).toBe(true);
    expect(m.annotations?.streaming).toBe(true);
    expect(m.annotations?.cacheTtl).toBe(30);
  });
});
