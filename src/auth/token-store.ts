/**
 * The `TokenStore` protocol — the portable half of credential storage.
 *
 * The toolkit ships the protocol and a `0600` file implementation. OS
 * keychains are a consumer concern: macOS Keychain, Windows Credential
 * Manager, and Linux Secret Service have different semantics reached
 * through three unrelated libraries, and cross-language behavioural parity
 * — the property this repository's conformance corpus exists to enforce —
 * is not achievable there.
 *
 * See "Token Storage" and "Contract: TokenStore" in
 * `apcore-toolkit/docs/features/device-auth.md`.
 *
 * Runtime-neutral: this module imports nothing from Node, so it is safe in
 * the browser entry point. `FileTokenStore` lives in its own file and is
 * Node-only, the same split `BindingParser` / `BindingLoader` already use.
 */

import type { TokenSet } from './token-set.js';

/**
 * Where a {@link TokenSet} is kept between invocations.
 *
 * A consumer wanting an OS keychain implements this; the flow neither
 * knows nor cares which store it was handed.
 *
 * @example
 * ```ts
 * class MemoryTokenStore implements TokenStore {
 *   private readonly records = new Map<string, TokenSet>();
 *   async load(key: string) { return this.records.get(key) ?? null; }
 *   async save(key: string, tokens: TokenSet) { this.records.set(key, tokens); }
 *   async clear(key: string) { this.records.delete(key); }
 * }
 * ```
 */
export interface TokenStore {
  /** Never throws on a missing store — returns `null`. */
  load(key: string): Promise<TokenSet | null>;
  /**
   * MUST be atomic (write-temp-then-rename) and MUST create with `0600`
   * on POSIX, at open time rather than by a later `chmod`.
   */
  save(key: string, tokens: TokenSet): Promise<void>;
  /** Idempotent — clearing an absent key is not an error. */
  clear(key: string): Promise<void>;
}

/**
 * Canonical store key: `"<issuer>|<client_id>"`.
 *
 * Keying on the issuer is what lets credentials for several authorization
 * servers coexist in one file, and it is also what the MCP authorization
 * specification requires of any client that will eventually speak it — so
 * that requirement is satisfied by construction rather than by a later
 * migration.
 */
export function makeStoreKey(issuer: string, clientId: string): string {
  return `${issuer}|${clientId}`;
}

/**
 * In-memory {@link TokenStore}. Nothing is persisted.
 *
 * The default when no store is configured: a flow that has nowhere to save
 * a credential still works for the length of the process, which is what a
 * test or a one-shot daemon wants.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly records = new Map<string, TokenSet>();

  async load(key: string): Promise<TokenSet | null> {
    return this.records.get(key) ?? null;
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    this.records.set(key, tokens);
  }

  async clear(key: string): Promise<void> {
    this.records.delete(key);
  }
}
