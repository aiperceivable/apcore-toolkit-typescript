// Unit tests for the device-auth surface that the conformance corpus does
// not reach: redaction beyond `toString`, configuration validation, hook
// failure modes, callback isolation, refresh/ensureValid branches, and the
// "writes nothing to a terminal" non-goal.
//
// The conformance corpus (tests/device-auth-conformance.test.ts) owns
// cross-SDK behaviour. These tests own this SDK's edges.

import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthTransportError,
  AuthorizationDeniedError,
  AuthorizationProtocolError,
  DeviceAuthClient,
  DeviceAuthConfig,
  DeviceAuthConfigError,
  DeviceCodeGrant,
  DiscoveryError,
  FetchAuthTransport,
  InvalidClassificationError,
  MemoryTokenStore,
  NoCredentialError,
  REDACTED,
  RefreshFailedError,
  TokenSet,
  discoveryCandidates,
  effectiveDeadlineSeconds,
  encodeBody,
  formUrlEncodeComponent,
  resolveMetadata,
  type AuthRequest,
  type AuthResponse,
  type AuthTransport,
  type DeviceAuthWarning,
  type Grant,
} from '../src/index.js';

const DEVICE_ENDPOINT = 'https://e.example/device';
const TOKEN_ENDPOINT = 'https://e.example/token';

interface Scripted {
  status?: number;
  body?: Record<string, unknown>;
  transportError?: boolean;
}

class Recorder implements AuthTransport {
  readonly requests: AuthRequest[] = [];
  private index = 0;

  constructor(
    private readonly device: Record<string, unknown> | null,
    private readonly tokens: Scripted[] = [],
  ) {}

  async send(request: AuthRequest): Promise<AuthResponse> {
    this.requests.push(request);
    if (request.kind === 'device') {
      return { status: 200, contentType: 'application/json', rawBody: JSON.stringify(this.device) };
    }
    const scripted = this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
    this.index += 1;
    if (scripted === undefined) throw new Error('no scripted response');
    if (scripted.transportError === true) throw new AuthTransportError('scripted failure');
    return {
      status: scripted.status ?? 200,
      contentType: 'application/json',
      rawBody: JSON.stringify(scripted.body ?? {}),
    };
  }
}

const DEVICE_RESPONSE = {
  device_code: 'dc',
  user_code: 'ABCD-EFGH',
  verification_uri: DEVICE_ENDPOINT,
  expires_in: 600,
  interval: 5,
};

const SUCCESS: Scripted = {
  status: 200,
  body: { access_token: 'access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r1' },
};

function instantClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  };
}

function makeClient(
  transport: AuthTransport,
  overrides: Record<string, unknown> = {},
): DeviceAuthClient {
  const clock = instantClock();
  return new DeviceAuthClient({
    clientId: 'cid',
    deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    store: new MemoryTokenStore(),
    transport,
    clock: clock.now,
    sleep: clock.sleep,
    wallClock: () => 1000,
    ...overrides,
  } as never);
}

// ---------------------------------------------------------------------------

describe('TokenSet — redaction', () => {
  const tokens = new TokenSet({
    accessToken: 'SECRET-ACCESS-VALUE',
    tokenType: 'Bearer',
    expiresAt: 1000,
    refreshToken: 'SECRET-REFRESH-VALUE',
    scope: ['openid'],
    obtainedAt: 900,
  });
  const secrets = ['SECRET-ACCESS-VALUE', 'SECRET-REFRESH-VALUE'];

  it('redacts in toString()', () => {
    expect(tokens.toString()).toContain(REDACTED);
    for (const secret of secrets) expect(tokens.toString()).not.toContain(secret);
  });

  it('redacts in util.inspect, which is what console.log actually uses', () => {
    // `console.log(obj)` formats through util.inspect, not toString. An
    // implementation that only overrides toString leaves the most common
    // leak path — a developer logging the object — wide open.
    for (const secret of secrets) {
      expect(inspect(tokens)).not.toContain(secret);
      expect(inspect(tokens, { depth: null, showHidden: true })).not.toContain(secret);
      expect(inspect({ credential: tokens })).not.toContain(secret);
      expect(inspect([tokens])).not.toContain(secret);
    }
  });

  it('redacts through console.log itself', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      console.log(tokens);
      console.log('%o', tokens);
      console.log({ nested: { tokens } });
      const rendered = spy.mock.calls.map((call) => inspect(call)).join('\n');
      for (const secret of secrets) expect(rendered).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('redacts in JSON.stringify, so a structured log line cannot leak either', () => {
    for (const secret of secrets) {
      expect(JSON.stringify(tokens)).not.toContain(secret);
      expect(JSON.stringify({ credential: tokens })).not.toContain(secret);
    }
  });

  it('still exposes the real values through the explicit accessors', () => {
    // Redaction must not become "the value is unreachable" — persistence
    // and header construction both need the genuine token.
    expect(tokens.accessToken).toBe('SECRET-ACCESS-VALUE');
    expect(tokens.toRecord().refreshToken).toBe('SECRET-REFRESH-VALUE');
  });

  it('keeps a null refresh token distinguishable from a redacted one', () => {
    const noRefresh = new TokenSet({
      accessToken: 'a',
      tokenType: 'Bearer',
      expiresAt: null,
      refreshToken: null,
      scope: [],
      obtainedAt: 0,
    });
    expect(noRefresh.toString()).toContain('refresh_token=null');
  });
});

describe('TokenSet — construction and expiry', () => {
  it('normalises only the Bearer casing, leaving exotic types alone', () => {
    const build = (tokenType: string): string =>
      TokenSet.fromTokenResponse(
        { access_token: 't', token_type: tokenType },
        '{}',
        () => 1000,
      ).tokenType;
    expect(build('bearer')).toBe('Bearer');
    expect(build('BEARER')).toBe('Bearer');
    expect(build('Bearer')).toBe('Bearer');
    expect(build('DPoP')).toBe('DPoP');
  });

  it('defaults token_type to Bearer when the server omits it', () => {
    expect(TokenSet.fromTokenResponse({ access_token: 't' }, '{}', () => 1000).tokenType).toBe(
      'Bearer',
    );
  });

  it('coerces expires_in at construction, not at parse time', () => {
    // A form-encoded response yields strings; the parse layer leaves them
    // alone (corpus case 022) and TokenSet is where the number appears.
    const tokens = TokenSet.fromTokenResponse(
      { access_token: 't', expires_in: '3600' },
      '{}',
      () => 1000,
    );
    expect(tokens.expiresAt).toBe(4600);
  });

  it('treats an absent expires_in as "no stated expiry", never as "expired now"', () => {
    const tokens = TokenSet.fromTokenResponse({ access_token: 't' }, '{}', () => 1000);
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.isExpired({ now: () => 99_999_999 })).toBe(false);
  });

  it('throws a protocol error carrying the raw body when access_token is missing', () => {
    expect(() => TokenSet.fromTokenResponse({ token_type: 'Bearer' }, 'RAW', () => 1)).toThrow(
      AuthorizationProtocolError,
    );
    try {
      TokenSet.fromTokenResponse({ token_type: 'Bearer' }, 'RAW', () => 1);
    } catch (err) {
      expect((err as AuthorizationProtocolError).rawBody).toBe('RAW');
    }
  });

  it('applies the 30-second default skew at the boundary', () => {
    const tokens = new TokenSet({
      accessToken: 'a',
      tokenType: 'Bearer',
      expiresAt: 1000,
      refreshToken: null,
      scope: [],
      obtainedAt: 0,
    });
    expect(tokens.isExpired({ now: () => 969 })).toBe(false);
    expect(tokens.isExpired({ now: () => 970 })).toBe(true);
    expect(tokens.isExpired({ now: () => 970, skewSeconds: 0 })).toBe(false);
  });

  it('round-trips through toRecord / fromRecord', () => {
    const original = new TokenSet({
      accessToken: 'a',
      tokenType: 'Bearer',
      expiresAt: 5,
      refreshToken: 'r',
      scope: ['x', 'y'],
      obtainedAt: 1,
    });
    const restored = TokenSet.fromRecord(original.toRecord());
    expect(restored?.toRecord()).toEqual(original.toRecord());
  });

  it('rejects a record with no access token', () => {
    expect(TokenSet.fromRecord({ accessToken: '' })).toBeNull();
    expect(TokenSet.fromRecord(null)).toBeNull();
  });
});

describe('DeviceAuthConfig — validation', () => {
  const base = { clientId: 'cid', deviceAuthorizationEndpoint: DEVICE_ENDPOINT, tokenEndpoint: TOKEN_ENDPOINT };

  it('rejects an alias that maps onto a non-RFC identifier', () => {
    expect(() => new DeviceAuthConfig({ ...base, errorAliases: { a: 'nope' } })).toThrow(
      DeviceAuthConfigError,
    );
  });

  it('accepts aliases onto each of the four identifiers', () => {
    for (const target of ['authorization_pending', 'slow_down', 'access_denied', 'expired_token']) {
      expect(() => new DeviceAuthConfig({ ...base, errorAliases: { vendor: target } })).not.toThrow();
    }
  });

  it('refuses a plaintext endpoint at construction, not at request time', () => {
    expect(
      () => new DeviceAuthConfig({ ...base, tokenEndpoint: 'http://auth.example.com/token' }),
    ).toThrow(/must be https/);
  });

  it('allows http://localhost for development', () => {
    expect(
      () =>
        new DeviceAuthConfig({
          clientId: 'cid',
          deviceAuthorizationEndpoint: 'http://localhost:8080/device',
          tokenEndpoint: 'http://127.0.0.1:8080/token',
        }),
    ).not.toThrow();
  });

  it('requires either an issuer or both endpoints', () => {
    expect(() => new DeviceAuthConfig({ clientId: 'cid' })).toThrow(/issuer/);
    expect(() => new DeviceAuthConfig({ clientId: 'cid', tokenEndpoint: TOKEN_ENDPOINT })).toThrow();
    expect(() => new DeviceAuthConfig({ clientId: 'cid', issuer: 'https://a.example' })).not.toThrow();
  });

  it('requires a client secret when a secret-bearing auth method is chosen', () => {
    expect(
      () => new DeviceAuthConfig({ ...base, clientAuthMethod: 'client_secret_basic' }),
    ).toThrow(/clientSecret/);
  });

  it('rejects a non-positive default interval and an empty scope separator', () => {
    expect(() => new DeviceAuthConfig({ ...base, defaultInterval: 0 })).toThrow();
    expect(() => new DeviceAuthConfig({ ...base, scopeSeparator: '' })).toThrow();
  });

  it('requires a client id', () => {
    expect(() => new DeviceAuthConfig({ ...base, clientId: '  ' })).toThrow(/clientId/);
  });
});

describe('client authentication — RFC 6749 §2.3.1', () => {
  it('form-urlencodes each half before base64', () => {
    // The corpus's `cid`/`sec` are byte-identical with and without this
    // step, so only a credential carrying a reserved character can show the
    // difference — which is exactly the credential providers generate.
    expect(formUrlEncodeComponent('sec:ret')).toBe('sec%3Aret');
    expect(formUrlEncodeComponent('a b')).toBe('a+b');
    expect(formUrlEncodeComponent('p+q')).toBe('p%2Bq');
    expect(formUrlEncodeComponent('pä')).toBe('p%C3%A4');
    expect(formUrlEncodeComponent('a-b_c.d~e')).toBe('a-b_c.d~e');
  });

  it('encodes a space as "+" and a literal "+" as %2B — NOT encodeURIComponent', () => {
    // The interop detail "form-urlencode" alone does not pin.
    // `encodeURIComponent` is the reflex reach in TypeScript and it gives
    // %20 for a space, which produces a different base64 and a Basic header
    // no RFC-conforming provider will accept. Pinned as a unit assertion
    // because it is the one difference the shape of the code does not make
    // obvious to a reviewer.
    expect(formUrlEncodeComponent(' ')).toBe('+');
    expect(formUrlEncodeComponent('+')).toBe('%2B');
    expect(formUrlEncodeComponent('s p+a:ce')).toBe('s+p%2Ba%3Ace');
    expect(formUrlEncodeComponent('s p+a:ce')).not.toBe(encodeURIComponent('s p+a:ce'));
  });

  it('produces the corpus case 058 header byte-for-byte through the real request path', async () => {
    // Case 058's own values, driven through buildRequestFields rather than
    // through the helper, so a regression anywhere between the two is caught.
    const transport = new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'access_denied' } }]);
    const client = makeClient(transport, {
      clientSecret: 's p+a:ce',
      clientAuthMethod: 'client_secret_basic',
    });
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    const tokenRequest = transport.requests.find((r) => r.kind === 'token');
    expect(tokenRequest?.headers.Authorization).toBe('Basic Y2lkOnMrcCUyQmElM0FjZQ==');
  });

  it('applies the same encoding to every form body value, not only the Basic header', async () => {
    // `scope`, `client_id` and any `extra_*` value ride the same
    // application/x-www-form-urlencoded serializer.
    const transport = new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'access_denied' } }]);
    const client = makeClient(transport, {
      clientId: 'client id',
      scope: ['a b', 'c+d'],
      extraDeviceParams: { audience: 'x:y z' },
    });
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    const deviceRequest = transport.requests.find((r) => r.kind === 'device') as AuthRequest;
    const body = encodeBody(deviceRequest.encoding, deviceRequest.params).body;
    expect(body).toContain('client_id=client+id');
    expect(body).toContain('scope=a+b+c%2Bd');
    expect(body).toContain('audience=x%3Ay+z');
    expect(body).not.toContain('%20');
    // And it round-trips: the decoder must read back exactly what went in.
    const decoded = Object.fromEntries(new URLSearchParams(body));
    expect(decoded.client_id).toBe('client id');
    expect(decoded.scope).toBe('a b c+d');
    expect(decoded.audience).toBe('x:y z');
  });

  it('sends the Basic header on both the device and the token request', async () => {
    const transport = new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'access_denied' } }]);
    const client = makeClient(transport, {
      clientSecret: 'se:c ret',
      clientAuthMethod: 'client_secret_basic',
    });
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    const expected = `Basic ${btoa('cid:se%3Ac+ret')}`;
    expect(transport.requests.map((r) => r.headers.Authorization)).toEqual([expected, expected]);
    // `client_id` stays in the body; `client_secret` never does.
    for (const request of transport.requests) {
      expect(request.params.client_id).toBe('cid');
      expect(request.params).not.toHaveProperty('client_secret');
    }
  });

  it('client_secret_post puts the secret in the body and sends no Authorization header', async () => {
    const transport = new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'access_denied' } }]);
    const client = makeClient(transport, {
      clientSecret: 'sec',
      clientAuthMethod: 'client_secret_post',
    });
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    for (const request of transport.requests) {
      expect(request.params.client_secret).toBe('sec');
      expect(request.headers).not.toHaveProperty('Authorization');
    }
  });
});

describe('extension hooks', () => {
  it('gives transform_request no URL to change', async () => {
    // Request targeting stays with configuration and discovery: a hook able
    // to redirect the token request is a hook able to exfiltrate credentials.
    const transport = new Recorder(DEVICE_RESPONSE, [SUCCESS]);
    let argCount = -1;
    const client = makeClient(transport, {
      hooks: {
        transformRequest: (...args: unknown[]) => {
          argCount = args.length;
          expect(JSON.stringify(args)).not.toContain(TOKEN_ENDPOINT);
          return {};
        },
      },
    });
    await client.login();
    expect(argCount).toBe(3);
    // The endpoints still reach the transport unchanged.
    expect(transport.requests.map((r) => r.url)).toEqual([DEVICE_ENDPOINT, TOKEN_ENDPOINT]);
  });

  it('propagates a transform_request failure instead of swallowing it', async () => {
    // Unlike the observational callbacks, this hook is load-bearing.
    const client = makeClient(new Recorder(DEVICE_RESPONSE, [SUCCESS]), {
      hooks: {
        transformRequest: () => {
          throw new Error('signing failed');
        },
      },
    });
    await expect(client.login()).rejects.toThrow('signing failed');
  });

  it('rejects a classify_error return value outside the four identifiers', async () => {
    const client = makeClient(
      new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'vendor_thing' } }]),
      { hooks: { classifyError: () => 'not_a_state' } },
    );
    await expect(client.login()).rejects.toBeInstanceOf(InvalidClassificationError);
  });

  it('never consults classify_error once aliasing resolved the identifier', async () => {
    // Case 047's precedence rule, stated as behaviour: the hook is not
    // merely out-voted, it is not called.
    let called = false;
    const client = makeClient(
      new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'vendor_denied' } }]),
      {
        errorAliases: { vendor_denied: 'access_denied' },
        hooks: {
          classifyError: () => {
            called = true;
            return 'expired_token';
          },
        },
      },
    );
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(called).toBe(false);
  });

  it('lets parse_response special-case one kind and ignore the rest', async () => {
    const transport = new Recorder(DEVICE_RESPONSE, [{ status: 200, body: { nothing: 'useful' } }]);
    const client = makeClient(transport, {
      hooks: {
        parseResponse: (kind: string) =>
          kind === 'token'
            ? { access_token: 'from-hook', token_type: 'Bearer', expires_in: 60 }
            : null,
      },
    });
    const tokens = await client.login();
    expect(tokens.accessToken).toBe('from-hook');
  });

  it('applies field-name aliasing to a hook output, not only to the built-in parser', async () => {
    // The hook contract puts field-name aliasing AFTER parse_response, so a
    // hook that emits a provider spelling is normalised the same way a
    // built-in parse would be.
    const transport = new Recorder(
      { device_code: 'dc', user_code: 'AB-CD', expires_in: 600 },
      [SUCCESS],
    );
    const seen: string[] = [];
    const client = makeClient(transport, {
      hooks: {
        parseResponse: (kind: string, _status: number, _ct: string | null, raw: string) =>
          kind === 'device'
            ? { ...(JSON.parse(raw) as object), verification_url: 'https://x.example' }
            : null,
      },
    });
    await client.login({ onUserCode: (e) => seen.push(e.verificationUri) });
    expect(seen).toEqual(['https://x.example']);
  });
});

describe('consumer callbacks', () => {
  it('does not let a failing callback abort an in-flight authorization', async () => {
    const warnings: DeviceAuthWarning[] = [];
    const client = makeClient(new Recorder(DEVICE_RESPONSE, [SUCCESS]), {
      onWarning: (w: DeviceAuthWarning) => warnings.push(w),
    });
    const tokens = await client.login({
      onUserCode: () => {
        throw new Error('terminal is gone');
      },
      onPoll: () => {
        throw new Error('spinner exploded');
      },
    });
    expect(tokens.accessToken).toBe('access');
    expect(warnings.map((w) => w.code)).toEqual(['callback_failed', 'callback_failed']);
  });

  it('invokes onUserCode exactly once, with the fields the spec names', async () => {
    const events: unknown[] = [];
    const client = makeClient(
      new Recorder(
        { ...DEVICE_RESPONSE, verification_uri_complete: 'https://e.example/device?c=ABCD-EFGH' },
        [{ status: 400, body: { error: 'authorization_pending' } }, SUCCESS],
      ),
    );
    await client.login({ onUserCode: (e) => events.push(e) });
    expect(events).toEqual([
      {
        verificationUri: DEVICE_ENDPOINT,
        userCode: 'ABCD-EFGH',
        verificationUriComplete: 'https://e.example/device?c=ABCD-EFGH',
        expiresIn: 600,
      },
    ]);
  });

  it('reports the effective expiry, applying the 15-minute fallback at parse time', async () => {
    const events: { expiresIn: number }[] = [];
    const client = makeClient(
      new Recorder(
        { device_code: 'dc', user_code: 'AB-CD', verification_uri: DEVICE_ENDPOINT },
        [SUCCESS],
      ),
    );
    await client.login({ onUserCode: (e) => events.push(e) });
    expect(events[0].expiresIn).toBe(900);
  });

  it('reports the clamped deadline, and stops on that same number', async () => {
    // One derivation for both readers. Reporting the server's 600 while the
    // loop stops at 7 would leave a consumer's countdown describing a
    // deadline that is not in force.
    const events: { expiresIn: number }[] = [];
    const client = makeClient(
      new Recorder(DEVICE_RESPONSE, [{ status: 400, body: { error: 'authorization_pending' } }]),
    );
    await expect(
      client.login({ timeoutSeconds: 7, onUserCode: (e) => events.push(e) }),
    ).rejects.toThrow(/deadline of 7s/);
    expect(events[0].expiresIn).toBe(7);
  });

  it('reports the server expiry when it is the shorter of the two', async () => {
    const events: { expiresIn: number }[] = [];
    const client = makeClient(new Recorder(DEVICE_RESPONSE, [SUCCESS]));
    await client.login({ timeoutSeconds: 9000, onUserCode: (e) => events.push(e) });
    expect(events[0].expiresIn).toBe(600);
  });

  it('derives the deadline the same way for every reader', () => {
    expect(effectiveDeadlineSeconds(600, undefined)).toBe(600);
    expect(effectiveDeadlineSeconds(600, 7)).toBe(7);
    expect(effectiveDeadlineSeconds(7, 600)).toBe(7);
    expect(effectiveDeadlineSeconds(900, 900)).toBe(900);
  });

  it('passes verificationUriComplete as null when the provider omits it', async () => {
    // The norm, not the exception: only one surveyed provider returns it.
    const events: { verificationUriComplete: string | null }[] = [];
    const client = makeClient(new Recorder(DEVICE_RESPONSE, [SUCCESS]));
    await client.login({ onUserCode: (e) => events.push(e) });
    expect(events[0].verificationUriComplete).toBeNull();
  });

  it('reports a 1-based attempt, the interval used, and the elapsed seconds', async () => {
    const polls: { attempt: number; interval: number; elapsed: number }[] = [];
    const client = makeClient(
      new Recorder(DEVICE_RESPONSE, [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        SUCCESS,
      ]),
    );
    await client.login({ onPoll: (e) => polls.push(e) });
    expect(polls).toEqual([
      { attempt: 1, interval: 5, elapsed: 5 },
      { attempt: 2, interval: 5, elapsed: 10 },
      { attempt: 3, interval: 10, elapsed: 20 },
    ]);
  });
});

describe('ensureValid and refresh', () => {
  it('raises NoCredentialError when the store is empty', async () => {
    const client = makeClient(new Recorder(null, []));
    await expect(client.ensureValid()).rejects.toBeInstanceOf(NoCredentialError);
  });

  it('returns a still-valid token without any network call', async () => {
    const transport = new Recorder(DEVICE_RESPONSE, [SUCCESS]);
    const client = makeClient(transport);
    await client.login();
    const before = transport.requests.length;
    const tokens = await client.ensureValid();
    expect(tokens.accessToken).toBe('access');
    expect(transport.requests.length).toBe(before);
  });

  it('raises NoCredentialError, not a refresh attempt, when there is no refresh token', async () => {
    // Common for short-lived scopes: the correct answer is a fresh login().
    const transport = new Recorder(DEVICE_RESPONSE, [
      { status: 200, body: { access_token: 'a', token_type: 'Bearer', expires_in: 1 } },
    ]);
    const client = makeClient(transport);
    await client.login();
    await expect(client.ensureValid()).rejects.toBeInstanceOf(NoCredentialError);
  });

  it('replaces the stored record wholesale on refresh', async () => {
    const store = new MemoryTokenStore();
    const transport = new Recorder(DEVICE_RESPONSE, [
      SUCCESS,
      { status: 200, body: { access_token: 'a2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r2' } },
    ]);
    const client = makeClient(transport, { store });
    await client.login();
    const refreshed = await client.refresh();
    expect(refreshed.accessToken).toBe('a2');
    expect(refreshed.refreshToken).toBe('r2');
    expect((await store.load(client.storeKey))?.refreshToken).toBe('r2');
  });

  it('clears the store on invalid_grant and does not retry', async () => {
    const store = new MemoryTokenStore();
    const transport = new Recorder(DEVICE_RESPONSE, [
      SUCCESS,
      { status: 400, body: { error: 'invalid_grant' } },
    ]);
    const client = makeClient(transport, { store });
    await client.login();
    await expect(client.refresh()).rejects.toBeInstanceOf(RefreshFailedError);
    expect(await store.load(client.storeKey)).toBeNull();
  });

  it('treats invalid_grant on refresh as terminal even for a consumer who aliased it', async () => {
    // `errorAliases` are for the device-code dispatch table; the refresh
    // path reads the raw identifier so the terminal rule still fires.
    const store = new MemoryTokenStore();
    const transport = new Recorder(DEVICE_RESPONSE, [
      SUCCESS,
      { status: 400, body: { error: 'invalid_grant' } },
    ]);
    const client = makeClient(transport, {
      store,
      errorAliases: { invalid_grant: 'expired_token' },
    });
    await client.login();
    await expect(client.refresh()).rejects.toBeInstanceOf(RefreshFailedError);
    expect(await store.load(client.storeKey)).toBeNull();
  });

  it('keeps the credential when a refresh fails for any other reason', async () => {
    const store = new MemoryTokenStore();
    const transport = new Recorder(DEVICE_RESPONSE, [
      SUCCESS,
      { status: 503, body: { error: 'temporarily_unavailable' } },
    ]);
    const client = makeClient(transport, { store });
    await client.login();
    await expect(client.refresh()).rejects.toBeInstanceOf(AuthorizationProtocolError);
    expect(await store.load(client.storeKey)).not.toBeNull();
  });
});

describe('asAuthHeaderFactory', () => {
  it('returns a complete header map, refreshed per call', async () => {
    const transport = new Recorder(DEVICE_RESPONSE, [SUCCESS]);
    const client = makeClient(transport);
    await client.login();
    const factory = client.asAuthHeaderFactory();
    expect(await factory()).toEqual({ Authorization: 'Bearer access' });
  });

  it('lets the header shape be configured as data, not a code branch', async () => {
    // One vendor accepts two different headers and picks by credential type.
    // An `if (provider === …)` ladder cannot express that without a release.
    const transport = new Recorder(DEVICE_RESPONSE, [SUCCESS]);
    const client = makeClient(transport, {
      buildAuthHeaders: (t: { accessToken: string }) => ({
        'x-api-key': t.accessToken,
        'anthropic-version': '2023-06-01',
      }),
    });
    await client.login();
    expect(await client.asAuthHeaderFactory()()).toEqual({
      'x-api-key': 'access',
      'anthropic-version': '2023-06-01',
    });
  });

  it('surfaces NoCredentialError rather than silently sending no header', async () => {
    const client = makeClient(new Recorder(null, []));
    await expect(client.asAuthHeaderFactory()()).rejects.toBeInstanceOf(NoCredentialError);
  });
});

describe('store key', () => {
  it('uses the issuer when one is configured', () => {
    const client = new DeviceAuthClient({
      clientId: 'cid',
      issuer: 'https://auth.example.com',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    expect(client.storeKey).toBe('https://auth.example.com|cid');
  });

  it('falls back to the token endpoint when there is no issuer', () => {
    // Explicit-endpoint configuration performs no discovery, so there is no
    // issuer to key on; a fixed fallback keeps three SDKs writing the same
    // store rather than three incompatible ones.
    const client = new DeviceAuthClient({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    expect(client.storeKey).toBe(`${TOKEN_ENDPOINT}|cid`);
  });
});

describe('discovery', () => {
  const respond = (body: unknown, status = 200, contentType = 'application/json'): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });

  it('rejects a discovered endpoint that is not https', () => {
    const resolution = resolveMetadata('https://a.example', {
      issuer: 'https://a.example',
      token_endpoint: 'http://a.example/t',
    });
    expect(resolution.accepted).toBe(false);
  });

  it('warns about a cross-origin endpoint but still follows it', () => {
    // Real providers host token endpoints on separate hosts; the document's
    // authority comes from the issuer's own well-known path over TLS plus
    // the verbatim issuer comparison, not from origin equality.
    const resolution = resolveMetadata('https://a.example', {
      issuer: 'https://a.example',
      device_authorization_endpoint: 'https://d.example/device',
      token_endpoint: 'https://d.example/t',
    });
    expect(resolution.accepted).toBe(true);
    expect(resolution.deviceAuthorizationEndpoint).toBe('https://d.example/device');
    expect(resolution.warnings.map((w) => w.code)).toContain('endpoint_origin_mismatch');
  });

  it('treats a bare device_code grant and an absent grant list as supported', () => {
    for (const grants of [['device_code'], ['urn:ietf:params:oauth:grant-type:device_code'], undefined]) {
      const resolution = resolveMetadata('https://a.example', {
        issuer: 'https://a.example',
        token_endpoint: 'https://a.example/t',
        ...(grants === undefined ? {} : { grant_types_supported: grants }),
      });
      expect(resolution.warnings.map((w) => w.code)).not.toContain('grant_type_unrecognised');
    }
  });

  it('gives an actionable error when metadata omits the device endpoint', async () => {
    const config = new DeviceAuthConfig({ clientId: 'cid', issuer: 'https://a.example' });
    const fetchImpl = (async () =>
      respond({ issuer: 'https://a.example', token_endpoint: 'https://a.example/t' })) as unknown as typeof fetch;
    await expect(config.discover({ fetchImpl })).rejects.toThrow(/deviceAuthorizationEndpoint/);
  });

  it('tries all three candidates before giving up', async () => {
    const config = new DeviceAuthConfig({ clientId: 'cid', issuer: 'https://a.example/tenant' });
    const tried: string[] = [];
    const fetchImpl = (async (url: string) => {
      tried.push(url);
      return respond('', 404);
    }) as unknown as typeof fetch;
    await expect(config.discover({ fetchImpl })).rejects.toBeInstanceOf(DiscoveryError);
    expect(tried).toEqual(discoveryCandidates('https://a.example/tenant'));
  });

  it('never performs network I/O as a side effect of login()', async () => {
    // Discovery is an explicit step. A caller supplying endpoints performs
    // no network access before the flow starts.
    const fetchImpl = vi.fn(async () => respond({}));
    const client = makeClient(new Recorder(DEVICE_RESPONSE, [SUCCESS]), {
      issuer: 'https://a.example',
      fetchImpl,
    });
    await client.login();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('FetchAuthTransport', () => {
  it('sends Accept: application/json and the encoding-appropriate content type', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const transport = new FetchAuthTransport(fetchImpl);

    await transport.send({
      kind: 'token',
      url: TOKEN_ENDPOINT,
      params: { a: 'b' },
      headers: { Accept: 'application/json' },
      encoding: 'form',
      timeoutMs: 1000,
    });
    await transport.send({
      kind: 'refresh',
      url: TOKEN_ENDPOINT,
      params: { a: 'b' },
      headers: { Accept: 'application/json' },
      encoding: 'json',
      timeoutMs: 1000,
    });

    const headers = calls.map((c) => c.init.headers as Record<string, string>);
    expect(headers[0].Accept).toBe('application/json');
    expect(headers[0]['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers[1]['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe('a=b');
    expect(calls[1].init.body).toBe('{"a":"b"}');
  });

  it('wraps a connection failure as a retryable AuthTransportError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(
      new FetchAuthTransport(fetchImpl).send({
        kind: 'token',
        url: TOKEN_ENDPOINT,
        params: {},
        headers: {},
        encoding: 'form',
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(AuthTransportError);
  });

  it('encodes a form body and a JSON body identically to the spec', () => {
    expect(encodeBody('form', { a: 'b c', d: 'e&f' })).toEqual({
      body: 'a=b+c&d=e%26f',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(encodeBody('json', { a: 'b' })).toEqual({
      body: '{"a":"b"}',
      contentType: 'application/json',
    });
  });
});

describe('the Grant seam', () => {
  it('accepts a second grant without touching the client', async () => {
    // Decision 5 ships device flow alone but keeps this seam, so a manual
    // code entry or a vendor-proprietary "device auth" is one implementation
    // rather than a rewrite.
    const store = new MemoryTokenStore();
    const stubGrant: Grant<never> = {
      grantType: 'urn:example:manual',
      authorize: async () =>
        new TokenSet({
          accessToken: 'from-other-grant',
          tokenType: 'Bearer',
          expiresAt: null,
          refreshToken: null,
          scope: [],
          obtainedAt: 0,
        }),
    };
    const client = new DeviceAuthClient({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      store,
      grant: stubGrant as never,
    });
    const tokens = await client.login();
    expect(tokens.accessToken).toBe('from-other-grant');
    // Storage, expiry, and redaction are the shared core, unchanged.
    expect((await store.load(client.storeKey))?.accessToken).toBe('from-other-grant');
  });

  it('names the RFC 8628 grant type on DeviceCodeGrant', () => {
    expect(new DeviceCodeGrant().grantType).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });
});

describe('non-goal: the toolkit writes nothing to a terminal', () => {
  it('produces no console output across a full login and refresh', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = makeClient(
        new Recorder(DEVICE_RESPONSE, [
          { status: 400, body: { error: 'authorization_pending' } },
          { status: 400, body: { error: 'slow_down' } },
          SUCCESS,
          { status: 400, body: { error: 'invalid_grant' } },
        ]),
      );
      await client.login();
      await expect(client.refresh()).rejects.toBeInstanceOf(RefreshFailedError);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
