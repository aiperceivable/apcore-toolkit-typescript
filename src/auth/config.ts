/**
 * `DeviceAuthConfig` — the provider-compatibility surface.
 *
 * RFC 8628 fixes the *shape* of the flow, not the URLs, not the extra
 * parameters each vendor demands, and not the response encoding. **No
 * endpoint is hard-coded anywhere in this file, and no vendor is named.**
 * Every knob below exists because a real, widely-deployed provider needs
 * it; see the "Field Evidence" table in
 * `apcore-toolkit/docs/features/device-auth.md`, which is evidence rather
 * than configuration — it must never be turned into built-in profiles.
 *
 * Everything beyond `clientId` and a way to reach the endpoints has a
 * working default, so a conforming provider needs three lines while a
 * non-conforming one stays reachable without patching the toolkit.
 */

import { DeviceAuthConfigError, DiscoveryError } from './errors.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  WireField,
  isStandardErrorIdentifier,
  mergeFieldAliases,
  readString,
  STANDARD_ERROR_IDENTIFIERS,
  type StandardErrorIdentifier,
  type WireBody,
} from './wire.js';

/** Which request a setting applies to. Encoding is per-kind, never global. */
export type RequestKind = 'device' | 'token' | 'refresh' | 'revoke';

/** Body encoding for one request kind. */
export type RequestEncoding = 'form' | 'json';

/** How, and whether, the client authenticates itself. */
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** Every request kind, in a fixed order. */
export const REQUEST_KINDS: readonly RequestKind[] = Object.freeze([
  'device',
  'token',
  'refresh',
  'revoke',
]);

/** Default per-kind body encoding — the RFC's choice for all four. */
const DEFAULT_REQUEST_ENCODING: Readonly<Record<RequestKind, RequestEncoding>> = Object.freeze({
  device: 'form',
  token: 'form',
  // The one most likely to need `json`: one vendor's single token endpoint
  // takes form-encoded for the code exchange and JSON for refresh.
  refresh: 'form',
  revoke: 'form',
});

/** Fallback poll interval when the provider omits `interval`. */
export const DEFAULT_INTERVAL_SECONDS = 5;

/** Fallback flow deadline when the device response omits `expires_in`. */
export const DEFAULT_DEVICE_EXPIRY_SECONDS = 900;

/** Default per-request HTTP timeout, distinct from the flow deadline. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** RFC 8414 metadata suffix. */
const OAUTH_AS_SUFFIX = 'oauth-authorization-server';

/** OpenID Connect Discovery 1.0 metadata suffix. */
const OIDC_SUFFIX = 'openid-configuration';

/** Something worth telling the consumer that is not a failure. */
export interface DeviceAuthWarning {
  /** Stable identifier, safe to switch on. */
  code:
    | 'grant_type_unrecognised'
    | 'endpoint_origin_mismatch'
    | 'callback_failed';
  /** Human-readable text. The toolkit never prints it — that is the consumer's job. */
  message: string;
  /** Underlying error, when the warning came from a thrown one. */
  cause?: unknown;
}

/** Sink for {@link DeviceAuthWarning}s. The toolkit writes to no terminal. */
export type WarningSink = (warning: DeviceAuthWarning) => void;

/** What `transformRequest` returns. Either half may be omitted. */
export interface TransformedRequest {
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * The four extension hooks.
 *
 * Hooks may change what the client *understands*, never what it *decides*:
 * transport and serialisation are open, normalisation is open with a
 * constrained output, and the protocol-decision layer (dispatch, backoff,
 * deadline, expiry) plus credential construction are closed. That boundary
 * is what keeps the conformance corpus meaningful — an arbitrary callback
 * participating in protocol decisions would mean the fixtures no longer
 * describe what the client does.
 */
export interface DeviceAuthHooks {
  /**
   * Runs immediately before each outbound request, for values computed at
   * call time: a request signature, a nonce, a DPoP proof.
   *
   * Receives no URL and cannot change one — a hook able to redirect the
   * token request is a hook able to exfiltrate credentials. An exception
   * propagates and fails the flow; unlike the observational callbacks,
   * this hook is load-bearing.
   */
  transformRequest?: (
    kind: RequestKind,
    params: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
  ) => TransformedRequest | Promise<TransformedRequest>;

  /**
   * Runs before the built-in JSON / form parsers. Returning `null` means
   * "no opinion, use the default", so a hook can special-case one endpoint
   * and ignore the rest. The returned mapping must use standard field names.
   */
  parseResponse?: (
    kind: RequestKind,
    status: number,
    contentType: string | null,
    rawBody: string,
  ) => WireBody | null | Promise<WireBody | null>;

  /**
   * Runs after `errorAliases` and before dispatch, for the cases a static
   * map cannot express — a decision needing several fields, a nested error
   * object, or a status combined with a body field.
   *
   * MUST return one of the four RFC identifiers or `null`. Anything else is
   * a programming error and is rejected loudly (case 045): without that
   * check the hook becomes a back door into the closed protocol-decision
   * layer, able to invent a fifth state the state machine has no branch for.
   */
  classifyError?: (
    body: Readonly<WireBody>,
  ) => string | null | undefined | Promise<string | null | undefined>;
}

/** Everything {@link DeviceAuthConfig} accepts. */
export interface DeviceAuthConfigInit {
  /** Base URL for discovery. Required unless both endpoints are explicit. */
  issuer?: string;
  /** Explicit URL. Overrides any discovered value. */
  deviceAuthorizationEndpoint?: string;
  /** Explicit URL. Overrides any discovered value. */
  tokenEndpoint?: string;
  /** RFC 7009 revocation endpoint; absent for providers that do not implement it. */
  revocationEndpoint?: string;
  /** Public client identifier. Required. */
  clientId: string;
  /** Some providers run device flow as a confidential client. */
  clientSecret?: string;
  /** Default `none` — the RFC's public-client assumption. */
  clientAuthMethod?: ClientAuthMethod;
  /**
   * Optional per RFC 8628, but at least one surveyed provider rejects a
   * device request without it. A non-empty scope is the safer default.
   */
  scope?: readonly string[];
  /** RFC 6749 mandates a space; a minority of providers expect commas. */
  scopeSeparator?: string;
  /** Additional form fields on the device-authorization request. */
  extraDeviceParams?: Readonly<Record<string, string>>;
  /** Additional form fields on every token request. */
  extraTokenParams?: Readonly<Record<string, string>>;
  /**
   * Additional headers on every request — a mandatory dated API-version
   * header, an organisation selector. Not authentication, just as mandatory.
   */
  extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Maps provider error identifiers onto the RFC's four, applied before
   * dispatch. Values MUST be one of the four; an alias cannot invent a state.
   */
  errorAliases?: Readonly<Record<string, string>>;
  /** Extends the accepted response field-name lists, standard spelling first. */
  fieldAliases?: Readonly<Record<string, readonly string[]>>;
  /** Fallback when the provider omits `interval`. Default 5. */
  defaultInterval?: number;
  /** Per-request timeout, distinct from the flow deadline. */
  httpTimeoutMs?: number;
  /** Body encoding per request kind. Defaults to `form` for all four. */
  requestEncoding?: Partial<Record<RequestKind, RequestEncoding>>;
  /**
   * SDK-native HTTP client injection — proxies, custom CAs, mTLS, test
   * doubles. Matches the `fetchImpl` precedent `HTTPProxyRegistryWriter`
   * already sets in this repository.
   */
  fetchImpl?: typeof fetch;
  /** Where warnings go. The toolkit never prints them itself. */
  onWarning?: WarningSink;
  /** The four extension hooks. */
  hooks?: DeviceAuthHooks;
  /**
   * Credential type to header shape, as data rather than a code branch.
   *
   * The header carrying a token is not universally `Authorization: Bearer`
   * — `x-api-key` and `api-key` are both in live use, and one vendor
   * accepts both, choosing by *which kind of credential* is held. Override
   * this rather than reaching for an `if (provider === …)` ladder.
   */
  buildAuthHeaders?: (tokens: {
    accessToken: string;
    tokenType: string;
  }) => Record<string, string>;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') {
    throw new DeviceAuthConfigError(`DeviceAuthConfig: \`${field}\` is required and must be non-empty`);
  }
  return value;
}

/**
 * True for `https://`, and for `http://localhost` / loopback during
 * development. A plaintext token endpoint is refused at construction time
 * rather than at request time.
 */
function isAcceptableEndpoint(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith('https://')) return true;
  return (
    lower.startsWith('http://localhost')
    || lower.startsWith('http://127.0.0.1')
    || lower.startsWith('http://[::1]')
  );
}

function assertEndpoint(url: string | undefined, field: string): void {
  if (url === undefined) return;
  if (!isAcceptableEndpoint(url)) {
    throw new DeviceAuthConfigError(
      `DeviceAuthConfig: \`${field}\` must be https:// (http:// is allowed only for localhost) — got ${JSON.stringify(url)}`,
    );
  }
}

/**
 * Validate `errorAliases` at construction (conformance case 025).
 *
 * Aliases may map only **onto** the four standard identifiers. Allowing a
 * new target would let configuration introduce a state the state machine
 * has no branch for — the same back door `classifyError`'s return-value
 * check closes on the programmatic side.
 */
export function validateErrorAliases(
  aliases: Readonly<Record<string, string>>,
): asserts aliases is Readonly<Record<string, StandardErrorIdentifier>> {
  for (const [from, to] of Object.entries(aliases)) {
    if (!isStandardErrorIdentifier(to)) {
      throw new DeviceAuthConfigError(
        `DeviceAuthConfig: errorAliases[${JSON.stringify(from)}] maps onto `
          + `${JSON.stringify(to)}, which is not an RFC 8628 identifier. `
          + `Allowed targets: ${STANDARD_ERROR_IDENTIFIERS.join(', ')}.`,
      );
    }
  }
}

/**
 * Split an issuer into its scheme+authority and its path, **without**
 * `new URL()`.
 *
 * `new URL()` normalises — it lower-cases the host, drops a default port,
 * and can add a trailing slash — and the issuer comparison downstream is a
 * verbatim string comparison whose whole value is that it does none of
 * that. Reaching for a URL library here is the reflex this function exists
 * to avoid.
 */
function splitIssuer(issuer: string): { origin: string; path: string } {
  const schemeEnd = issuer.indexOf('://');
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = issuer.indexOf('/', authorityStart);
  if (pathStart === -1) return { origin: issuer, path: '' };
  return { origin: issuer.slice(0, pathStart), path: issuer.slice(pathStart) };
}

/**
 * The three well-known metadata URLs, in the order they are tried.
 *
 * 1. RFC 8414 path-**insertion** with the `oauth-authorization-server` suffix
 * 2. RFC 8414 path-insertion with the `openid-configuration` suffix
 * 3. OpenID Connect Discovery 1.0 **appending**
 *
 * The insertion-versus-append difference is a genuine incompatibility
 * between two specifications, not a vendor quirk, and it is invisible
 * until a tenant- or realm-scoped issuer appears — exactly the layout
 * multi-tenant providers use. For a bare issuer candidates 2 and 3 are
 * identical, which is why the bug hides.
 *
 * Duplicates are deliberately not removed: the corpus (case 028) asserts
 * three candidates.
 */
export function discoveryCandidates(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, '');
  const { origin, path } = splitIssuer(trimmed);
  return [
    `${origin}/.well-known/${OAUTH_AS_SUFFIX}${path}`,
    `${origin}/.well-known/${OIDC_SUFFIX}${path}`,
    `${trimmed}/.well-known/${OIDC_SUFFIX}`,
  ];
}

/**
 * Why a metadata document was rejected. A stable identifier rather than
 * prose, so the conformance corpus can assert it across three SDKs that
 * each phrase the message idiomatically.
 */
export type MetadataRejection = 'issuer_missing' | 'issuer_mismatch' | 'insecure_endpoint';

/** Outcome of examining one metadata document. */
export interface MetadataResolution {
  /** Whether the document is authoritative and usable. */
  accepted: boolean;
  /** Stable rejection identifier, when it was rejected. */
  reasonCode?: MetadataRejection;
  /** Human-readable detail, when it was rejected. */
  reason?: string;
  /** Endpoints taken from the document (before explicit config wins). */
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  /** Warnings raised while examining it. */
  warnings: DeviceAuthWarning[];
}

/**
 * Is the grant advertised?
 *
 * Permissive by design, and that permissiveness is load-bearing: one
 * surveyed provider advertises the bare `device_code` short name while
 * still requiring the full URN in the token request, and another omits
 * `grant_types_supported` entirely. A client matching only the URN
 * concludes "unsupported" and refuses to run against a provider that works
 * perfectly. Detection is advisory — it may produce a clearer message, but
 * it must never be the sole reason to refuse to start.
 */
function grantAdvertised(metadata: WireBody): 'yes' | 'unknown' | 'unrecognised' {
  const advertised = metadata[WireField.GRANT_TYPES_SUPPORTED];
  if (!Array.isArray(advertised)) return 'unknown';
  for (const entry of advertised) {
    if (entry === DEVICE_CODE_GRANT_TYPE || entry === 'device_code') return 'yes';
  }
  return 'unrecognised';
}

/**
 * Validate one metadata document against the issuer used to build its URL.
 *
 * Two security-relevant checks, both cheap:
 * - the document's `issuer` MUST equal the configured one, so a
 *   misconfigured or hostile metadata host cannot claim authority it does
 *   not have;
 * - the comparison is **verbatim**. No case folding, no default-port
 *   dropping, no trailing-slash reconciliation, no percent-encoding
 *   normalisation. A general-purpose "normalise URL" helper is exactly what
 *   an implementer reaches for here, and applying one weakens the check.
 */
export function resolveMetadata(issuer: string, metadata: WireBody): MetadataResolution {
  const warnings: DeviceAuthWarning[] = [];
  const documentIssuer = readString(metadata, WireField.ISSUER);
  if (documentIssuer === null) {
    return {
      accepted: false,
      reasonCode: 'issuer_missing',
      reason: 'metadata document carries no `issuer`',
      warnings,
    };
  }
  if (documentIssuer !== issuer) {
    return {
      accepted: false,
      reasonCode: 'issuer_mismatch',
      reason:
        `metadata \`issuer\` ${JSON.stringify(documentIssuer)} does not equal the configured issuer `
        + `${JSON.stringify(issuer)} (compared verbatim, deliberately)`,
      warnings,
    };
  }

  const deviceEndpoint = readString(metadata, WireField.DEVICE_AUTHORIZATION_ENDPOINT);
  const tokenEndpoint = readString(metadata, WireField.TOKEN_ENDPOINT);
  const revocationEndpoint = readString(metadata, WireField.REVOCATION_ENDPOINT);

  for (const [field, url] of [
    [WireField.DEVICE_AUTHORIZATION_ENDPOINT, deviceEndpoint],
    [WireField.TOKEN_ENDPOINT, tokenEndpoint],
    [WireField.REVOCATION_ENDPOINT, revocationEndpoint],
  ] as const) {
    if (url === null) continue;
    if (!isAcceptableEndpoint(url)) {
      // The hard half of the endpoint rule: plaintext is refused outright.
      // The soft half is the origin check below — a cross-origin https
      // endpoint is warned about and then followed, because real providers
      // host token endpoints on separate hosts and the document's authority
      // is already established by the issuer's own well-known path over TLS
      // plus the verbatim issuer comparison.
      return {
        accepted: false,
        reasonCode: 'insecure_endpoint',
        reason: `discovered \`${field}\` ${JSON.stringify(url)} is not https://`,
        warnings,
      };
    }
    // Endpoints SHOULD share the issuer's origin. The corpus (cases 029
    // and 030) accepts documents whose endpoints sit on another host, so
    // this is a warning rather than a rejection — see the note in the
    // conformance harness.
    if (!url.startsWith(`${splitIssuer(issuer).origin}/`)) {
      warnings.push({
        code: 'endpoint_origin_mismatch',
        message:
          `Discovered \`${field}\` ${JSON.stringify(url)} does not share the issuer's origin `
          + `${JSON.stringify(splitIssuer(issuer).origin)}.`,
      });
    }
  }

  if (grantAdvertised(metadata) === 'unrecognised') {
    warnings.push({
      code: 'grant_type_unrecognised',
      message:
        `Issuer ${JSON.stringify(issuer)} advertises \`grant_types_supported\` without either `
        + `${JSON.stringify(DEVICE_CODE_GRANT_TYPE)} or "device_code". Proceeding anyway: the `
        + "metadata may be incomplete, and the server's own rejection is more authoritative "
        + 'than a guess made from its advertisement.',
    });
  }

  return {
    accepted: true,
    deviceAuthorizationEndpoint: deviceEndpoint ?? undefined,
    tokenEndpoint: tokenEndpoint ?? undefined,
    revocationEndpoint: revocationEndpoint ?? undefined,
    warnings,
  };
}

/** Options for {@link DeviceAuthConfig.discover}. */
export interface DiscoverOptions {
  /** Overrides the configured `fetchImpl` for this call only. */
  fetchImpl?: typeof fetch;
}

/**
 * Immutable provider configuration.
 *
 * @example
 * ```ts
 * // (a) Discovery — endpoints resolved from the issuer's metadata.
 * let config = new DeviceAuthConfig({
 *   issuer: 'https://auth.example.com',
 *   clientId: 'apcore-cli',
 *   scope: ['openid', 'api.read'],
 * });
 * config = await config.discover(); // explicit network step, never implicit
 *
 * // (b) Explicit endpoints — anything set here beats a discovered value.
 * const explicit = new DeviceAuthConfig({
 *   deviceAuthorizationEndpoint: 'https://auth.example.com/device/code',
 *   tokenEndpoint: 'https://auth.example.com/token',
 *   clientId: 'apcore-cli',
 *   extraDeviceParams: { audience: 'https://api.example.com' },
 *   errorAliases: { pending: 'authorization_pending' },
 * });
 * ```
 */
export class DeviceAuthConfig {
  readonly issuer: string | null;
  readonly deviceAuthorizationEndpoint: string | null;
  readonly tokenEndpoint: string | null;
  readonly revocationEndpoint: string | null;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly clientAuthMethod: ClientAuthMethod;
  readonly scope: readonly string[];
  readonly scopeSeparator: string;
  readonly extraDeviceParams: Readonly<Record<string, string>>;
  readonly extraTokenParams: Readonly<Record<string, string>>;
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly errorAliases: Readonly<Record<string, StandardErrorIdentifier>>;
  /** Built-in lists merged with any configured extension, standard first. */
  readonly fieldAliases: Readonly<Record<string, readonly string[]>>;
  readonly defaultInterval: number;
  readonly httpTimeoutMs: number;
  readonly requestEncoding: Readonly<Record<RequestKind, RequestEncoding>>;
  readonly fetchImpl: typeof fetch | null;
  readonly onWarning: WarningSink | null;
  readonly hooks: Readonly<DeviceAuthHooks>;
  readonly buildAuthHeaders: (tokens: { accessToken: string; tokenType: string }) => Record<string, string>;
  /** The `init` this instance was built from, so `with()` can re-derive. */
  private readonly init: DeviceAuthConfigInit;

  constructor(init: DeviceAuthConfigInit) {
    this.init = init;
    this.clientId = requireNonEmpty(init.clientId, 'clientId');

    assertEndpoint(init.deviceAuthorizationEndpoint, 'deviceAuthorizationEndpoint');
    assertEndpoint(init.tokenEndpoint, 'tokenEndpoint');
    assertEndpoint(init.revocationEndpoint, 'revocationEndpoint');
    assertEndpoint(init.issuer, 'issuer');

    if (init.issuer === undefined && (init.deviceAuthorizationEndpoint === undefined || init.tokenEndpoint === undefined)) {
      throw new DeviceAuthConfigError(
        'DeviceAuthConfig: provide `issuer` (for discovery) or both '
          + '`deviceAuthorizationEndpoint` and `tokenEndpoint`.',
      );
    }

    const aliases = { ...(init.errorAliases ?? {}) };
    validateErrorAliases(aliases);
    this.errorAliases = Object.freeze(aliases);

    this.issuer = init.issuer ?? null;
    this.deviceAuthorizationEndpoint = init.deviceAuthorizationEndpoint ?? null;
    this.tokenEndpoint = init.tokenEndpoint ?? null;
    this.revocationEndpoint = init.revocationEndpoint ?? null;
    this.clientSecret = init.clientSecret ?? null;
    this.clientAuthMethod = init.clientAuthMethod ?? 'none';
    this.scope = Object.freeze([...(init.scope ?? [])]);
    this.scopeSeparator = init.scopeSeparator ?? ' ';
    if (this.scopeSeparator === '') {
      throw new DeviceAuthConfigError('DeviceAuthConfig: `scopeSeparator` must be non-empty');
    }
    if (this.clientAuthMethod !== 'none' && (this.clientSecret === null || this.clientSecret === '')) {
      throw new DeviceAuthConfigError(
        `DeviceAuthConfig: clientAuthMethod ${JSON.stringify(this.clientAuthMethod)} requires \`clientSecret\``,
      );
    }
    this.extraDeviceParams = Object.freeze({ ...(init.extraDeviceParams ?? {}) });
    this.extraTokenParams = Object.freeze({ ...(init.extraTokenParams ?? {}) });
    this.extraHeaders = Object.freeze({ ...(init.extraHeaders ?? {}) });
    this.fieldAliases = Object.freeze(mergeFieldAliases(init.fieldAliases));
    this.defaultInterval = init.defaultInterval ?? DEFAULT_INTERVAL_SECONDS;
    if (!Number.isFinite(this.defaultInterval) || this.defaultInterval <= 0) {
      throw new DeviceAuthConfigError(
        `DeviceAuthConfig: \`defaultInterval\` must be a finite number greater than 0 — got ${String(this.defaultInterval)}`,
      );
    }
    this.httpTimeoutMs = init.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.requestEncoding = Object.freeze({
      ...DEFAULT_REQUEST_ENCODING,
      ...(init.requestEncoding ?? {}),
    });
    this.fetchImpl = init.fetchImpl ?? null;
    this.onWarning = init.onWarning ?? null;
    this.hooks = Object.freeze({ ...(init.hooks ?? {}) });
    this.buildAuthHeaders =
      init.buildAuthHeaders
      ?? ((tokens) => ({ Authorization: `${tokens.tokenType} ${tokens.accessToken}` }));
    Object.freeze(this);
  }

  /** A copy with `overrides` applied. */
  with(overrides: Partial<DeviceAuthConfigInit>): DeviceAuthConfig {
    return new DeviceAuthConfig({ ...this.init, ...overrides });
  }

  /** Emit a warning to the configured sink, if any. */
  warn(warning: DeviceAuthWarning): void {
    this.onWarning?.(warning);
  }

  /**
   * Resolve endpoints from the issuer's metadata document.
   *
   * **An explicit, separate network step — never a hidden fetch inside
   * `login()`.** A caller supplying endpoints explicitly performs no
   * network access before the flow starts, mirroring the I/O separation
   * the sibling OpenAPI-scanner proposal applies to spec loading.
   *
   * Explicit configuration always wins, so a compromised or misconfigured
   * discovery document cannot silently redirect a token request.
   *
   * A candidate counts as successful only when the response is `2xx`
   * **and** the body parses as a JSON object **and** it carries the fields
   * being looked for. HTTP 200 does not mean you found metadata: a
   * surveyed provider serves an HTML single-page application at one of
   * these paths, and a client advancing on status alone accepts it, fails
   * while parsing, and never tries the remaining candidates.
   */
  async discover(options: DiscoverOptions = {}): Promise<DeviceAuthConfig> {
    if (this.issuer === null) {
      throw new DeviceAuthConfigError('DeviceAuthConfig.discover(): `issuer` is not configured');
    }
    const fetchImpl =
      options.fetchImpl ?? this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!fetchImpl) {
      throw new DeviceAuthConfigError(
        'DeviceAuthConfig.discover(): no fetch implementation — pass `fetchImpl` or run on Node 20+.',
      );
    }

    const candidates = discoveryCandidates(this.issuer);
    const failures: string[] = [];
    for (const url of candidates) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...this.extraHeaders },
        });
      } catch (err) {
        failures.push(`${url}: transport error (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        failures.push(`${url}: HTTP ${String(response.status)}`);
        continue;
      }
      const rawBody = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        failures.push(`${url}: 2xx body is not JSON`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        failures.push(`${url}: 2xx body is not a JSON object`);
        continue;
      }
      const resolution = resolveMetadata(this.issuer, parsed as WireBody);
      if (!resolution.accepted) {
        failures.push(`${url}: ${resolution.reason ?? 'rejected'}`);
        continue;
      }
      for (const warning of resolution.warnings) this.warn(warning);

      // Explicit configuration always wins over anything discovered.
      const merged = this.with({
        deviceAuthorizationEndpoint:
          this.deviceAuthorizationEndpoint ?? resolution.deviceAuthorizationEndpoint,
        tokenEndpoint: this.tokenEndpoint ?? resolution.tokenEndpoint,
        revocationEndpoint: this.revocationEndpoint ?? resolution.revocationEndpoint,
      });
      if (merged.deviceAuthorizationEndpoint === null) {
        // Actionable, naming the missing setting — rather than a confusing
        // 404 much later. `device_authorization_endpoint` is OPTIONAL in
        // RFC 8414 metadata and at least one major provider omits it while
        // fully supporting the grant.
        throw new DiscoveryError(
          `Issuer ${JSON.stringify(this.issuer)} published metadata at ${url} without `
            + '`device_authorization_endpoint`. Set `deviceAuthorizationEndpoint` explicitly '
            + '— the provider may still support the grant without advertising it.',
          candidates,
        );
      }
      return merged;
    }

    throw new DiscoveryError(
      `Discovery failed for issuer ${JSON.stringify(this.issuer)}. Tried:\n  ${failures.join('\n  ')}`,
      candidates,
    );
  }
}
