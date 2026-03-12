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
    readFileSync: vi.fn().mockReturnValue(''),
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

  it('dry run returns WriteResult without writing files', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out', { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].moduleId).toBe('users.get_user');
    expect(results[0].path).toBeNull();
    expect(results[0].verified).toBe(true);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('returns WriteResult with path on actual write', () => {
    const mod = makeModule();
    const results = writer.write([mod], '/tmp/out');

    expect(results).toHaveLength(1);
    expect(results[0].moduleId).toBe('users.get_user');
    expect(results[0].path).toContain('users_get_user.ts');
    expect(results[0].verified).toBe(true);
    expect(results[0].verificationError).toBeNull();
  });

  it('writes valid TypeScript code with module() call', () => {
    const mod = makeModule();
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).toContain("export default module({");
    expect(writtenContent).toContain("async execute(inputs)");
    expect(writtenContent).toContain("});");
  });

  it('code includes correct import statement', () => {
    const mod = makeModule();
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).toContain("import { module } from 'apcore-js';");
  });

  it('code contains proper id, description, tags, version', () => {
    const mod = makeModule();
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).toContain('id: "users.get_user"');
    expect(writtenContent).toContain('description: "Get a user by ID"');
    expect(writtenContent).toContain('tags: ["users"]');
    expect(writtenContent).toContain('version: "1.0.0"');
  });

  it('handles target parsing — splits "myapp/users:get_user" to import path and export name', () => {
    const mod = makeModule({ target: 'myapp/users:get_user' });
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).toContain('const { get_user: _original } = await import("myapp/users")');
    expect(writtenContent).toContain("return _original(inputs)");
  });

  it('sanitizes identifiers ("weird.id-test" -> "weird_id_test")', () => {
    const mod = makeModule({ moduleId: 'weird.id-test', target: 'myapp/views:createUser' });
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
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).not.toContain('annotations');
  });

  it('annotations present -> annotations serialized inline', () => {
    const mod = makeModule({ annotations: { readOnly: true } });
    writer.write([mod], '/tmp/out');

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(writtenContent).toContain('annotations:');
    expect(writtenContent).toContain(JSON.stringify({ readOnly: true }));
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
