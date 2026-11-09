// VERSION plumbing: the value must come from package.json and nothing else.
//
// Scope note: this test catches a *hardcoded* or *mis-sourced* version (e.g.
// someone writing `export const VERSION = '0.0.0'`, or reading a different
// package's manifest). It does NOT catch a re-introduction of the runtime
// `createRequire(import.meta.url)('../package.json')` resolve, because that
// reads the very same file this test reads. That regression is covered by
// `tests/version-source.test.ts` (always on) and `tests/packaging.test.ts`
// (compiled-consumer smoke, opt-in).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';

describe('VERSION', () => {
  it('matches the version field in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });

  it('is a plain semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });
});
