/**
 * `TokenSet` — the credential a grant produces.
 *
 * Grant-independent: the device-code grant is the only one that ships in
 * V1, but nothing here knows that. See "TokenSet" and "Grant Pluggability"
 * in `apcore-toolkit/docs/features/device-auth.md`.
 *
 * The access token is treated as **opaque**. It is never decoded, and its
 * `exp`, `sub`, and `roles` are never read: a client that parses its own
 * JWT and builds an identity from the unverified payload has produced a
 * self-asserted claim wearing the costume of a verified one. Expiry comes
 * from the token response's `expires_in`, nothing else.
 */

import { AuthorizationProtocolError } from './errors.js';
import {
  WireField,
  readScope,
  readSeconds,
  readString,
  type WireBody,
} from './wire.js';

/** What `toString()` and `util.inspect` print in place of a secret. */
export const REDACTED = '<redacted>';

/** Default expiry skew, in seconds. */
export const DEFAULT_SKEW_SECONDS = 30;

/** Node's `util.inspect` custom-formatter key, reached without importing `node:util`. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/** Wall-clock seconds since the Unix epoch. */
export type WallClock = () => number;

/** Default wall clock: whole Unix seconds. */
export const systemWallClock: WallClock = () => Math.floor(Date.now() / 1000);

/** The persisted, snake_case-free record form of a {@link TokenSet}. */
export interface TokenSetRecord {
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  refreshToken: string | null;
  scope: string[];
  obtainedAt: number;
}

/** Options accepted by {@link TokenSet.isExpired}. */
export interface IsExpiredOptions {
  /** Seconds of slack. Default 30 — a token about to expire counts as expired. */
  skewSeconds?: number;
  /** Injectable wall clock, for tests. */
  now?: WallClock;
}

function normaliseTokenType(raw: string | null): string {
  // Servers vary between `Bearer` and `bearer`; RFC 6749 makes the type
  // case-insensitive. Only the Bearer casing is normalised — an exotic
  // token type passes through as the server spelled it.
  if (raw === null || raw === '') return 'Bearer';
  return raw.toLowerCase() === 'bearer' ? 'Bearer' : raw;
}

/**
 * An access token plus everything needed to know when it stops working.
 *
 * @example
 * ```ts
 * const tokens = await client.login();
 * if (!tokens.isExpired()) {
 *   await fetch(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
 * }
 * console.log(String(tokens)); // TokenSet(access_token=<redacted>, ...)
 * ```
 */
export class TokenSet {
  /** Opaque bearer credential. Never parsed, never logged. */
  readonly accessToken: string;
  /** Normalised to `Bearer` casing on read. */
  readonly tokenType: string;
  /**
   * Absolute Unix-seconds instant, or `null` when the server stated no
   * lifetime. Stored absolute rather than as a duration because a duration
   * is meaningless after a process restart.
   */
  readonly expiresAt: number | null;
  /** `null` when the server issues none — common for short-lived scopes. */
  readonly refreshToken: string | null;
  /** Split on spaces per RFC 6749; empty when the response omits `scope`. */
  readonly scope: readonly string[];
  /** Wall-clock receipt time, for diagnostics and store-format migration. */
  readonly obtainedAt: number;

  constructor(record: TokenSetRecord) {
    this.accessToken = record.accessToken;
    this.tokenType = record.tokenType;
    this.expiresAt = record.expiresAt;
    this.refreshToken = record.refreshToken;
    this.scope = Object.freeze([...record.scope]);
    this.obtainedAt = record.obtainedAt;
    Object.freeze(this);
  }

  /**
   * Build a `TokenSet` from a token-endpoint response body.
   *
   * `expiresAt` is computed as **wall-clock now + `expires_in`**, which is
   * the one place a wall clock is correct: it must survive a restart, and
   * a monotonic value cannot. (The polling deadline uses the opposite
   * clock, deliberately — see `DeviceCodeGrant`.)
   *
   * @param body   a field-normalised token response
   * @param rawBody the undecoded body, carried into any protocol error
   * @param wallClock wall-clock source, injectable for determinism
   */
  static fromTokenResponse(body: WireBody, rawBody: string, wallClock: WallClock): TokenSet {
    const accessToken = readString(body, WireField.ACCESS_TOKEN);
    if (accessToken === null || accessToken === '') {
      throw new AuthorizationProtocolError(
        'Token response carries no access_token',
        rawBody,
      );
    }
    const now = wallClock();
    const expiresIn = readSeconds(body, WireField.EXPIRES_IN);
    return new TokenSet({
      accessToken,
      tokenType: normaliseTokenType(readString(body, WireField.TOKEN_TYPE)),
      // Absent `expires_in` means "no stated expiry", which never
      // auto-expires — not "expires now".
      expiresAt: expiresIn === null ? null : now + expiresIn,
      refreshToken: readString(body, WireField.REFRESH_TOKEN),
      scope: readScope(body),
      obtainedAt: now,
    });
  }

  /**
   * True when the token is expired, or close enough that a request made
   * with it could expire in flight.
   *
   * A token with no `expiresAt` never auto-expires.
   */
  isExpired(options: IsExpiredOptions = {}): boolean {
    if (this.expiresAt === null) return false;
    const skewSeconds = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;
    const now = (options.now ?? systemWallClock)();
    return now + skewSeconds >= this.expiresAt;
  }

  /** Plain-object form, for a {@link TokenStore} to persist. Not redacted. */
  toRecord(): TokenSetRecord {
    return {
      accessToken: this.accessToken,
      tokenType: this.tokenType,
      expiresAt: this.expiresAt,
      refreshToken: this.refreshToken,
      scope: [...this.scope],
      obtainedAt: this.obtainedAt,
    };
  }

  /** Rebuild from {@link toRecord} output; returns `null` for an unusable record. */
  static fromRecord(record: unknown): TokenSet | null {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
    const r = record as Partial<TokenSetRecord>;
    if (typeof r.accessToken !== 'string' || r.accessToken === '') return null;
    return new TokenSet({
      accessToken: r.accessToken,
      tokenType: normaliseTokenType(typeof r.tokenType === 'string' ? r.tokenType : null),
      expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
      refreshToken: typeof r.refreshToken === 'string' ? r.refreshToken : null,
      scope: Array.isArray(r.scope) ? r.scope.filter((s): s is string => typeof s === 'string') : [],
      obtainedAt: typeof r.obtainedAt === 'number' ? r.obtainedAt : 0,
    });
  }

  /**
   * Redacted debug string. Contains neither token value.
   *
   * A leaked debug log is the most common way CLI credentials escape, so
   * this is a spec requirement asserted by conformance case 020, not a
   * suggestion.
   */
  toString(): string {
    return (
      `TokenSet(access_token=${REDACTED}, token_type=${this.tokenType}, `
      + `expires_at=${this.expiresAt === null ? 'null' : String(this.expiresAt)}, `
      + `refresh_token=${this.refreshToken === null ? 'null' : REDACTED}, `
      + `scope=[${this.scope.join(' ')}], obtained_at=${String(this.obtainedAt)})`
    );
  }

  /**
   * `console.log(tokenSet)` in Node does NOT call `toString()` — it calls
   * `util.inspect`, which would happily print every field. This hook is
   * what actually keeps the token out of a developer's terminal.
   */
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }

  /**
   * `JSON.stringify` redacts too, so a `TokenSet` swept into a structured
   * log line cannot leak. Persistence goes through {@link toRecord}, which
   * is explicit about handling the real values.
   */
  toJSON(): Record<string, unknown> {
    return {
      access_token: REDACTED,
      token_type: this.tokenType,
      expires_at: this.expiresAt,
      refresh_token: this.refreshToken === null ? null : REDACTED,
      scope: [...this.scope],
      obtained_at: this.obtainedAt,
    };
  }
}
