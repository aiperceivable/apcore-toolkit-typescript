/**
 * Request construction and the HTTP seam.
 *
 * Two layers, deliberately:
 *
 * - {@link AuthTransport} is what the grant talks to. It takes a request
 *   kind, a params mapping, and headers, and returns a status, a content
 *   type, and a raw body. The polling state machine is pure over this plus
 *   an injected clock — which is why the conformance corpus needs **no
 *   HTTP mocking at all**: a harness scripts an `AuthTransport`, not a
 *   `fetch`.
 * - {@link FetchAuthTransport} is the default implementation, built on the
 *   same injected-`fetchImpl` pattern `HTTPProxyRegistryWriter` already
 *   uses in this repository (`src/output/http-proxy-writer.ts`). That is
 *   the `http_client` hook from the spec, spelled the way TypeScript
 *   already spells it here.
 *
 * Everything a provider sees on the wire is built here, in snake_case;
 * see `wire.ts` for why the boundary is kept in one place.
 */

import type { DeviceAuthConfig, RequestEncoding, RequestKind } from './config.js';
import { AuthTransportError } from './errors.js';
import { WireField } from './wire.js';

/** A request the grant wants performed. */
export interface AuthRequest {
  /** Which of the four request kinds this is. */
  kind: RequestKind;
  /** Absolute endpoint URL. Never reachable by a hook. */
  url: string;
  /** Wire-shaped, snake_case form fields. */
  params: Record<string, string>;
  /** Complete header map, including content type and any client auth. */
  headers: Record<string, string>;
  /** Body encoding chosen for this kind. */
  encoding: RequestEncoding;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** What a provider answered with, undecoded. */
export interface AuthResponse {
  /** Used for exactly one thing: success payload (2xx) versus error payload. */
  status: number;
  /** Response content type, or `null` when the provider sent none. */
  contentType: string | null;
  /** The body exactly as received, so a protocol error can carry it. */
  rawBody: string;
}

/**
 * How bytes travel. Transport is the layer hooks may replace freely —
 * proxies, mTLS, custom CAs, test doubles — because it carries no protocol
 * semantics.
 *
 * A transport signals a connection-level failure by throwing
 * {@link AuthTransportError}; the state machine retries those rather than
 * terminating, bounded by the flow deadline.
 */
export interface AuthTransport {
  send(request: AuthRequest): Promise<AuthResponse>;
}

/** Percent-encode a params mapping as `application/x-www-form-urlencoded`. */
function encodeForm(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.append(key, value);
  return search.toString();
}

/** Body plus the content type that describes it. */
export interface EncodedBody {
  body: string;
  contentType: string;
}

/**
 * Encode a params mapping for one request kind.
 *
 * RFC 6749 §4.1.3 specifies form-encoding and it is natural to hard-code
 * it — but one vendor's *single* token endpoint accepts form-encoded for
 * the code exchange and **JSON** for refresh on the same URL, which no
 * alias list can repair. Hence per-kind, never a global "uses JSON" flag.
 */
export function encodeBody(encoding: RequestEncoding, params: Record<string, string>): EncodedBody {
  if (encoding === 'json') {
    return { body: JSON.stringify(params), contentType: 'application/json' };
  }
  return {
    body: encodeForm(params),
    contentType: 'application/x-www-form-urlencoded',
  };
}

/**
 * Base64 without `node:buffer`, so this module stays runtime-neutral.
 *
 * `btoa` is a global on Node 20+ and in every browser, but it only accepts
 * latin-1; encoding to UTF-8 bytes first is what makes a non-ASCII client
 * secret work.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Unreserved per RFC 3986 §2.3 — everything else is percent-encoded. */
const FORM_UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * `application/x-www-form-urlencoded` encoding of a single value.
 *
 * RFC 6749 §2.3.1 requires the client identifier and secret to be encoded
 * this way **before** they are joined with a colon and base64'd for the
 * Basic scheme. Skipping it is invisible for an alphanumeric credential —
 * the conformance corpus's `cid`/`sec` are byte-identical either way — and
 * silently wrong for a secret containing `:`, `+`, a space, or anything
 * non-ASCII, which is exactly the credential a provider generates.
 *
 * Written out rather than delegated to `URLSearchParams` because the two
 * disagree on `*` and `~`, and this is a cross-SDK byte-equivalence
 * surface: this matches `urllib.parse.quote_plus` (space to `+`, `-._~`
 * literal).
 */
export function formUrlEncodeComponent(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (FORM_UNRESERVED.test(char)) out += char;
    else if (char === ' ') out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Apply the configured client-authentication method.
 *
 * RFC 8628 is written for public clients and it is tempting to assume no
 * client authentication is involved. Two realities contradict that: some
 * providers require `client_secret` in the device flow, and — the easy
 * half to miss — authentication can apply to the **device authorization
 * request** too, so a provider may reject an unauthenticated
 * `/device/authorize` with `invalid_client` long before any token request
 * happens. Credentials a provider does not need are ignored far more
 * gracefully than missing ones a provider does need, so this runs on both.
 */
function applyClientAuth(
  config: DeviceAuthConfig,
  params: Record<string, string>,
  headers: Record<string, string>,
): void {
  // `client_id` is present under every method, including `client_secret_basic`.
  params[WireField.CLIENT_ID] = config.clientId;
  if (config.clientAuthMethod === 'client_secret_post') {
    params[WireField.CLIENT_SECRET] = config.clientSecret as string;
    return;
  }
  if (config.clientAuthMethod === 'client_secret_basic') {
    // RFC 6749 §2.3.1: form-urlencode each half BEFORE joining and base64ing.
    const credentials =
      `${formUrlEncodeComponent(config.clientId)}:${formUrlEncodeComponent(config.clientSecret as string)}`;
    headers.Authorization = `Basic ${base64Utf8(credentials)}`;
  }
}

/** Which extra-params bag applies to a request kind. */
function extraParamsFor(config: DeviceAuthConfig, kind: RequestKind): Readonly<Record<string, string>> {
  if (kind === 'device') return config.extraDeviceParams;
  if (kind === 'token' || kind === 'refresh') return config.extraTokenParams;
  return {};
}

/**
 * Assemble the params and headers for one request, before hooks.
 *
 * `Accept: application/json` is mandatory rather than polite: some
 * providers return `application/x-www-form-urlencoded` unless the request
 * asks otherwise.
 */
export function buildRequestFields(
  config: DeviceAuthConfig,
  kind: RequestKind,
  base: Readonly<Record<string, string>>,
): { params: Record<string, string>; headers: Record<string, string> } {
  const params: Record<string, string> = { ...base, ...extraParamsFor(config, kind) };
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...config.extraHeaders,
  };
  applyClientAuth(config, params, headers);
  return { params, headers };
}

/** Join configured scopes with the configured separator; `null` when empty. */
export function encodeScope(config: DeviceAuthConfig): string | null {
  if (config.scope.length === 0) return null;
  return config.scope.join(config.scopeSeparator);
}

/**
 * The default {@link AuthTransport}: one `fetch` per request.
 *
 * @example
 * ```ts
 * const transport = new FetchAuthTransport(myProxyAwareFetch);
 * ```
 */
export class FetchAuthTransport implements AuthTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch | null) {
    const impl = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!impl) {
      throw new AuthTransportError(
        'FetchAuthTransport: global fetch is unavailable — pass `fetchImpl` explicitly or run on Node 20+.',
      );
    }
    this.fetchImpl = impl;
  }

  async send(request: AuthRequest): Promise<AuthResponse> {
    const { body, contentType } = encodeBody(request.encoding, request.params);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: { ...request.headers, 'Content-Type': contentType },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Connection reset, DNS failure, timeout: retryable, not terminal.
      throw new AuthTransportError(
        `HTTP transport error for ${request.kind} request: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (err) {
      throw new AuthTransportError(
        `Failed to read ${request.kind} response body: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      rawBody,
    };
  }
}
