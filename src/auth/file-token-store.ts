/**
 * `FileTokenStore` — the portable, `0600`, atomically-replaced credential file.
 *
 * Node-only: it reads and writes the filesystem, so it is deliberately
 * absent from the `apcore-toolkit/browser` entry point, exactly as
 * `BindingLoader` is while `BindingParser` is not.
 *
 * This is not the lesser option to a keychain. The pattern the ecosystem
 * actually converged on is *keychain when available, `0600` file
 * otherwise* — a shipping CLI in this ecosystem falls back to a `0600`
 * file whenever the macOS Keychain refuses the write, which happens
 * routinely over SSH where the login keychain is locked. This is that
 * fallback half, owned properly.
 *
 * See "Token Storage", "`FileTokenStore` path", and "File permissions" in
 * `apcore-toolkit/docs/features/device-auth.md`.
 */

import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CredentialPermissionError } from './errors.js';
import { TokenSet } from './token-set.js';
import type { TokenStore } from './token-store.js';

/** Directory name used under the platform's config root. */
const APP_DIR = 'apcore';

/** File name used within {@link APP_DIR}. */
const CREDENTIALS_FILE = 'credentials.json';

/** Mode the credentials file is created with: owner read/write only. */
const OWNER_ONLY = 0o600;

/** Any bit outside owner read/write means somebody else can read it. */
const BROADER_THAN_OWNER = 0o077;

/**
 * The platform-conventional credentials path.
 *
 * | Platform | Path |
 * |---|---|
 * | Linux / BSD | `$XDG_CONFIG_HOME/apcore/credentials.json`, else `~/.config/apcore/credentials.json` |
 * | macOS | `~/.config/apcore/credentials.json` |
 * | Windows | `%APPDATA%\apcore\credentials.json` |
 *
 * macOS deliberately uses the XDG-style path rather than
 * `~/Library/Application Support`, so a developer's dotfile conventions
 * and any cross-platform tooling see one location. The path is normative
 * rather than per-SDK because other tools need to know it: `apexe`
 * maintains a list of credential-bearing paths and would otherwise have a
 * blind spot for exactly this file.
 */
export function defaultCredentialsPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData !== '') return join(appData, APP_DIR, CREDENTIALS_FILE);
    return join(homedir(), 'AppData', 'Roaming', APP_DIR, CREDENTIALS_FILE);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '') return join(xdg, APP_DIR, CREDENTIALS_FILE);
  return join(homedir(), '.config', APP_DIR, CREDENTIALS_FILE);
}

/** Constructor options for {@link FileTokenStore}. */
export interface FileTokenStoreOptions {
  /** Override the credentials file location. Defaults to {@link defaultCredentialsPath}. */
  path?: string;
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * A JSON object keyed by `"<issuer>|<client_id>"`, so credentials for
 * multiple authorization servers coexist without collision.
 *
 * @example
 * ```ts
 * const store = new FileTokenStore();
 * await store.save('https://auth.example.com|apcore-cli', tokens);
 * const restored = await store.load('https://auth.example.com|apcore-cli');
 * ```
 */
export class FileTokenStore implements TokenStore {
  /** Absolute path of the credentials file this store reads and writes. */
  readonly path: string;

  constructor(options: FileTokenStoreOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath();
  }

  async load(key: string): Promise<TokenSet | null> {
    const records = await this.readAll();
    const record = records[key];
    if (record === undefined) return null;
    return TokenSet.fromRecord(record);
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    const records = await this.readAll();
    records[key] = tokens.toRecord() as unknown as Record<string, unknown>;
    await this.writeAll(records);
  }

  async clear(key: string): Promise<void> {
    const records = await this.readAll();
    if (!Object.prototype.hasOwnProperty.call(records, key)) return;
    delete records[key];
    await this.writeAll(records);
  }

  /**
   * Read every record, refusing a file other local users can read.
   *
   * A missing file is not an error — it is the ordinary state before the
   * first login. A file with broader permissions is: silently using a
   * credential that is world-readable is the failure this check exists to
   * prevent, so it surfaces an actionable error naming the file and the fix.
   */
  private async readAll(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      await this.assertOwnerOnly();
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (isMissing(err)) return {};
      throw err;
    }
    if (text.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A corrupt store is recoverable by logging in again; refusing to
      // start because of it is not an improvement.
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  }

  /** Throws {@link CredentialPermissionError} when the file is readable by anyone else. */
  private async assertOwnerOnly(): Promise<void> {
    if (process.platform === 'win32') return; // ACL-inherited from %APPDATA%.
    const info = await stat(this.path); // ENOENT propagates to the caller.
    if ((info.mode & BROADER_THAN_OWNER) !== 0) {
      throw new CredentialPermissionError(this.path, info.mode);
    }
  }

  /**
   * Atomic replace: create a temp file **in the same directory** with mode
   * `0600` at open time, write it, then `rename` over the target.
   *
   * Creating then `chmod`-ing would leave a window in which the file is
   * world-readable, and writing in place would let a concurrent reader
   * observe a half-written file. The rename is what makes a lost refresh
   * race cost a redundant re-login rather than a corrupted store.
   */
  private async writeAll(records: Record<string, unknown>): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify(records, null, 2)}\n`;

    // Same directory, so the rename is a same-filesystem atomic operation.
    // A random suffix keeps two concurrent writers off each other's temp file.
    const tmpPath = join(
      dir,
      `.${CREDENTIALS_FILE}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    // `wx` fails if the path exists, and the mode argument applies at
    // creation — there is no window during which the file is not 0600.
    const handle = await open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, OWNER_ONLY);
    try {
      await handle.writeFile(payload, 'utf8');
      // Flush before the rename so a crash cannot leave an empty file
      // where a valid credential used to be.
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, this.path);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

/** Convenience for tests: a store rooted in a fresh temp directory. */
export function temporaryCredentialsPath(prefix = 'apcore-credentials'): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2, 10)}`, CREDENTIALS_FILE);
}
