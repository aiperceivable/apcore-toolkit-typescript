import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypeScriptWriter } from '../src/output/typescript-writer.js';
import { createScannedModule } from '../src/types.js';
import type { ScannedModule } from '../src/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

function makeModule(overrides: Partial<Parameters<typeof createScannedModule>[0]> = {}): ScannedModule {
  return createScannedModule({
    moduleId: 'users.get_user',
    description: 'Get a user by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    tags: ['users'],
    target: 'myapp/users:get_user',
    version: '1.0.0',
    annotations: { readOnly: true },
    ...overrides,
  });
}

describe('TypeScriptWriter', () => {
  let writer: TypeScriptWriter;

  beforeEach(() => {
    writer = new TypeScriptWriter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dry run returns generated code strings without writing files', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out', { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("module(");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('generates valid TypeScript code structure with module() call', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).toContain("export default module({");
    expect(code).toContain("async execute(inputs)");
    expect(code).toContain("});");
  });

  it('code includes correct import statement', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).toContain("import { module } from 'apcore-js';");
  });

  it('code contains proper id, description, tags, version', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).toContain('id: "users.get_user"');
    expect(code).toContain('description: "Get a user by ID"');
    expect(code).toContain('tags: ["users"]');
    expect(code).toContain('version: "1.0.0"');
  });

  it('handles target parsing — splits "myapp/users:get_user" to import path and export name', () => {
    const mod = makeModule({ target: 'myapp/users:get_user' });
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).toContain('const { get_user: _original } = await import("myapp/users")');
    expect(code).toContain("return _original(inputs)");
  });

  it('sanitizes identifiers ("weird.id-test" -> "weird_id_test")', () => {
    const mod = makeModule({ moduleId: 'weird.id-test', target: 'myapp/views:createUser' });
    const results = writer.write([mod], '/tmp/out', { dryRun: true });

    // The filename should use the sanitized identifier
    // We check by writing (non-dry-run) and verifying the path
    writer.write([mod], '/tmp/out');
    const writtenPath = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(path.basename(writtenPath)).toBe('weird_id_test.ts');
  });

  it('throws for invalid target without ":"', () => {
    const mod = makeModule({ target: 'invalid_target_no_colon' });
    expect(() => writer.write([mod], '/tmp/out', { dryRun: true })).toThrow(
      'Invalid target format: invalid_target_no_colon',
    );
  });

  it('throws for invalid export name (non-identifier)', () => {
    const mod = makeModule({ target: 'myapp/users:default-export' });
    expect(() => writer.write([mod], '/tmp/out', { dryRun: true })).toThrow(
      'Invalid export name: default-export',
    );
  });

  it('empty modules returns empty array', () => {
    const results = writer.write([], '/tmp/out', { dryRun: true });
    expect(results).toEqual([]);
  });

  it('annotations=null -> annotations line omitted from output', () => {
    const mod = makeModule({ annotations: null });
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).not.toContain('annotations');
  });

  it('annotations present -> annotations serialized inline', () => {
    const mod = makeModule({ annotations: { readOnly: true } });
    const results = writer.write([mod], '/tmp/out', { dryRun: true });
    const code = results[0];

    expect(code).toContain('annotations:');
    expect(code).toContain(JSON.stringify({ readOnly: true }));
  });

  it('writes files to outputDir with correct structure', () => {
    const mod = makeModule();
    writer.write([mod], '/tmp/out');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/out', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledOnce();

    const writtenPath = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenPath).toBe(path.join('/tmp/out', 'users_get_user.ts'));
  });

  it('prevents path traversal in module id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = makeModule({ moduleId: '../../../etc/passwd' });
    writer.write([mod], '/tmp/out');
    // File should not be written — path traversal detected and skipped
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
