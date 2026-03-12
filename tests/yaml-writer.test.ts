import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YAMLWriter } from '../src/output/yaml-writer.js';
import { createScannedModule } from '../src/types.js';
import type { WriteResult } from '../src/output/types.js';
import { YAMLVerifier } from '../src/output/verifiers.js';

const REQUIRED_FIELDS = {
  moduleId: 'test-module',
  description: 'A test module',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  tags: ['test', 'example'],
  target: 'http://localhost:8080/api/test',
} as const;

function makeModule(overrides: Record<string, unknown> = {}) {
  return createScannedModule({ ...REQUIRED_FIELDS, ...overrides } as Parameters<typeof createScannedModule>[0]);
}

describe('YAMLWriter', () => {
  describe('empty modules', () => {
    it('returns empty array for empty input', () => {
      const writer = new YAMLWriter();
      const result = writer.write([], '/tmp/unused');
      expect(result).toEqual([]);
    });
  });

  describe('dry run', () => {
    it('returns WriteResult without writing files', () => {
      const writer = new YAMLWriter();
      const mod = makeModule();
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-dry-'));

      const results = writer.write([mod], tmpDir, { dryRun: true });

      expect(results).toHaveLength(1);
      expect(results[0].moduleId).toBe('test-module');
      expect(results[0].path).toBeNull();
      expect(results[0].verified).toBe(true);
      // No files should have been written
      const files = readdirSync(tmpDir);
      expect(files).toHaveLength(0);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not create output directory in dry run mode', () => {
      const writer = new YAMLWriter();
      const mod = makeModule();
      const nonExistentDir = join(tmpdir(), 'yaml-writer-nonexistent-' + Date.now());

      const results = writer.write([mod], nonExistentDir, { dryRun: true });

      expect(results).toHaveLength(1);
      expect(existsSync(nonExistentDir)).toBe(false);
    });
  });

  describe('WriteResult structure', () => {
    it('returns WriteResult with correct fields on actual write', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'result-test' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-result-'));

      const results: WriteResult[] = writer.write([mod], tmpDir);

      expect(results).toHaveLength(1);
      expect(results[0].moduleId).toBe('result-test');
      expect(results[0].path).toContain('result-test.binding.yaml');
      expect(results[0].verified).toBe(true);
      expect(results[0].verificationError).toBeNull();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('verification support', () => {
    it('runs verifiers when verify=true', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'verify-test' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-verify-'));

      const results = writer.write([mod], tmpDir, {
        verify: true,
        verifiers: [new YAMLVerifier()],
      });

      expect(results).toHaveLength(1);
      expect(results[0].verified).toBe(true);
      expect(results[0].verificationError).toBeNull();

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips verification when verify=false (default)', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'no-verify-test' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-noverify-'));

      const results = writer.write([mod], tmpDir);

      expect(results).toHaveLength(1);
      expect(results[0].verified).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('file content', () => {
    it('writes valid YAML with all fields', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({
        moduleId: 'content-test',
        version: '2.0.0',
        annotations: { readOnly: true },
        documentation: 'Some docs',
        examples: [{ name: 'ex1', input: { key: 'val' }, output: { result: 'ok' } }],
        metadata: { author: 'test' },
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-content-'));

      writer.write([mod], tmpDir);

      const filePath = join(tmpDir, 'content-test.binding.yaml');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('module_id: content-test');
      expect(content).toContain('version: 2.0.0');
      expect(content).toContain('documentation: Some docs');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('filename sanitization', () => {
    it('sanitizes weird/id..test to weird_id_test.binding.yaml', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'weird/id..test' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-sanitize-'));

      writer.write([mod], tmpDir);

      const files = readdirSync(tmpDir);
      expect(files).toContain('weird_id_test.binding.yaml');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('sanitizes special characters to underscores', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'my@module#v1' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-sanitize2-'));

      writer.write([mod], tmpDir);

      const files = readdirSync(tmpDir);
      expect(files).toContain('my_module_v1.binding.yaml');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('file writing', () => {
    it('writes valid YAML with header to a temp directory', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'write-test' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-write-'));

      const results = writer.write([mod], tmpDir);

      expect(results).toHaveLength(1);
      const filePath = join(tmpDir, 'write-test.binding.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Auto-generated by apcore-toolkit scanner');
      expect(content).toContain('# Generated:');
      expect(content).toContain('# Do not edit manually unless you intend to customize schemas.');
      expect(content).toContain('module_id: write-test');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates output directory if it does not exist', () => {
      const writer = new YAMLWriter();
      const mod = makeModule({ moduleId: 'mkdir-test' });
      const tmpDir = join(tmpdir(), 'yaml-writer-mkdir-' + Date.now(), 'nested');

      writer.write([mod], tmpDir);

      expect(existsSync(tmpDir)).toBe(true);
      expect(existsSync(join(tmpDir, 'mkdir-test.binding.yaml'))).toBe(true);

      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('writes multiple modules to separate files', () => {
      const writer = new YAMLWriter();
      const mod1 = makeModule({ moduleId: 'mod-a' });
      const mod2 = makeModule({ moduleId: 'mod-b' });
      const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-writer-multi-'));

      const results = writer.write([mod1, mod2], tmpDir);

      expect(results).toHaveLength(2);
      expect(existsSync(join(tmpDir, 'mod-a.binding.yaml'))).toBe(true);
      expect(existsSync(join(tmpDir, 'mod-b.binding.yaml'))).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
