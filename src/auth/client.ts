/**
 * `DeviceAuthClient` — the consumer-facing surface.
 *
 * Owns configuration, the store, the injected clocks, and the grant. The
 * protocol work lives in {@link DeviceCodeGrant}; this class is the part a
 * CLI, a daemon, or an IDE plugin actually holds.
 *
 * What it deliberately does not produce is an `Identity`. The access token
 * is an opaque bearer credential; only the party holding the verification
 * key can turn one into verified claims. A client that decodes its own JWT
 * and builds an identity from the unverified payload has produced a
 * self-asserted claim wearing the costume of a verified one — the exact
 * confusion that ends with a downstream consumer trusting attacker-supplied
 * roles. Identity construction stays server-side.
 */

import {
  DeviceAuthConfig,
  type DeviceAuthConfigInit,
  type DeviceAuthWarning,
} from './config.js';
import { DeviceCodeGrant, type DeviceLoginOptions } from './device-code-grant.js';
import {
  AuthorizationProtocolError,
  NoCredentialError,
  RefreshFailedError,
} from './errors.js';
import type { Grant, GrantContext, MonotonicClock, SleepFn } from './grant.js';
import { decodeResponse, sendRequest, type PipelineContext } from './pipeline.js';
import { DEFAULT_SKEW_SECONDS, TokenSet, systemWallClock, type WallClock } from './token-set.js';
import { MemoryTokenStore, makeStoreKey, type TokenStore } from './token-store.js';
import { FetchAuthTransport, type AuthTransport } from './transport.js';
import {
  INVALID_GRANT,
  REFRESH_TOKEN_GRANT_TYPE,
  WireField,
  readErrorIdentifier,
} from './wire.js';

/** Runtime collaborators, separate from provider configuration. */
export interface DeviceAuthRuntimeOptions {
  /** Where credentials are kept. Defaults to an in-memory store. */
  store?: TokenStore;
  /** Which grant runs on `login()`. Defaults to {@link DeviceCodeGrant}. */
  grant?: Grant<DeviceLoginOptions>;
  /** Replaces the default fetch-backed transport outright. */
  transport?: AuthTransport;
  /**
   * **Monotonic** milliseconds, driving the polling deadline only.
   * Defaults to `performance.now`. Named `clock` for parity with Python's
   * and Rust's `clock`; the wall clock below is the separate third
   * injection point.
   */
  clock?: MonotonicClock;
  /** Defaults to `setTimeout`. */
  sleep?: SleepFn;
  /** Wall-clock Unix seconds. Defaults to `Date.now() / 1000`, floored. */
  wallClock?: WallClock;
}

/** Provider configuration and runtime collaborators in one object. */
export type DeviceAuthClientOptions = DeviceAuthConfigInit & DeviceAuthRuntimeOptions;

/** Options for {@link DeviceAuthClient.ensureValid}. */
export interface EnsureValidOptions {
  /** Seconds of slack. Default 30. */
  skewSeconds?: number;
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultMonotonicClock: MonotonicClock = () => performance.now();

/**
 * @example
 * ```ts
 * import { DeviceAuthClient, FileTokenStore } from 'apcore-toolkit';
 *
 * const client = new DeviceAuthClient({
 *   deviceAuthorizationEndpoint: 'https://auth.example.com/device/code',
 *   tokenEndpoint: 'https://auth.example.com/token',
 *   clientId: 'apcore-cli',
 *   scope: ['openid', 'api.read'],
 *   store: new FileTokenStore(),
 * });
 *
 * const tokens = await client.login({
 *   onUserCode: ({ verificationUri, userCode }) => ui.show(verificationUri, userCode),
 * });
 *
 * await client.ensureValid();
 * const headers = client.asAuthHeaderFactory();
 * ```
 */
export class DeviceAuthClient {
  readonly config: DeviceAuthConfig;
  readonly store: TokenStore;
  readonly grant: Grant<DeviceLoginOptions>;
  private readonly transport: AuthTransport;
  private readonly clock: MonotonicClock;
  private readonly sleep: SleepFn;
  private readonly wallClock: WallClock;

  constructor(config: DeviceAuthConfig, runtime?: DeviceAuthRuntimeOptions);
  constructor(options: DeviceAuthClientOptions);
  constructor(
    configOrOptions: DeviceAuthConfig | DeviceAuthClientOptions,
    runtime: DeviceAuthRuntimeOptions = {},
  ) {
    const options: DeviceAuthRuntimeOptions =
      configOrOptions instanceof DeviceAuthConfig ? runtime : configOrOptions;
    this.config =
      configOrOptions instanceof DeviceAuthConfig
        ? configOrOptions
        : new DeviceAuthConfig(configOrOptions);
    this.store = options.store ?? new MemoryTokenStore();
    this.grant = options.grant ?? new DeviceCodeGrant();
    this.transport = options.transport ?? new FetchAuthTransport(this.config.fetchImpl);
    this.clock = options.clock ?? defaultMonotonicClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.wallClock = options.wallClock ?? systemWallClock;
  }

  /**
   * Canonical store key: `"<issuer>|<client_id>"`.
   *
   * With no `issuer` configured — the explicit-endpoint path — the token
   * endpoint stands in for it, so two providers reached without discovery
   * still cannot collide.
   */
  get storeKey(): string {
    return makeStoreKey(this.config.issuer ?? this.config.tokenEndpoint ?? '', this.config.clientId);
  }

  /** The context a grant runs against. */
  private grantContext(): GrantContext {
    return {
      config: this.config,
      transport: this.transport,
      clock: this.clock,
      wallClock: this.wallClock,
      sleep: this.sleep,
      warn: (warning: DeviceAuthWarning) => {
        this.config.warn(warning);
      },
    };
  }

  private pipelineContext(): PipelineContext {
    return { config: this.config, transport: this.transport };
  }

  /**
   * Run the configured grant and persist the result.
   *
   * @throws AuthorizationDeniedError when the user refused.
   * @throws AuthorizationExpiredError when the device code expired or the deadline elapsed.
   * @throws AuthorizationProtocolError on an unrecognised error code or a malformed body.
   *
   * Transport errors are retried until the deadline rather than raised,
   * and callback exceptions are swallowed as warnings — a rendering
   * failure in the UI layer is not a reason to lose an in-flight
   * authorization.
   */
  async login(options: DeviceLoginOptions = {}): Promise<TokenSet> {
    const tokens = await this.grant.authorize(this.grantContext(), options);
    await this.store.save(this.storeKey, tokens);
    return tokens;
  }

  /**
   * Return a token valid for at least `skewSeconds` more, refreshing if needed.
   *
   * Idempotent while the stored token is still valid: it is returned
   * unchanged, with no network call.
   *
   * @throws NoCredentialError when the store is empty, or the token has
   * expired and the server issued no refresh token — common for
   * short-lived scopes, and the correct answer there is a fresh `login()`.
   * @throws RefreshFailedError when the refresh token was rejected; the
   * store has been cleared as a side effect.
   */
  async ensureValid(options: EnsureValidOptions = {}): Promise<TokenSet> {
    const skewSeconds = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;
    const stored = await this.store.load(this.storeKey);
    if (stored === null) throw new NoCredentialError();
    if (!stored.isExpired({ skewSeconds, now: this.wallClock })) return stored;
    return this.refresh(stored);
  }

  /**
   * Exchange the refresh token for a new {@link TokenSet}.
   *
   * **Refresh-token rotation is assumed** (OAuth 2.1 and RFC 6749 §10.4
   * recommend that servers issue a new refresh token on each use and
   * invalidate the old one), so the stored record is replaced **wholesale**
   * — never merged, which would keep a spent refresh token alongside a
   * fresh access token.
   *
   * An `invalid_grant` rejection is terminal: the refresh token is spent or
   * revoked, so the store is cleared and a fresh `login()` is required.
   * Retrying cannot succeed and would only hammer the endpoint.
   */
  async refresh(tokens?: TokenSet): Promise<TokenSet> {
    const current = tokens ?? (await this.store.load(this.storeKey));
    if (current === null || current === undefined) throw new NoCredentialError();
    if (current.refreshToken === null) {
      throw new NoCredentialError(
        'Stored credential has no refresh token; a fresh login() is required',
      );
    }
    const tokenEndpoint = this.config.tokenEndpoint;
    if (tokenEndpoint === null) {
      throw new AuthorizationProtocolError(
        'No token endpoint: set `tokenEndpoint`, or call `config.discover()` first.',
      );
    }

    const ctx = this.pipelineContext();
    const response = await sendRequest(ctx, 'refresh', tokenEndpoint, {
      [WireField.GRANT_TYPE]: REFRESH_TOKEN_GRANT_TYPE,
      [WireField.REFRESH_TOKEN]: current.refreshToken,
    });
    const body = await decodeResponse(ctx, 'refresh', response);

    if (response.status >= 200 && response.status < 300 && body !== null) {
      const refreshed = TokenSet.fromTokenResponse(body, response.rawBody, this.wallClock);
      await this.store.save(this.storeKey, refreshed);
      return refreshed;
    }

    // `invalid_grant` is read verbatim here rather than through the polling
    // classifier: it is not one of the four RFC 8628 identifiers, and it
    // means something different on this endpoint.
    const identifier = body === null ? null : readErrorIdentifier(body, this.config.fieldAliases);
    if (identifier === INVALID_GRANT) {
      await this.store.clear(this.storeKey);
      throw new RefreshFailedError();
    }
    throw new AuthorizationProtocolError(
      `Refresh failed with HTTP ${String(response.status)}`
        + `${identifier === null ? '' : ` (${identifier})`}`,
      response.rawBody,
      response.status,
    );
  }

  /**
   * A callable returning the complete header map for one API call.
   *
   * Returns a **header mapping**, not a token string, because the header
   * carrying a credential is not universally `Authorization: Bearer` —
   * `x-api-key` and `api-key` are both in live use, and one vendor accepts
   * both, choosing by which kind of credential is held. Override
   * `buildAuthHeaders` in the configuration rather than branching on
   * provider identity.
   *
   * The factory calls `ensureValid()` internally, so a long-running
   * process refreshes transparently and the caller knows nothing about
   * OAuth. It returns a promise: a refresh is an HTTP round-trip, which is
   * inherently async in TypeScript (recorded Decision 1, option A — the
   * writer's factory type is widened to accept it, and awaiting a
   * non-promise is a no-op for every existing caller).
   *
   * The headers are for **one** configured host. Never reuse a factory
   * across hosts: sending a bearer token to an unintended host leaks it.
   */
  asAuthHeaderFactory(options: EnsureValidOptions = {}): () => Promise<Record<string, string>> {
    return async () => {
      const tokens = await this.ensureValid(options);
      return this.config.buildAuthHeaders({
        accessToken: tokens.accessToken,
        tokenType: tokens.tokenType,
      });
    };
  }
}
