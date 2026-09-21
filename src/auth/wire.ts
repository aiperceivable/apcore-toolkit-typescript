/**
 * The wire boundary: snake_case in, camelCase out — in one place.
 *
 * OAuth is a snake_case protocol and the conformance corpus is written in
 * snake_case; this SDK's public API is camelCase. Every read of a provider
 * response and every write of a request body goes through this module, so
 * the two spellings never meet anywhere else.
 *
 * This file exists because of a bug this repository already shipped once:
 * `TuiViewModel` looked up a camelCase property on a snake_case source, the
 * lookup silently returned `undefined`, and the filter it fed dropped every
 * row. Nothing threw. The rule that prevents a repeat is mechanical — no
 * module outside `wire.ts` may index a parsed provider body with a literal
 * key, and the accepted-name lists below are the only place a wire spelling
 * is written down.
 *
 * Normative sections: "Field-name normalisation", "Error identifier
 * normalisation", "Response-encoding differences", "Request body encoding"
 * of `apcore-toolkit/docs/features/device-auth.md`.
 */

import { AuthorizationProtocolError } from './errors.js';

// ---------------------------------------------------------------------------
// Wire field names — the ONLY place these spellings appear.
// ---------------------------------------------------------------------------

/** Wire field names read from, or written to, a provider. */
export const WireField = {
  ACCESS_TOKEN: 'access_token',
  TOKEN_TYPE: 'token_type',
  EXPIRES_IN: 'expires_in',
  REFRESH_TOKEN: 'refresh_token',
  SCOPE: 'scope',
  DEVICE_CODE: 'device_code',
  USER_CODE: 'user_code',
  VERIFICATION_URI: 'verification_uri',
  VERIFICATION_URI_COMPLETE: 'verification_uri_complete',
  INTERVAL: 'interval',
  ERROR: 'error',
  ERROR_DESCRIPTION: 'error_description',
  CLIENT_ID: 'client_id',
  CLIENT_SECRET: 'client_secret',
  GRANT_TYPE: 'grant_type',
  TOKEN: 'token',
  ISSUER: 'issuer',
  DEVICE_AUTHORIZATION_ENDPOINT: 'device_authorization_endpoint',
  TOKEN_ENDPOINT: 'token_endpoint',
  REVOCATION_ENDPOINT: 'revocation_endpoint',
  GRANT_TYPES_SUPPORTED: 'grant_types_supported',
} as const;

/** RFC 8628 device-code grant type, sent verbatim on every token request. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 6749 refresh grant type. */
export const REFRESH_TOKEN_GRANT_TYPE = 'refresh_token';

/**
 * Built-in accepted names per logical field, standard spelling first.
 *
 * A provider returning `verification_url` (no `i`) is otherwise perfectly
 * conforming; a parser bound to the RFC spelling reads null and shows the
 * user a blank URL at the one step they must act on.
 */
export const BUILTIN_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [WireField.VERIFICATION_URI]: Object.freeze(['verification_uri', 'verification_url']),
  [WireField.VERIFICATION_URI_COMPLETE]: Object.freeze([
    'verification_uri_complete',
    'verification_url_complete',
  ]),
  [WireField.ERROR]: Object.freeze(['error', 'error_code']),
});

/** The four RFC 8628 error identifiers the state machine dispatches on. */
export const STANDARD_ERROR_IDENTIFIERS = Object.freeze([
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
] as const);

/** One of the four identifiers the state machine has a branch for. */
export type StandardErrorIdentifier = (typeof STANDARD_ERROR_IDENTIFIERS)[number];

/** RFC 6749 identifier for a spent, revoked, or malformed grant. */
export const INVALID_GRANT = 'invalid_grant';

/** True when `value` is one of the four RFC 8628 identifiers. */
export function isStandardErrorIdentifier(value: unknown): value is StandardErrorIdentifier {
  return (
    typeof value === 'string'
    && (STANDARD_ERROR_IDENTIFIERS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

/** A decoded provider body: raw wire keys, values untouched. */
export type WireBody = Record<string, unknown>;

function asPlainObject(value: unknown): WireBody | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as WireBody;
}

function tryJsonObject(rawBody: string): WireBody | null {
  const trimmed = rawBody.trim();
  if (trimmed === '') return null;
  try {
    return asPlainObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Parse an `application/x-www-form-urlencoded` body.
 *
 * Returns `null` for a body carrying no `=` at all, so an HTML document
 * cannot masquerade as a single-key form (the discovery SPA trap, case 053).
 * Values stay strings — no numeric coercion — which is what case 022 asserts.
 */
function tryFormBody(rawBody: string): WireBody | null {
  const trimmed = rawBody.trim();
  if (trimmed === '' || !trimmed.includes('=')) return null;
  const out: WireBody = {};
  for (const [key, value] of new URLSearchParams(trimmed)) {
    if (key === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Decode a response body into a wire mapping.
 *
 * The client sends `Accept: application/json`, but some providers return
 * form-urlencoded regardless, so form is a fallback rather than an error.
 * Returns `null` when the body decodes to nothing usable — the caller turns
 * that into a protocol error carrying the raw body, never a crash.
 */
export function decodeBody(contentType: string | null | undefined, rawBody: string): WireBody | null {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return tryJsonObject(rawBody);
  if (ct.includes('form-urlencoded')) return tryFormBody(rawBody);
  // No usable content type: try the RFC's encoding first, then the fallback.
  return tryJsonObject(rawBody) ?? tryFormBody(rawBody);
}

// ---------------------------------------------------------------------------
// Field-name normalisation
// ---------------------------------------------------------------------------

/**
 * Merge configured alias lists onto the built-ins.
 *
 * The standard spelling always stays first, so a conforming provider is
 * unaffected by any amount of alias configuration.
 */
export function mergeFieldAliases(
  extra?: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = {};
  for (const [logical, names] of Object.entries(BUILTIN_FIELD_ALIASES)) {
    merged[logical] = [...names];
  }
  for (const [logical, names] of Object.entries(extra ?? {})) {
    const base = merged[logical] ?? [logical];
    const seen = new Set(base);
    const appended = [...base];
    for (const name of names) {
      if (!seen.has(name)) {
        seen.add(name);
        appended.push(name);
      }
    }
    merged[logical] = appended;
  }
  return merged;
}

/**
 * Rewrite aliased field names onto their standard spelling.
 *
 * Every other key passes through untouched: unknown fields MUST be ignored,
 * never rejected (case 037). A provider adding a localised prompt or a
 * creation timestamp is functioning normally, not misbehaving.
 */
export function normaliseFields(
  body: WireBody,
  aliases: Readonly<Record<string, readonly string[]>>,
): WireBody {
  const out: WireBody = { ...body };
  for (const [logical, names] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(out, logical)) continue;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(body, name)) {
        out[logical] = body[name];
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed readers — the only sanctioned way to pull a value out of a WireBody.
// ---------------------------------------------------------------------------

/** Read a string field, or `null` when absent or not a string. */
export function readString(body: WireBody, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Read a field that should be a count of seconds.
 *
 * Accepts a JSON number and the string a form-encoded body produces, since
 * the same field arrives as either depending on the response encoding.
 * Non-finite and negative values are rejected as absent.
 */
export function readSeconds(body: WireBody, field: string): number | null {
  const value = body[field];
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Split a scope string on spaces per RFC 6749; an absent scope is `[]`.
 *
 * The *request* side may use a non-space `scopeSeparator` for providers that
 * demand one, but the response side follows the RFC.
 */
export function readScope(body: WireBody): string[] {
  const raw = body[WireField.SCOPE];
  if (typeof raw === 'string') return raw.split(' ').filter((s) => s !== '');
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

/**
 * Read the error identifier, trying each accepted name in order.
 *
 * Returns the provider's own spelling — aliasing and classification happen
 * later, in the order the hook contract fixes.
 */
export function readErrorIdentifier(
  body: WireBody,
  aliases: Readonly<Record<string, readonly string[]>>,
): string | null {
  for (const name of aliases[WireField.ERROR] ?? [WireField.ERROR]) {
    const value = body[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device-authorization response
// ---------------------------------------------------------------------------

/** The device-authorization response, in this SDK's camelCase shape. */
export interface DeviceAuthorization {
  /** Short-lived pre-authorization secret. Never persisted to the store. */
  readonly deviceCode: string;
  /** Passed through byte-for-byte: never upper-cased, stripped, or re-grouped. */
  readonly userCode: string;
  /** Where the user must go to authorize. */
  readonly verificationUri: string;
  /** URI with the code embedded. Only one surveyed provider returns it. */
  readonly verificationUriComplete: string | null;
  /**
   * The **effective** lifetime in seconds — the server's `expires_in`, or the
   * client's fallback when the provider omits it (which is rare but real).
   *
   * Never null. The fallback is applied here, at parse time, rather than
   * later at the deadline calculation, so that `on_user_code` and the
   * polling loop are looking at the same number. A consumer rendering a
   * countdown has to be told when the client will actually give up, and a
   * null would force every consumer to reimplement the fallback — exactly
   * the per-CLI duplication this feature exists to remove.
   */
  readonly expiresIn: number;
  /** Server-stated poll interval in seconds, or `null` to use `defaultInterval`. */
  readonly interval: number | null;
}

/**
 * Build a {@link DeviceAuthorization} from an already field-normalised body.
 *
 * `device_code` and `verification_uri` are the only genuinely required
 * fields; `user_code` is required in practice because the flow is unusable
 * without it. Everything else has a defined fallback, because a
 * sparse-but-valid response is a normal provider difference, not an error.
 */
export function toDeviceAuthorization(
  body: WireBody,
  rawBody: string,
  fallbackExpirySeconds: number,
): DeviceAuthorization {
  const deviceCode = readString(body, WireField.DEVICE_CODE);
  const userCode = readString(body, WireField.USER_CODE);
  const verificationUri = readString(body, WireField.VERIFICATION_URI);
  const missing: string[] = [];
  if (deviceCode === null) missing.push(WireField.DEVICE_CODE);
  if (userCode === null) missing.push(WireField.USER_CODE);
  if (verificationUri === null) missing.push(WireField.VERIFICATION_URI);
  if (missing.length > 0) {
    throw new AuthorizationProtocolError(
      `Device authorization response is missing required field(s): ${missing.join(', ')}`,
      rawBody,
    );
  }
  return {
    deviceCode: deviceCode as string,
    userCode: userCode as string,
    verificationUri: verificationUri as string,
    verificationUriComplete: readString(body, WireField.VERIFICATION_URI_COMPLETE),
    // Fallback applied here so every downstream reader — the callback and
    // the deadline alike — sees one effective number.
    expiresIn: readSeconds(body, WireField.EXPIRES_IN) ?? fallbackExpirySeconds,
    interval: readSeconds(body, WireField.INTERVAL),
  };
}
