// Cross-SDK conformance harness for `deepResolveRefs` — asserts the TypeScript
// impl matches the shared fixture corpus at
// apcore-toolkit/conformance/fixtures/ref_resolution.json. The Python and Rust
// SDKs run the same fixture file through their own resolvers and must agree
// case-for-case.
//
// The normative rule lives in
// apcore-toolkit/docs/features/openapi.md#ref-sibling-keys-are-preserved.
//
// The sibling-merge half is a security property, not a fidelity nicety: apcore
// reads `x-sensitive` off the *resolved* schema to decide what to redact, and
// this toolkit produces the schemas apcore reads. A marking dropped here is a
// credential logged in plaintext downstream. apcore closed the same hole in
// its own resolver as D-98 in 0.31.0.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deepResolveRefs } from '../src/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'apcore-toolkit',
  'conformance',
  'fixtures',
  'ref_resolution.json',
);

interface Case {
  id: string;
  description: string;
  input: {
    schema: Record<string, unknown>;
    openapi_doc: Record<string, unknown>;
  };
  expected: Record<string, unknown>;
}

function loadCases(): Case[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  return (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { test_cases: Case[] }).test_cases;
}

const CASES = loadCases();

describe.skipIf(CASES.length === 0)('deepResolveRefs — shared conformance corpus', () => {
  it('the corpus is non-empty and its ids are unique', () => {
    expect(CASES.length).toBeGreaterThan(0);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  for (const c of CASES) {
    it(`${c.id} — ${c.description}`, () => {
      expect(deepResolveRefs(c.input.schema, c.input.openapi_doc)).toEqual(c.expected);
    });
  }

  it('does not mutate the caller-supplied schema', () => {
    // `deepResolveRefs` is documented pure; the merge must not write back.
    const schema = { $ref: '#/components/schemas/T', 'x-sensitive': true };
    const before = JSON.stringify(schema);
    deepResolveRefs(schema, { components: { schemas: { T: { type: 'string' } } } });
    expect(JSON.stringify(schema)).toBe(before);
  });
});
