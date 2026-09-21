// Unit tests for FileTokenStore — the two properties the spec makes
// normative (`0600` at creation, atomic replace) plus the refusal to read a
// credentials file other local users can see.
//
// Spec: apcore-toolkit/docs/features/device-auth.md, sections
// "`FileTokenStore` path" and "File permissions".

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every rename the store performed, as [from, to]. Populated by the
// pass-through spy below: the atomic-replace property is about HOW the file
// is written, which no amount of inspecting the result can prove.
const renames: [string, string][] = [];
let onBeforeRename: ((from: string) => void) | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      onBeforeRename?.(from);
      renames.push([from, to]);
      return actual.rename(from, to);
    },
  };
});

import {
  CredentialPermissionError,
  FileTokenStore,
  TokenSet,
  defaultCredentialsPath,
  makeStoreKey,
} from '../src/index.js';

const POSIX = process.platform !== 'win32';
const KEY = makeStoreKey('https://auth.example.com', 'apcore-cli');

const dirs: string[] = [];

function makeStore(): { store: FileTokenStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apcore-token-store-'));
  dirs.push(dir);
  const path = join(dir, 'credentials.json');
  return { store: new FileTokenStore({ path }), dir, path };
}

function sampleTokens(accessToken = 'access-value'): TokenSet {
  return new TokenSet({
    accessToken,
    tokenType: 'Bearer',
    expiresAt: 4600,
    refreshToken: 'refresh-value',
    scope: ['openid'],
    obtainedAt: 1000,
  });
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('FileTokenStore — permissions', () => {
  it.skipIf(!POSIX)('creates the credentials file with mode 0600', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('keeps mode 0600 across a rewrite', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens('first'));
    await store.save(KEY, sampleTokens('second'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('creates the containing directory with mode 0700', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'apcore-token-store-parent-'));
    dirs.push(parent);
    const store = new FileTokenStore({ path: join(parent, 'nested', 'credentials.json') });
    await store.save(KEY, sampleTokens());
    expect(statSync(join(parent, 'nested')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!POSIX)('refuses to read a world-readable credentials file', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    chmodSync(path, 0o644);
    await expect(store.load(KEY)).rejects.toBeInstanceOf(CredentialPermissionError);
  });

  it.skipIf(!POSIX)('refuses group-readable too, and names the file in the error', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    chmodSync(path, 0o640);
    await expect(store.load(KEY)).rejects.toThrow(new RegExp(`chmod 600 ${path}`));
  });

  it.skipIf(!POSIX)('refuses on save as well as on load — never silently overwrites', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    chmodSync(path, 0o666);
    await expect(store.save(KEY, sampleTokens('other'))).rejects.toBeInstanceOf(
      CredentialPermissionError,
    );
  });

  it.skipIf(!POSIX)('accepts a stricter mode than 0600', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    chmodSync(path, 0o400);
    const loaded = await store.load(KEY);
    expect(loaded?.accessToken).toBe('access-value');
  });
});

describe('FileTokenStore — atomic replace', () => {
  it('replaces the file rather than writing in place', async () => {
    // A rename produces a new inode; an in-place rewrite keeps the old one.
    // That difference is what makes a concurrent reader see either the old
    // credential or the new one, never a half-written file.
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens('first'));
    const before = statSync(path).ino;
    await store.save(KEY, sampleTokens('second'));
    const after = statSync(path).ino;
    expect(after).not.toBe(before);
    expect((await store.load(KEY))?.accessToken).toBe('second');
  });

  it('leaves no temp file behind', async () => {
    const { store, dir } = makeStore();
    await store.save(KEY, sampleTokens());
    await store.save(KEY, sampleTokens('again'));
    await store.clear(KEY);
    expect(readdirSync(dir)).toEqual(['credentials.json']);
  });

  it('writes the temp file in the same directory as the target, then renames', async () => {
    // Same directory is what makes the rename a same-filesystem atomic
    // operation. A temp file in the OS temp dir can land on another mount,
    // where rename degrades to copy-then-delete and stops being atomic.
    renames.length = 0;
    const { store, dir, path } = makeStore();
    await store.save(KEY, sampleTokens());
    expect(renames.length, 'save must go through a rename').toBe(1);
    const [from, to] = renames[0];
    expect(to).toBe(path);
    expect(dirname(from)).toBe(dir);
    expect(from).not.toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it('creates the temp file with 0600 too, so the window is never world-readable', async () => {
    // The mode is passed at open time rather than chmod'd afterwards; a
    // create-then-chmod sequence leaves a window in which the file is
    // readable by anyone, and the temp file holds the same secret.
    renames.length = 0;
    const { store } = makeStore();
    let tempMode: number | null = null;
    onBeforeRename = (from) => {
      tempMode = POSIX ? statSync(from).mode & 0o777 : 0o600;
    };
    try {
      await store.save(KEY, sampleTokens());
    } finally {
      onBeforeRename = null;
    }
    expect(tempMode).toBe(0o600);
  });
});

describe('FileTokenStore — record handling', () => {
  it('returns null for a missing file', async () => {
    const { store } = makeStore();
    expect(await store.load(KEY)).toBeNull();
  });

  it('returns null for a key that is not present', async () => {
    const { store } = makeStore();
    await store.save(KEY, sampleTokens());
    expect(await store.load(makeStoreKey('https://other.example', 'cli'))).toBeNull();
  });

  it('keeps credentials for several authorization servers side by side', async () => {
    const { store, path } = makeStore();
    const a = makeStoreKey('https://a.example', 'cli');
    const b = makeStoreKey('https://b.example', 'cli');
    await store.save(a, sampleTokens('token-a'));
    await store.save(b, sampleTokens('token-b'));
    expect((await store.load(a))?.accessToken).toBe('token-a');
    expect((await store.load(b))?.accessToken).toBe('token-b');
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object).sort()).toEqual([a, b]);
  });

  it('never persists a device_code — only the TokenSet record', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('device_code');
    expect(Object.keys(JSON.parse(raw)[KEY] as object).sort()).toEqual([
      'accessToken',
      'expiresAt',
      'obtainedAt',
      'refreshToken',
      'scope',
      'tokenType',
    ]);
  });

  it('round-trips every field', async () => {
    const { store } = makeStore();
    await store.save(KEY, sampleTokens());
    const loaded = await store.load(KEY);
    expect(loaded?.accessToken).toBe('access-value');
    expect(loaded?.refreshToken).toBe('refresh-value');
    expect(loaded?.tokenType).toBe('Bearer');
    expect(loaded?.expiresAt).toBe(4600);
    expect([...(loaded?.scope ?? [])]).toEqual(['openid']);
    expect(loaded?.obtainedAt).toBe(1000);
  });

  it('clears idempotently, including a key that was never stored', async () => {
    const { store } = makeStore();
    await expect(store.clear(KEY)).resolves.toBeUndefined();
    await store.save(KEY, sampleTokens());
    await store.clear(KEY);
    await expect(store.clear(KEY)).resolves.toBeUndefined();
    expect(await store.load(KEY)).toBeNull();
  });

  it('clearing one key leaves the others intact', async () => {
    const { store } = makeStore();
    const a = makeStoreKey('https://a.example', 'cli');
    const b = makeStoreKey('https://b.example', 'cli');
    await store.save(a, sampleTokens('token-a'));
    await store.save(b, sampleTokens('token-b'));
    await store.clear(a);
    expect(await store.load(a)).toBeNull();
    expect((await store.load(b))?.accessToken).toBe('token-b');
  });

  it('treats a corrupt file as empty rather than refusing to start', async () => {
    const { store, path } = makeStore();
    await store.save(KEY, sampleTokens());
    writeFileSync(path, '{not json', { mode: 0o600 });
    expect(await store.load(KEY)).toBeNull();
  });
});

describe('defaultCredentialsPath', () => {
  it.skipIf(!POSIX)('honours XDG_CONFIG_HOME, then falls back to ~/.config', () => {
    const original = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      expect(defaultCredentialsPath()).toBe('/custom/config/apcore/credentials.json');
      delete process.env.XDG_CONFIG_HOME;
      // macOS deliberately uses the XDG-style path too, not
      // ~/Library/Application Support, so one location serves every platform.
      expect(defaultCredentialsPath()).toMatch(/\.config[/\\]apcore[/\\]credentials\.json$/);
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
    }
  });

  it('ends in apcore/credentials.json on every platform', () => {
    expect(defaultCredentialsPath()).toMatch(/apcore[/\\]credentials\.json$/);
  });
});
