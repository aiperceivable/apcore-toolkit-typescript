/**
 * D11-006: BindingLoader file size and count limits
 *
 * These tests require vi.mock('node:fs') at the top level to intercept ESM
 * imports in binding-loader.ts. They live in a separate file because
 * top-level vi.mock changes the module environment for the entire file,
 * which would conflict with the real-filesystem tests in binding-loader.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be hoisted — this replaces node:fs for ALL imports in this test module,
// including the binding-loader.ts import below.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual };
});

// Import AFTER vi.mock so binding-loader picks up the mocked fs
import { BindingLoader, BindingLoadError } from '../src/binding-loader.js';

describe('BindingLoader — file size limit (D11-006)', () => {
  let tmpDir: string;
  let loader: BindingLoader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bl-size-'));
    loader = new BindingLoader();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws BindingLoadError when a file stat reports size > 16 MiB', async () => {
    const f = join(tmpDir, 'big.binding.yaml');
    writeFileSync(f, 'bindings: []\n');

    const fsModule = await import('node:fs');
    const actualStatSync = vi.importActual<typeof import('node:fs')>;
    // Wrap statSync to return an oversized stat for our file
    const origStat = fsModule.statSync;
    vi.spyOn(fsModule, 'statSync').mockImplementation(((
      p: Parameters<typeof fsModule.statSync>[0],
      opts?: Parameters<typeof fsModule.statSync>[1],
    ) => {
      const real = origStat(p, opts as Parameters<typeof fsModule.statSync>[1]);
      if (String(p) === f) {
        // Return a stat-like object with size > 16 MiB
        return Object.setPrototypeOf(
          { ...real, size: 17 * 1024 * 1024 },
          Object.getPrototypeOf(real) as object,
        ) as ReturnType<typeof fsModule.statSync>;
      }
      return real;
    }) as typeof fsModule.statSync);

    expect(() => loader.load(f)).toThrow(BindingLoadError);
    try {
      loader.load(f);
    } catch (exc) {
      expect(exc).toBeInstanceOf(BindingLoadError);
      expect((exc as BindingLoadError).message).toMatch(/too large|size/i);
    }
  });
});

describe('BindingLoader — file count limit (D11-006)', () => {
  let tmpDir: string;
  let loader: BindingLoader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bl-count-'));
    loader = new BindingLoader();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws BindingLoadError when directory has more than 10,000 .binding.yaml files', async () => {
    const fsModule = await import('node:fs');
    const origReaddir = fsModule.readdirSync;
    const origStat = fsModule.statSync;
    const fakeNames = Array.from({ length: 10001 }, (_, i) => `f${i}.binding.yaml`);
    const fakePaths = new Set(fakeNames.map((n) => join(tmpDir, n)));

    // Both branches now read with { withFileTypes: true } and resolve each
    // entry's type with a *following* statSync, so a directory whose name
    // matches is never a candidate. The fake supplies both halves.
    vi.spyOn(fsModule, 'readdirSync').mockImplementation(((
      p: Parameters<typeof fsModule.readdirSync>[0],
      opts?: Parameters<typeof fsModule.readdirSync>[1],
    ) => {
      if (
        String(p) === tmpDir &&
        typeof opts === 'object' &&
        opts !== null &&
        (opts as { withFileTypes?: boolean }).withFileTypes === true
      ) {
        return fakeNames.map((name) => ({
          name,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        })) as unknown as ReturnType<typeof fsModule.readdirSync>;
      }
      return (origReaddir as typeof fsModule.readdirSync)(
        p,
        opts as Parameters<typeof fsModule.readdirSync>[1],
      );
    }) as typeof fsModule.readdirSync);

    vi.spyOn(fsModule, 'statSync').mockImplementation(((
      p: Parameters<typeof fsModule.statSync>[0],
      opts?: Parameters<typeof fsModule.statSync>[1],
    ) => {
      if (fakePaths.has(String(p))) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: 16,
        } as unknown as ReturnType<typeof fsModule.statSync>;
      }
      return (origStat as typeof fsModule.statSync)(
        p,
        opts as Parameters<typeof fsModule.statSync>[1],
      );
    }) as typeof fsModule.statSync);

    expect(() => loader.load(tmpDir)).toThrow(BindingLoadError);
    try {
      loader.load(tmpDir);
    } catch (exc) {
      expect(exc).toBeInstanceOf(BindingLoadError);
      expect((exc as BindingLoadError).message).toMatch(/too many|files/i);
    }
  });

  // A-D-013 — the recursive branch must enforce MAX_BINDING_FILES_PER_DIR
  // too. Earlier, only the non-recursive branch checked the cap, so a
  // recursive load with > 10_000 files would silently succeed and pin
  // memory.
  it('throws BindingLoadError when recursive scan yields more than 10,000 files', async () => {
    const fsModule = await import('node:fs');
    const origReaddir = fsModule.readdirSync;
    const origStat = fsModule.statSync;
    const fakeNames = Array.from({ length: 10001 }, (_, i) => `f${i}.binding.yaml`);
    const fakePaths = new Set(fakeNames.map((n) => join(tmpDir, n)));

    // Entry type comes from a following statSync, not Dirent.isFile(), so the
    // fabricated names need stats as well as Dirents.
    vi.spyOn(fsModule, 'statSync').mockImplementation(((
      p: Parameters<typeof fsModule.statSync>[0],
      opts?: Parameters<typeof fsModule.statSync>[1],
    ) => {
      if (fakePaths.has(String(p))) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: 16,
        } as unknown as ReturnType<typeof fsModule.statSync>;
      }
      return (origStat as typeof fsModule.statSync)(
        p,
        opts as Parameters<typeof fsModule.statSync>[1],
      );
    }) as typeof fsModule.statSync);

    vi.spyOn(fsModule, 'readdirSync').mockImplementation(((
      p: Parameters<typeof fsModule.readdirSync>[0],
      opts?: Parameters<typeof fsModule.readdirSync>[1],
    ) => {
      // The recursive branch calls readdirSync(dir, { withFileTypes: true }).
      // Return Dirent-like entries for our names; the loader decides their
      // type from the stubbed statSync above, not from these predicates.
      if (
        String(p) === tmpDir &&
        opts !== undefined &&
        typeof opts === 'object' &&
        (opts as { withFileTypes?: boolean }).withFileTypes === true
      ) {
        const dirents = fakeNames.map((name) => ({
          name,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        }));
        return dirents as unknown as ReturnType<typeof fsModule.readdirSync>;
      }
      return (origReaddir as typeof fsModule.readdirSync)(
        p,
        opts as Parameters<typeof fsModule.readdirSync>[1],
      );
    }) as typeof fsModule.readdirSync);

    expect(() => loader.load(tmpDir, false, true)).toThrow(BindingLoadError);
    try {
      loader.load(tmpDir, false, true);
    } catch (exc) {
      expect(exc).toBeInstanceOf(BindingLoadError);
      expect((exc as BindingLoadError).message).toMatch(/too many|files/i);
    }
  });
});
