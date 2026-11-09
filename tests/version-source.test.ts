// Always-on guard for the VERSION implementation strategy.
//
// `VERSION` used to be resolved at module load with a runtime
// `createRequire(import.meta.url)` resolve of `../package.json`. Bundlers rewrite
// `import.meta.url` to the *bundle* entry, so under `bun --compile` the package
// threw `Cannot find module '../package.json' from '/$bunfs/root/<entry>'` at
// import time — breaking every consumer, including those that never read
// `VERSION`. It must stay a build-time static import.
//
// This runs by default (no env var, no toolchain beyond tsc), so the regression
// cannot slip back in unnoticed while the opt-in packaging smoke test is
// disabled. `tests/packaging.test.ts` proves the behaviour end to end.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY_SOURCE = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Drop comments so the warning prose in `src/index.ts` is not matched as code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

describe('VERSION implementation', () => {
  it('resolves package.json statically, not at runtime', () => {
    const src = readFileSync(ENTRY_SOURCE, 'utf8');
    const code = stripComments(src);

    // Any runtime resolve of package.json is a bundle-time landmine.
    expect(code).not.toMatch(/createRequire\s*\(\s*import\.meta\.url\s*\)/);
    expect(code).not.toMatch(/require\s*\(\s*['"][^'"]*package\.json['"]\s*\)/);
    expect(code).not.toMatch(/readFileSync\s*\([^)]*package\.json/);

    // And the static import itself must stay (default import only — Node's JSON
    // modules do not expose named exports).
    expect(code).toMatch(
      /import\s+pkg\s+from\s+['"]\.\.\/package\.json['"]\s+with\s*\{[^}]*type\s*:\s*['"]json['"]/,
    );
  });
});
