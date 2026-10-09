import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { BindingLoadError, BindingLoader, parseBindingDocument } from '../src/binding-loader.js';
import type { ScannedModule } from '../src/types.js';

interface Case {
  id: string;
  data: Record<string, unknown> & { bindings: unknown[] };
  loose_error?: string;
  strict_error?: string;
  fields?: Record<string, unknown>;
}

const fixture = new URL('../../apcore-toolkit/conformance/fixtures/binding_structure.json', import.meta.url);
const cases = (JSON.parse(readFileSync(fixture, 'utf8')) as { test_cases: Case[] }).test_cases;
const fields: Record<string, keyof ScannedModule> = {
  input_schema: 'inputSchema', output_schema: 'outputSchema', suggested_alias: 'suggestedAlias',
  metadata: 'metadata', examples: 'examples', warnings: 'warnings', tags: 'tags',
};

describe.each([false, true])('binding structure strict=%s', (strict) => {
  it.each(cases)('$id', (testCase) => {
    const data = structuredClone(testCase.data);
    const directory = mkdtempSync(join(tmpdir(), 'binding-structure-'));
    const file = join(directory, 'case.binding.yaml');
    try {
      writeFileSync(file, yaml.dump(data));
      const loader = new BindingLoader();
      const error = strict ? testCase.strict_error : testCase.loose_error;
      for (const load of [
        () => loader.loadData(data, { strict }),
        () => parseBindingDocument(data, { strict }, file),
        () => loader.load(file, strict),
      ]) {
        if (error) {
          expect(load).toThrow(BindingLoadError);
          expect(load).toThrow(error);
        } else {
          const modules = load();
          expect(modules).toHaveLength(data.bindings.length);
          for (const [field, expected] of Object.entries(testCase.fields ?? {})) {
            expect(modules[0][fields[field]]).toEqual(expected);
          }
        }
      }
      expect(data).toEqual(testCase.data);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
