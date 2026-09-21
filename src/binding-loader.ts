/**
 * BindingLoader — parse `.binding.yaml` files back into `ScannedModule`.
 *
 * Inverse of {@link YAMLWriter}. Unlike apcore-js's binding loader (which
 * imports the target and creates a runtime `FunctionModule`), this loader
 * is pure data: it parses YAML into `ScannedModule` objects for validation,
 * merging, diffing, or round-trip workflows. No module resolution occurs.
 *
 * This file adds the filesystem-reading entry point (`load(filePath)`) on
 * top of the runtime-neutral parsing in `binding-parser.ts`. Consumers that
 * only need to parse already-loaded documents (browsers, edge runtimes,
 * workers) should use {@link BindingParser} or {@link parseBindingDocument}
 * from `apcore-toolkit/browser` instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  BindingLoadError,
  BindingParser,
  parseBindingDocument,
} from './binding-parser.js';
import type { BindingLoadOptions } from './binding-parser.js';
import type { ScannedModule } from './types.js';

// Re-export the runtime-neutral surface so the default package entry
// (`apcore-toolkit`) continues to expose exactly the same symbols it did
// before the split — existing consumers (`nestjs-apcore` etc.) see no
// change — plus the new {@link BindingParser} and
// {@link parseBindingDocument} additions that are now also available.
export { BindingLoadError, BindingParser, parseBindingDocument } from './binding-parser.js';
export type { BindingLoadOptions } from './binding-parser.js';

/** Maximum file size (bytes) that BindingLoader will read — matches Rust SDK's 16 MiB cap. */
const MAX_BINDING_FILE_SIZE = 16 * 1024 * 1024; // 16 MiB

/** Maximum number of .binding.yaml files per directory scan — matches Rust SDK's cap. */
const MAX_BINDING_FILES_PER_DIR = 10_000;

// Cap on directory recursion depth in `_collectRecursive`. Symlink loops
// (`a -> b -> a`) are ruled out upstream — traversal never descends into a
// symlinked directory (see {@link entryKind}) — so this bounds worst-case
// stack usage on legitimately-deep *real* trees, and backstops any future
// change to that policy. 64 is well above any realistic `.binding.yaml`
// layout.
const MAX_RECURSION_DEPTH = 64;

/**
 * Default `pattern` for {@link BindingLoader.load} — the canonical
 * `bindings.pattern` default from apcore's `schemas/defaults.schema.json`.
 */
export const DEFAULT_BINDING_PATTERN = '*.binding.yaml';

/**
 * Match a file **name** against a binding `pattern`.
 *
 * The normative algorithm is specified in
 * `apcore-toolkit/docs/features/binding-loader.md#normative-matching-algorithm`
 * and pinned across the Python / TypeScript / Rust SDKs by
 * `conformance/fixtures/binding_pattern.json`. It is the standard two-pointer
 * glob match with single-star backtracking:
 *
 * - `*` matches zero or more characters, including `.`
 * - `?` matches exactly one character
 * - everything else is a literal, including `[`, `]`, `{`, `}`, `!`, `^`, `-`
 *   (no character classes, no brace expansion)
 * - matching is case-sensitive on every platform and applies no Unicode
 *   normalization
 *
 * Backtracking resumes only from the most recent `*`, which bounds the match
 * at O(pattern x name) — the naive "try every split point" recursion is
 * exponential on inputs such as `*a*a*a*a*b`, and patterns arrive from
 * configuration.
 *
 * Comparison is over Unicode **code points**: both inputs are expanded with
 * `Array.from` before indexing, because indexing a JavaScript string yields
 * UTF-16 code units and would let a single astral character be consumed by
 * two `?`s.
 *
 * @param pattern - The file-name pattern (already validated by
 *   {@link validateBindingPattern} when it came from a caller).
 * @param name - A bare file name — never a path.
 */
export function matchesBindingPattern(pattern: string, name: string): boolean {
  const pat = Array.from(pattern);
  const nam = Array.from(name);
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;

  while (n < nam.length) {
    if (p < pat.length && pat[p] === '?') {
      p += 1;
      n += 1;
    } else if (p < pat.length && pat[p] === '*') {
      // Consume zero characters for now; remember where to resume.
      star = p;
      mark = n;
      p += 1;
    } else if (p < pat.length && pat[p] === nam[n]) {
      p += 1;
      n += 1;
    } else if (star >= 0) {
      // Let the most recent '*' eat one more character.
      p = star + 1;
      mark += 1;
      n = mark;
    } else {
      return false;
    }
  }

  // Trailing stars may match nothing.
  while (p < pat.length && pat[p] === '*') p += 1;

  return p === pat.length;
}

/**
 * Reject patterns that cannot be honoured, **before** any filesystem access,
 * so an invalid pattern surfaces as a diagnostic rather than a silently empty
 * result. Maps to the conformance identifiers `empty_pattern` and
 * `path_separator`.
 *
 * @throws {BindingLoadError} when `pattern` is empty or contains `/` or `\`.
 */
export function validateBindingPattern(pattern: string): void {
  if (pattern.length === 0) {
    throw new BindingLoadError({ reason: 'pattern must not be empty' });
  }
  if (pattern.includes('/') || pattern.includes('\\')) {
    throw new BindingLoadError({
      reason:
        'pattern matches file names only; ' +
        'use recursive=true to descend into subdirectories',
    });
  }
}

/**
 * Resolve what a directory entry actually is, for the spec's "Directories are
 * never candidates" rule.
 *
 * **Test the target, not the link.** The type check uses a *following*
 * `statSync`, never `Dirent.isFile()`: a `Dirent` reports on the link itself,
 * so a guard built on it silently drops every symlinked binding file — a
 * data-loss-shaped regression with no error. It also reports `false` for both
 * `isFile()` and `isDirectory()` on filesystems that return `DT_UNKNOWN`.
 *
 * **Following file symlinks is not following directory symlinks.** A symlink
 * whose target is a directory is neither selected nor descended into — that is
 * where cycles and tree escape live. Only a *real* directory yields `'dir'`.
 *
 * Returns `null` for anything that is neither: a broken symlink (the stat
 * throws), a symlink to a directory, or a fifo / socket / device. `null`
 * entries are skipped, never fatal.
 */
function entryKind(full: string, entry: fs.Dirent): 'file' | 'dir' | null {
  const isLink = entry.isSymbolicLink();
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    // Broken symlink, or the entry vanished between readdir and stat.
    return null;
  }
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return isLink ? null : 'dir';
  return null;
}

/**
 * Loads `.binding.yaml` files into `ScannedModule` objects.
 *
 * Extends {@link BindingParser} so `loadData(data)` (runtime-neutral parsing
 * of pre-loaded documents) is also available on every `BindingLoader`
 * instance — the class hierarchy mirrors the Python SDK's
 * `BindingLoader.load_data` method.
 *
 * @example
 * ```ts
 * const loader = new BindingLoader();
 * const modules = loader.load('./bindings/');
 * const strict = loader.load('foo.binding.yaml', true, false);
 * ```
 */
export class BindingLoader extends BindingParser {
  /**
   * Load one file, or every file in a directory whose **name** matches
   * `pattern`.
   *
   * `recursive` and `pattern` are orthogonal: `recursive` governs *which
   * directories are traversed*, `pattern` governs *which file names match* at
   * whatever depth traversal reached. The caller never writes a `**\/` prefix
   * and the loader never synthesises one.
   *
   * @param filePath - Path to a single `.binding.yaml` file or a directory.
   * @param strict - When `true`, also require `input_schema` and `output_schema`. Default: `false`.
   * @param recursive - When `true`, recurse into subdirectories. Default: `false`.
   * @param pattern - File-name pattern; see {@link matchesBindingPattern}.
   *   Default: {@link DEFAULT_BINDING_PATTERN}. Ignored when `filePath` names
   *   a file — a caller that explicitly names one file has already made the
   *   selection.
   * @throws {BindingLoadError} when `pattern` is empty or contains a path
   *   separator (raised before any filesystem access), when the path is
   *   missing, when YAML is malformed, or when any entry fails validation.
   */
  load(
    filePath: string,
    strict?: boolean,
    recursive?: boolean,
    pattern?: string,
  ): ScannedModule[] {
    strict = strict ?? false;
    recursive = recursive ?? false;
    const namePattern = pattern ?? DEFAULT_BINDING_PATTERN;

    // Validated before any filesystem access, so `load(dir, ..., '**/*.yaml')`
    // is a diagnostic rather than a mystery empty result.
    validateBindingPattern(namePattern);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      const reason =
        code === 'ENOENT'
          ? 'path does not exist'
          : `cannot stat path (${code ?? 'unknown'})`;
      throw new BindingLoadError({ reason, filePath });
    }

    let files: string[];
    if (stat.isFile()) {
      files = [filePath];
    } else if (stat.isDirectory()) {
      if (recursive) {
        files = this._collectRecursive(filePath, namePattern).sort();
      } else {
        // Guard on entry type so a *directory* whose name matches the pattern
        // is never a candidate (spec: "Directories are never candidates").
        // Filtering on name alone would select it and then die at read time
        // with EISDIR — the exact three-way divergence fixture case 037 pins.
        // {@link entryKind} stats through symlinks, so a symlinked binding
        // file is still selected (case 040) while a symlinked directory is
        // not (case 041).
        files = fs
          .readdirSync(filePath, { withFileTypes: true })
          .filter(
            (e) =>
              matchesBindingPattern(namePattern, e.name) &&
              entryKind(path.join(filePath, e.name), e) === 'file',
          )
          .map((e) => e.name)
          .sort()
          .map((f) => path.join(filePath, f));
      }
      // Enforce the per-directory file-count cap on the merged list so the
      // recursive branch is bounded too. Rust and Python apply the cap
      // unconditionally; the previous TypeScript implementation only
      // checked the non-recursive branch (A-D-013).
      if (files.length > MAX_BINDING_FILES_PER_DIR) {
        throw new BindingLoadError({
          reason: `too many files in directory: ${files.length} exceeds limit of ${MAX_BINDING_FILES_PER_DIR}`,
          filePath,
        });
      }
    } else {
      throw new BindingLoadError({
        reason: 'path is neither a file nor a directory',
        filePath,
      });
    }

    const modules: ScannedModule[] = [];
    for (const f of files) {
      // Enforce per-file size cap before reading
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(f);
      } catch (exc) {
        throw new BindingLoadError({
          reason: `failed to stat file: ${(exc as Error).message}`,
          filePath: f,
        });
      }
      if (fileStat.size > MAX_BINDING_FILE_SIZE) {
        throw new BindingLoadError({
          reason: `file too large: ${fileStat.size} bytes exceeds limit of ${MAX_BINDING_FILE_SIZE} bytes (16 MiB)`,
          filePath: f,
        });
      }
      let content: string;
      try {
        content = fs.readFileSync(f, 'utf-8');
      } catch (exc) {
        throw new BindingLoadError({
          reason: `failed to read file: ${(exc as Error).message}`,
          filePath: f,
        });
      }
      let raw: unknown;
      try {
        raw = yaml.load(content);
      } catch (exc) {
        throw new BindingLoadError({
          reason: `failed to parse YAML: ${(exc as Error).message}`,
          filePath: f,
        });
      }
      if (raw == null) {
        console.warn(`BindingLoader: ${f} is empty, skipping`);
        continue;
      }
      modules.push(...parseBindingDocument(raw, { strict }, f));
    }
    return modules;
  }

  /**
   * Recursively collect files under `dir` whose **name** matches `pattern`
   * (directory names are never matched — traversal depth is this method's
   * job, name selection is `pattern`'s). Entry types are resolved by the
   * shared {@link entryKind}, so directories are never candidates, symlinked
   * files are followed and symlinked directories are not descended into —
   * identically in both branches — and recursion is capped at
   * {@link MAX_RECURSION_DEPTH}. Permission errors (`EACCES`/`EPERM`) on an
   * individual subdirectory are swallowed with a warning so one unreadable
   * subtree does not abort loading of the rest; all other `readdirSync`
   * failures (e.g. `EMFILE`, `ENOTDIR`) propagate so systemic problems are
   * not silently turned into partial loads.
   */
  private _collectRecursive(dir: string, pattern: string, depth = 0): string[] {
    if (depth > MAX_RECURSION_DEPTH) {
      console.warn(
        `BindingLoader: max recursion depth (${MAX_RECURSION_DEPTH}) reached at ${dir}; stopping descent.`,
      );
      return [];
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.warn(
          `BindingLoader: cannot read ${dir}: ${(exc as Error).message}; skipping`,
        );
        return [];
      }
      throw exc;
    }
    const results: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const kind = entryKind(full, entry);
      if (kind === 'dir') {
        // A directory is descended into, never matched against `pattern` —
        // depth is this method's job, name selection is `pattern`'s.
        results.push(...this._collectRecursive(full, pattern, depth + 1));
      } else if (kind === 'file' && matchesBindingPattern(pattern, entry.name)) {
        results.push(full);
      }
    }
    return results;
  }
}
