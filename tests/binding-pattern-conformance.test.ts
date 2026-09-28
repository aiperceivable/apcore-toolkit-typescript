// Cross-SDK conformance harness for BindingLoader's `pattern` argument —
// asserts the TypeScript impl matches the shared fixture corpus at
// apcore-toolkit/conformance/fixtures/binding_pattern.json. The Python and
// Rust SDKs run the same fixture file through their own loaders and must
// agree case-for-case.
//
// The normative matching algorithm lives in
// apcore-toolkit/docs/features/binding-loader.md#normative-matching-algorithm.
// Tracking issue: aiperceivable/apcore-toolkit#18.
//
// Three case kinds:
//   validate — the pattern is rejected before any filesystem access
//   match    — the pure name matcher
//   select   — how `pattern` composes with `recursive` over a directory tree
//
// `select` cases may carry an optional `input.symlinks` map (link -> target,
// both relative to the temp root) and `requires: "symlinks"`; the latter are
// reported as skipped, with the reason in the test name, on platforms where
// symlink creation fails.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import * as bindingParser from '../src/binding-parser.js';

import {
  BindingLoader,
  BindingLoadError,
  DEFAULT_BINDING_PATTERN,
  matchesBindingPattern,
} from '../src/binding-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'apcore-toolkit',
  'conformance',
  'fixtures',
  'binding_pattern.json',
);

interface MatchCase {
  id: string;
  kind: 'match';
  description: string;
  input: { pattern: string; name: string };
  expected: { matches: boolean };
}

interface SelectCase {
  id: string;
  kind: 'select';
  description: string;
  /** Cases marked `"symlinks"` are skipped (visibly) where symlinks cannot be created. */
  requires?: string;
  input: {
    files: string[];
    /** Optional link name -> target, both relative to the temp root. */
    symlinks?: Record<string, string>;
    pattern: string;
    recursive: boolean;
  };
  expected: { selected: string[] };
}

type Case = MatchCase | SelectCase;

function loadCases(): Case[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  const data = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { test_cases: Case[] };
  return data.test_cases;
}

/**
 * Materialize `files` under `root` per the fixture's harness convention: an
 * entry that is a strict path prefix of another entry is a DIRECTORY, not a
 * file. Every other entry is written as a one-binding document whose
 * `module_id` is the entry's own relative path.
 *
 * `module_id` cannot stand in for the selected *path* — a symlink and its
 * target share content — so `select` assertions read the paths the loader
 * actually handed to `parseBindingDocument` instead (see case 040).
 */
function materialize(
  root: string,
  files: string[],
  symlinks: Record<string, string> = {},
): void {
  const directories = new Set(
    files.filter((f) => files.some((other) => other.startsWith(`${f}/`))),
  );
  for (const rel of files) {
    const abs = join(root, ...rel.split('/'));
    if (directories.has(rel)) {
      mkdirSync(abs, { recursive: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      yaml.dump({
        spec_version: '1.0',
        bindings: [{ module_id: rel, target: 'fixture:noop' }],
      }),
    );
  }
  // Targets exist by now, which is what Windows needs to pick the right
  // symlink flavour (file vs junction).
  for (const [link, target] of Object.entries(symlinks)) {
    const linkAbs = join(root, ...link.split('/'));
    mkdirSync(dirname(linkAbs), { recursive: true });
    symlinkSync(join(root, ...target.split('/')), linkAbs);
  }
}

/**
 * Probe once whether this platform lets the harness create symlinks —
 * unprivileged Windows does not. Cases carrying `requires: "symlinks"` are
 * then reported as skipped, never silently passed.
 */
function detectSymlinkSupport(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'binding-pattern-symlink-probe-'));
  try {
    const target = join(probe, 'target.txt');
    writeFileSync(target, 'probe');
    symlinkSync(target, join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const SYMLINKS_SUPPORTED = detectSymlinkSupport();

const cases = loadCases();

describe.skipIf(cases.length === 0)('BindingLoader pattern — cross-SDK conformance', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  for (const tc of cases) {
    const needsSymlinks = (tc as { requires?: string }).requires === 'symlinks';
    const runner = needsSymlinks && !SYMLINKS_SUPPORTED ? it.skip : it;
    const label =
      needsSymlinks && !SYMLINKS_SUPPORTED
        ? `${tc.id}: SKIPPED — this platform cannot create symlinks (requires: symlinks)`
        : `${tc.id}: ${tc.description}`;
    runner(label, () => {
      if (tc.kind === 'match') {
        expect(
          matchesBindingPattern(tc.input.pattern, tc.input.name),
          `Case ${tc.id}: ${tc.description}`,
        ).toBe(tc.expected.matches);
        return;
      }

      const root = mkdtempSync(join(tmpdir(), 'binding-pattern-conformance-'));
      tmpDirs.push(root);
      materialize(root, tc.input.files, tc.input.symlinks);

      // The loader hands each selected file to `parseBindingDocument` as its
      // third argument, so this records the selected paths themselves, in
      // load order — the one signal that stays correct for symlinks, whose
      // content is indistinguishable from their target's.
      const spy = vi.spyOn(bindingParser, 'parseBindingDocument');
      let selected: string[];
      try {
        new BindingLoader().load(root, false, tc.input.recursive, tc.input.pattern);
        selected = spy.mock.calls.map((call) =>
          relative(root, String(call[2])).split(sep).join('/'),
        );
      } finally {
        spy.mockRestore();
      }

      expect(selected, `Case ${tc.id}: ${tc.description}`).toEqual(tc.expected.selected);
    });
  }
});

describe('matchesBindingPattern — unit', () => {
  it('exports the canonical default pattern', () => {
    expect(DEFAULT_BINDING_PATTERN).toBe('*.binding.yaml');
  });

  it('matches an empty name against a star-only pattern', () => {
    expect(matchesBindingPattern('*', '')).toBe(true);
    expect(matchesBindingPattern('**', '')).toBe(true);
  });

  it('does not match an empty name against a literal pattern', () => {
    expect(matchesBindingPattern('a', '')).toBe(false);
    expect(matchesBindingPattern('?', '')).toBe(false);
  });

  it('anchors literal patterns at both ends', () => {
    expect(matchesBindingPattern('abc', 'abc')).toBe(true);
    expect(matchesBindingPattern('abc', 'abcd')).toBe(false);
    expect(matchesBindingPattern('abc', 'zabc')).toBe(false);
  });

  it('backtracks from the most recent star only', () => {
    expect(matchesBindingPattern('*a*b', 'aaabab')).toBe(true);
    expect(matchesBindingPattern('*a*b', 'aaaba')).toBe(false);
  });

  it('treats a trailing star as able to match nothing', () => {
    expect(matchesBindingPattern('abc*', 'abc')).toBe(true);
    expect(matchesBindingPattern('abc*def*', 'abcdef')).toBe(true);
  });

  it('consumes exactly one astral code point per `?` (not two UTF-16 units)', () => {
    // U+1F600 is a surrogate pair in UTF-16; indexing the string directly
    // would let two `?`s eat one emoji.
    expect(matchesBindingPattern('?.binding.yaml', '\u{1F600}.binding.yaml')).toBe(true);
    expect(matchesBindingPattern('??.binding.yaml', '\u{1F600}.binding.yaml')).toBe(false);
    expect(matchesBindingPattern('?', '\u{1F600}')).toBe(true);
  });

  it('applies no Unicode normalization (NFC and NFD are distinct)', () => {
    const nfc = '\u00E9.binding.yaml'; // e-acute as one code point (NFC)
    const nfd = 'e\u0301.binding.yaml'; // 'e' + combining acute (NFD)
    expect(matchesBindingPattern('?.binding.yaml', nfc)).toBe(true);
    expect(matchesBindingPattern('?.binding.yaml', nfd)).toBe(false);
    expect(matchesBindingPattern(nfc, nfd)).toBe(false);
  });

  it('stays bounded on the classic exponential-blowup input', () => {
    const name = `${'a'.repeat(2000)}c`;
    const started = Date.now();
    expect(matchesBindingPattern('*a*a*a*a*b', name)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a pattern is never rejected', () => {
  // Every string is a valid pattern and the loader never raises on one for
  // syntactic reasons — apcore Algorithm A25 requirement 2, PROTOCOL_SPEC
  // §5.12.6 clause 6. These cases asserted the inverse in a pre-release draft of 0.12.0.
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), 'apcore-neverreject-'));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, 'a.binding.yaml'),
      "spec_version: '1.0'\nbindings:\n  - module_id: x\n    target: m:f\n",
    );
    return dir;
  }

  it('yields an empty selection rather than throwing, for every odd pattern', () => {
    for (const odd of ['', 'sub/*.binding.yaml', '**/*.binding.yaml', '*.binding.yaml/', '/', 'a[b', '{x,y}']) {
      const dir = seeded();
      expect(() => new BindingLoader().load(dir, false, false, odd), odd).not.toThrow();
      expect(new BindingLoader().load(dir, false, false, odd), odd).toEqual([]);
    }
  });

  it('treats a backslash as a literal, so such a file name is matchable', () => {
    // A25 requirement 4: `\\` is a literal, not a path separator.
    const dir = mkdtempSync(join(tmpdir(), 'apcore-backslash-'));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, 'sub\\x.binding.yaml'),
      "spec_version: '1.0'\nbindings:\n  - module_id: x\n    target: m:f\n",
    );
    const modules = new BindingLoader().load(dir, false, false, 'sub\\*.binding.yaml');
    expect(modules.map((m) => m.moduleId)).toEqual(['x']);
  });

  it('still reports a missing path — the pattern no longer pre-empts it', () => {
    expect(() =>
      new BindingLoader().load(join(tmpdir(), 'apcore-nope-does-not-exist'), false, false, '**/*.binding.yaml'),
    ).toThrow(BindingLoadError);
  });
});

describe('BindingLoader.load — pattern integration', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'binding-pattern-load-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('surfaces a missing path as such, not as a pattern error', () => {
    // In a pre-release draft of 0.12.0 an odd pattern was rejected before the path was even
    // stat'd, so this call reported the pattern. There is no pattern error
    // any more, so the real fault is what surfaces.
    const missing = join(tmpdir(), 'apcore-toolkit-definitely-absent-dir');
    expect(existsSync(missing)).toBe(false);
    expect(() => new BindingLoader().load(missing, false, false, '**/*.binding.yaml')).toThrow(
      BindingLoadError,
    );
  });

  it('ignores `pattern` when the path names a file — like `recursive`', () => {
    const dir = makeDir();
    const f = join(dir, 'odd-name.yaml');
    writeFileSync(
      f,
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'odd', target: 'pkg:f' }] }),
    );
    // Neither the default nor a deliberately non-matching pattern applies.
    expect(new BindingLoader().load(f).map((m) => m.moduleId)).toEqual(['odd']);
    expect(
      new BindingLoader().load(f, false, false, 'nothing-matches-this').map((m) => m.moduleId),
    ).toEqual(['odd']);
  });

  it('defaults to *.binding.yaml when `pattern` is omitted', () => {
    const dir = makeDir();
    materialize(dir, ['a.binding.yaml', 'b.cli.yaml']);
    expect(new BindingLoader().load(dir).map((m) => m.moduleId)).toEqual(['a.binding.yaml']);
    expect(new BindingLoader().load(dir, false, false).map((m) => m.moduleId)).toEqual([
      'a.binding.yaml',
    ]);
  });

  it('never treats a matching directory as a candidate, in either branch', () => {
    // Spec: "Directories are never candidates". Filtering on name alone would
    // hand the directory to the YAML reader and surface EISDIR.
    const dir = makeDir();
    materialize(dir, ['a.binding.yaml', 'b.binding.yaml/inner.binding.yaml']);
    expect(new BindingLoader().load(dir, false, false).map((m) => m.moduleId)).toEqual([
      'a.binding.yaml',
    ]);
    expect(new BindingLoader().load(dir, false, true).map((m) => m.moduleId)).toEqual([
      'a.binding.yaml',
      'b.binding.yaml/inner.binding.yaml',
    ]);
  });

  it('still follows a symlink to a matching file in the flat branch', () => {
    // Regression guard for the `withFileTypes` switch: `Dirent.isFile()` is
    // false for a symlink, so a naive type guard would silently stop loading
    // symlinked bindings that the pre-`withFileTypes` flat branch did load.
    const dir = makeDir();
    const real = join(dir, 'real.binding.yaml');
    writeFileSync(
      real,
      yaml.dump({ spec_version: '1.0', bindings: [{ module_id: 'real', target: 'pkg:f' }] }),
    );
    symlinkSync(real, join(dir, 'linked.binding.yaml'));
    expect(new BindingLoader().load(dir, false, false).map((m) => m.moduleId).sort()).toEqual([
      'real',
      'real',
    ]);
  });

  it('skips a symlink pointing at a directory whose name matches', () => {
    const dir = makeDir();
    const realDir = join(dir, 'subdir');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(dir, 'link.binding.yaml'));
    expect(new BindingLoader().load(dir, false, false)).toEqual([]);
  });
});
