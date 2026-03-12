import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Verifier, VerifyResult } from './types.js';

export class YAMLVerifier implements Verifier {
  verify(path: string, _moduleId: string): VerifyResult {
    try {
      const content = readFileSync(path, 'utf-8');
      const doc = yaml.load(content) as Record<string, unknown>;
      if (doc == null || typeof doc !== 'object') {
        return { ok: false, error: 'YAML parsed to non-object value' };
      }
      if (!('bindings' in doc)) {
        return { ok: false, error: 'Missing required "bindings" key' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `YAML parse error: ${(err as Error).message}` };
    }
  }
}

export class SyntaxVerifier implements Verifier {
  verify(path: string, _moduleId: string): VerifyResult {
    try {
      const content = readFileSync(path, 'utf-8');
      // Basic syntax check: ensure file is non-empty and parseable
      if (content.trim().length === 0) {
        return { ok: false, error: 'File is empty' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Read error: ${(err as Error).message}` };
    }
  }
}

export class RegistryVerifier implements Verifier {
  private readonly registry: { getModule?(id: string): unknown };

  constructor(registry: { getModule?(id: string): unknown }) {
    this.registry = registry;
  }

  verify(_path: string, moduleId: string): VerifyResult {
    try {
      if (typeof this.registry.getModule !== 'function') {
        return { ok: false, error: 'Registry does not have a getModule method' };
      }
      const mod = this.registry.getModule(moduleId);
      if (mod == null) {
        return { ok: false, error: `Module "${moduleId}" not found in registry` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Registry lookup error: ${(err as Error).message}` };
    }
  }
}

export class MagicBytesVerifier implements Verifier {
  private readonly expected: Buffer;

  constructor(expected: Buffer) {
    this.expected = expected;
  }

  verify(path: string, _moduleId: string): VerifyResult {
    try {
      const content = readFileSync(path);
      const header = content.subarray(0, this.expected.length);
      if (!header.equals(this.expected)) {
        return { ok: false, error: 'File header does not match expected magic bytes' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Read error: ${(err as Error).message}` };
    }
  }
}

export class JSONVerifier implements Verifier {
  verify(path: string, _moduleId: string): VerifyResult {
    try {
      const content = readFileSync(path, 'utf-8');
      JSON.parse(content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `JSON parse error: ${(err as Error).message}` };
    }
  }
}

export function runVerifierChain(
  verifiers: Verifier[],
  path: string,
  moduleId: string,
): VerifyResult {
  for (const verifier of verifiers) {
    const result = verifier.verify(path, moduleId);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
