import { describe, it, expect } from 'vitest';
import {
  WriteError,
  createWriteResult,
  YAMLVerifier,
  SyntaxVerifier,
  JSONVerifier,
  MagicBytesVerifier,
  RegistryVerifier,
  runVerifierChain,
} from '../src/index.js';
import type { WriteResult, VerifyResult, Verifier } from '../src/index.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('WriteResult', () => {
  it('createWriteResult creates correct structure', () => {
    const result: WriteResult = createWriteResult('mod-1', '/tmp/mod-1.yaml');
    expect(result.moduleId).toBe('mod-1');
    expect(result.path).toBe('/tmp/mod-1.yaml');
    expect(result.verified).toBe(true);
    expect(result.verificationError).toBeNull();
  });

  it('createWriteResult with verification error', () => {
    const result = createWriteResult('mod-1', '/tmp/mod-1.yaml', false, 'parse failed');
    expect(result.verified).toBe(false);
    expect(result.verificationError).toBe('parse failed');
  });
});

describe('WriteError', () => {
  it('extends Error with path and cause', () => {
    const cause = new Error('disk full');
    const err = new WriteError('/tmp/file.yaml', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WriteError');
    expect(err.path).toBe('/tmp/file.yaml');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('/tmp/file.yaml');
    expect(err.message).toContain('disk full');
  });
});

describe('YAMLVerifier', () => {
  it('passes for valid YAML binding files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-verifier-'));
    const filePath = join(tmpDir, 'test.yaml');
    writeFileSync(filePath, 'bindings:\n  - module_id: test\n', 'utf-8');

    const verifier = new YAMLVerifier();
    const result: VerifyResult = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails for invalid YAML', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-verifier-'));
    const filePath = join(tmpDir, 'bad.yaml');
    writeFileSync(filePath, '{{invalid yaml', 'utf-8');

    const verifier = new YAMLVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('YAML parse error');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails for YAML without bindings key', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'yaml-verifier-'));
    const filePath = join(tmpDir, 'no-bindings.yaml');
    writeFileSync(filePath, 'key: value\n', 'utf-8');

    const verifier = new YAMLVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bindings');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('SyntaxVerifier', () => {
  it('passes for non-empty files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'syntax-verifier-'));
    const filePath = join(tmpDir, 'test.ts');
    writeFileSync(filePath, 'const x = 1;', 'utf-8');

    const verifier = new SyntaxVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails for empty files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'syntax-verifier-'));
    const filePath = join(tmpDir, 'empty.ts');
    writeFileSync(filePath, '', 'utf-8');

    const verifier = new SyntaxVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('JSONVerifier', () => {
  it('passes for valid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'json-verifier-'));
    const filePath = join(tmpDir, 'test.json');
    writeFileSync(filePath, '{"key": "value"}', 'utf-8');

    const verifier = new JSONVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails for invalid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'json-verifier-'));
    const filePath = join(tmpDir, 'bad.json');
    writeFileSync(filePath, '{invalid}', 'utf-8');

    const verifier = new JSONVerifier();
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON parse error');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('MagicBytesVerifier', () => {
  it('passes when header matches', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'magic-verifier-'));
    const filePath = join(tmpDir, 'test.bin');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]));

    const verifier = new MagicBytesVerifier(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails when header does not match', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'magic-verifier-'));
    const filePath = join(tmpDir, 'test.bin');
    writeFileSync(filePath, Buffer.from([0x00, 0x00, 0x00]));

    const verifier = new MagicBytesVerifier(Buffer.from([0x89, 0x50]));
    const result = verifier.verify(filePath, 'test');
    expect(result.ok).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('RegistryVerifier', () => {
  it('passes when module exists in registry', () => {
    const registry = { getModule: (id: string) => ({ id }) };
    const verifier = new RegistryVerifier(registry);
    const result = verifier.verify('/tmp/x', 'my-module');
    expect(result.ok).toBe(true);
  });

  it('fails when module not found in registry', () => {
    const registry = { getModule: () => null };
    const verifier = new RegistryVerifier(registry);
    const result = verifier.verify('/tmp/x', 'missing');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing');
  });

  it('fails when registry lacks getModule method', () => {
    const registry = {};
    const verifier = new RegistryVerifier(registry);
    const result = verifier.verify('/tmp/x', 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('getModule');
  });
});

describe('runVerifierChain', () => {
  it('returns ok when all verifiers pass', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'chain-verifier-'));
    const filePath = join(tmpDir, 'test.json');
    writeFileSync(filePath, '{"bindings": []}', 'utf-8');

    const result = runVerifierChain(
      [new SyntaxVerifier(), new JSONVerifier()],
      filePath,
      'test',
    );
    expect(result.ok).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns first failure', () => {
    const failVerifier: Verifier = {
      verify: () => ({ ok: false, error: 'custom failure' }),
    };
    const passVerifier: Verifier = {
      verify: () => ({ ok: true }),
    };

    const result = runVerifierChain([failVerifier, passVerifier], '/tmp/x', 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('custom failure');
  });
});
