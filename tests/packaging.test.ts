// Compiled-consumer smoke test — the scenario that actually broke downstream
// consumers: `bun build --compile` inlines the module graph into `$bunfs`, so a
// runtime `createRequire(import.meta.url)('../package.json')` cannot resolve and
// the package throws `MODULE_NOT_FOUND` at import time.
//
// Opt-in because it shells out to `bun build --compile` (sub-second locally, but
// it needs a prior `pnpm build` and a bun binary on PATH). CI sets the flag and
// installs bun — and deliberately *fails* rather than skips if bun is missing, so
// the guard cannot silently disappear.
//
// Run with:  pnpm build && pnpm test:packaging
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Both must be filesystem paths, not URLs: `new URL('../x', import.meta.url)` is
// relative to *this file's* directory (tests/), and `bun build` cannot resolve
// `file://` specifiers.
const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

function hasBun(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const enabled = process.env.APCORE_PACKAGING_TEST === '1';

describe('compiled-consumer smoke', () => {
  it.skipIf(!enabled)(
    'imports without resolving package.json at runtime',
    { timeout: 180_000 },
    () => {
      // Deliberately not a skip: when the flag is set (CI), a missing bun must be
      // loud, otherwise the guard degrades to a green no-op.
      expect(hasBun(), 'APCORE_PACKAGING_TEST=1 requires bun on PATH').toBe(true);
      expect(existsSync(DIST_ENTRY), 'run `pnpm build` before the packaging test').toBe(true);
      const expected = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string }).version;

      const dir = mkdtempSync(join(tmpdir(), 'apcore-toolkit-pack-'));
      try {
        const consumer = join(dir, 'consumer.ts');
        const outfile = join(dir, process.platform === 'win32' ? 'consumer.exe' : 'consumer');
        writeFileSync(
          consumer,
          `import { VERSION } from ${JSON.stringify(DIST_ENTRY)};\nconsole.log(VERSION);\n`,
        );

        execFileSync(
          'bun',
          ['build', '--compile', '--target', 'bun', consumer, '--outfile', outfile],
          { stdio: 'pipe' },
        );

        expect(execFileSync(outfile, { encoding: 'utf8' }).trim()).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
