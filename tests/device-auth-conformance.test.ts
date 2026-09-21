// Cross-SDK conformance harness for the RFC 8628 device-authorization
// client — asserts the TypeScript implementation matches the shared fixture
// corpus at apcore-toolkit/conformance/fixtures/device_auth.json. The Python
// and Rust SDKs run the same 57 cases through their own clients and must
// agree case-for-case.
//
// The normative behaviour lives in
// apcore-toolkit/docs/features/device-auth.md.
// Tracking issue: aiperceivable/apcore-toolkit#17.
//
// Harness conventions, taken from the fixture's own `description` — none of
// them are guessable, so they are restated here:
//   * `poll_delays[i]` is the sleep performed BEFORE `token_responses[i]`.
//     The first entry is therefore the initial wait, never 0.
//   * `polls_made` counts responses actually consumed. A case scripting more
//     responses than that is asserting the client STOPPED.
//   * `repeat_last_response: true` repeats the final scripted response
//     indefinitely (case 023, whose 15-minute deadline would otherwise need
//     180 literal entries).
//   * Wall clock is pinned to 1000 wherever a case asserts `expires_at` or
//     `obtained_at`. The POLLING clock stays monotonic and advances only by
//     the sleeps.
//   * `transport_error: true` is a scripted connection failure, not an HTTP
//     response.
//
// NO HTTP MOCKING. The state machine is pure over an injected monotonic
// clock and a scripted `AuthTransport`; only the discovery cases, which are
// about fetching well-known documents, script a `fetch`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  AuthTransportError,
  AuthorizationDeniedError,
  AuthorizationExpiredError,
  AuthorizationProtocolError,
  DeviceAuthClient,
  DeviceAuthConfig,
  DeviceAuthConfigError,
  DeviceCodeGrant,
  MemoryTokenStore,
  RefreshFailedError,
  TokenSet,
  classifyErrorBody,
  decodeResponse,
  discoveryCandidates,
  resolveMetadata,
  dispatchTokenResponse,
  encodeBody,
  makeStoreKey,
  normaliseFields,
  decodeBody,
  mergeFieldAliases,
  type AuthRequest,
  type AuthResponse,
  type AuthTransport,
  type DeviceAuthConfigInit,
  type DeviceAuthWarning,
  type RequestKind,
  type UserCodeEvent,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'apcore-toolkit',
  'conformance',
  'fixtures',
  'device_auth.json',
);

const DEVICE_ENDPOINT = 'https://e.example/device';
const TOKEN_ENDPOINT = 'https://e.example/token';

interface FixtureCase {
  id: string;
  kind: string;
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  notes?: string;
}

function loadCases(): FixtureCase[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  const data = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { test_cases: FixtureCase[] };
  return data.test_cases;
}

// ---------------------------------------------------------------------------
// snake_case fixture -> camelCase SDK. Kept in one function on purpose: the
// corpus is snake_case, this SDK's API is camelCase, and a silent
// camelCase-lookup-against-a-snake_case-source is the bug this repository
// already shipped once in TuiViewModel.
// ---------------------------------------------------------------------------

interface FixtureConfig {
  client_id?: string;
  client_secret?: string;
  client_auth_method?: string;
  scope_separator?: string;
  error_aliases?: Record<string, string>;
  field_aliases?: Record<string, string[]>;
  default_interval?: number;
  request_encoding?: Record<string, string>;
  issuer?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
}

function configFromFixture(
  raw: FixtureConfig | undefined,
  defaults: Partial<DeviceAuthConfigInit> = {},
): DeviceAuthConfigInit {
  const fixture = raw ?? {};
  const init: DeviceAuthConfigInit = {
    clientId: fixture.client_id ?? defaults.clientId ?? 'cid',
    ...defaults,
  };
  if (fixture.client_id !== undefined) init.clientId = fixture.client_id;
  if (fixture.client_secret !== undefined) init.clientSecret = fixture.client_secret;
  if (fixture.client_auth_method !== undefined) {
    init.clientAuthMethod = fixture.client_auth_method as DeviceAuthConfigInit['clientAuthMethod'];
  }
  if (fixture.scope_separator !== undefined) init.scopeSeparator = fixture.scope_separator;
  if (fixture.error_aliases !== undefined) init.errorAliases = fixture.error_aliases;
  if (fixture.field_aliases !== undefined) init.fieldAliases = fixture.field_aliases;
  if (fixture.default_interval !== undefined) init.defaultInterval = fixture.default_interval;
  if (fixture.request_encoding !== undefined) {
    init.requestEncoding = fixture.request_encoding as DeviceAuthConfigInit['requestEncoding'];
  }
  if (fixture.issuer !== undefined) init.issuer = fixture.issuer;
  if (fixture.token_endpoint !== undefined) init.tokenEndpoint = fixture.token_endpoint;
  if (fixture.device_authorization_endpoint !== undefined) {
    init.deviceAuthorizationEndpoint = fixture.device_authorization_endpoint;
  }
  return init;
}

// ---------------------------------------------------------------------------
// Scripted transport + injected clock. This pair is the whole reason no HTTP
// mocking is needed: the state machine sees a response sequence and a clock,
// nothing else.
// ---------------------------------------------------------------------------

interface ScriptedTokenResponse {
  status?: number;
  body?: Record<string, unknown>;
  content_type?: string;
  raw_body?: string;
  transport_error?: boolean;
}

class ScriptedTransport implements AuthTransport {
  /** Every request the client made, in order, for the `request`/`hook` cases. */
  readonly requests: AuthRequest[] = [];
  /** How many scripted token responses were consumed — the corpus's `polls_made`. */
  consumed = 0;

  constructor(
    private readonly deviceResponse: Record<string, unknown> | null,
    private readonly tokenResponses: ScriptedTokenResponse[],
    private readonly repeatLast = false,
  ) {}

  async send(request: AuthRequest): Promise<AuthResponse> {
    this.requests.push(request);
    if (request.kind === 'device') {
      return {
        status: 200,
        contentType: 'application/json',
        rawBody: JSON.stringify(this.deviceResponse ?? {}),
      };
    }
    let scripted = this.tokenResponses[this.consumed];
    if (scripted === undefined) {
      if (this.repeatLast && this.tokenResponses.length > 0) {
        scripted = this.tokenResponses[this.tokenResponses.length - 1];
      } else {
        throw new Error(
          `Scripted token responses exhausted after ${String(this.consumed)} — `
            + 'the client polled more times than the corpus expects.',
        );
      }
    }
    this.consumed += 1;
    if (scripted.transport_error === true) {
      throw new AuthTransportError('scripted connection failure');
    }
    return {
      status: scripted.status ?? 200,
      contentType: scripted.content_type ?? 'application/json',
      rawBody: scripted.raw_body ?? JSON.stringify(scripted.body ?? {}),
    };
  }
}

interface InjectedClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Recorded sleeps, in SECONDS — the corpus's `poll_delays`. */
  delays: number[];
}

function makeClock(): InjectedClock {
  let elapsedMs = 0;
  const delays: number[] = [];
  return {
    now: () => elapsedMs,
    sleep: async (ms: number) => {
      delays.push(ms / 1000);
      elapsedMs += ms;
    },
    delays,
  };
}

/** Wall clock pinned to 1000, per the fixture's convention. */
const PINNED_WALL_CLOCK = 1000;

function pinnedWallClock(value = PINNED_WALL_CLOCK): () => number {
  return () => value;
}

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

type Outcome = 'success' | 'access_denied' | 'expired_token' | 'deadline_exceeded' | 'protocol_error';

function classifyOutcome(err: unknown): Outcome {
  if (err instanceof AuthorizationDeniedError) return 'access_denied';
  if (err instanceof AuthorizationExpiredError) {
    return err.deadlineExceeded ? 'deadline_exceeded' : 'expired_token';
  }
  if (err instanceof AuthorizationProtocolError) return 'protocol_error';
  throw err;
}

interface PollRun {
  outcome: Outcome;
  tokens: TokenSet | null;
  delays: number[];
  pollsMade: number;
  transport: ScriptedTransport;
  userCodeEvents: { userCode: string; verificationUri: string; verificationUriComplete: string | null }[];
}

async function runPollCase(tc: FixtureCase): Promise<PollRun> {
  const input = tc.input as {
    device_response: Record<string, unknown>;
    token_responses: ScriptedTokenResponse[];
    config?: FixtureConfig;
    repeat_last_response?: boolean;
  };
  const transport = new ScriptedTransport(
    input.device_response,
    input.token_responses,
    input.repeat_last_response === true,
  );
  const clock = makeClock();
  const userCodeEvents: PollRun['userCodeEvents'] = [];
  const client = new DeviceAuthClient({
    ...configFromFixture(input.config, {
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    store: new MemoryTokenStore(),
    transport,
    clock: clock.now,
    sleep: clock.sleep,
    wallClock: pinnedWallClock(),
  });

  let outcome: Outcome = 'success';
  let tokens: TokenSet | null = null;
  try {
    tokens = await client.login({
      onUserCode: (event) => {
        userCodeEvents.push({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          verificationUriComplete: event.verificationUriComplete,
        });
      },
    });
  } catch (err) {
    outcome = classifyOutcome(err);
  }
  return {
    outcome,
    tokens,
    delays: clock.delays,
    pollsMade: transport.consumed,
    transport,
    userCodeEvents,
  };
}

function assertPollExpectations(tc: FixtureCase, run: PollRun): void {
  const expected = tc.expected as {
    outcome: Outcome;
    poll_delays?: number[];
    poll_delays_length?: number;
    poll_delays_all_equal?: number;
    final_interval?: number;
    polls_made?: number;
    token_set?: Record<string, unknown>;
  };
  const label = `Case ${tc.id}: ${tc.description}`;

  expect(run.outcome, label).toBe(expected.outcome);
  if (expected.poll_delays !== undefined) {
    expect(run.delays, `${label} — poll_delays`).toEqual(expected.poll_delays);
  }
  if (expected.poll_delays_length !== undefined) {
    expect(run.delays.length, `${label} — poll_delays length`).toBe(expected.poll_delays_length);
  }
  if (expected.poll_delays_all_equal !== undefined) {
    const unique = [...new Set(run.delays)];
    expect(unique, `${label} — every poll delay`).toEqual([expected.poll_delays_all_equal]);
  }
  if (expected.final_interval !== undefined) {
    // The final interval is the last sleep the machine performed; every
    // `final_interval` in the corpus equals the last `poll_delays` entry.
    expect(run.delays[run.delays.length - 1], `${label} — final_interval`).toBe(
      expected.final_interval,
    );
  }
  if (expected.polls_made !== undefined) {
    expect(run.pollsMade, `${label} — polls_made`).toBe(expected.polls_made);
  }
  if (expected.token_set !== undefined) {
    const tokens = run.tokens;
    expect(tokens, `${label} — expected a TokenSet`).not.toBeNull();
    const ts = tokens as TokenSet;
    if ('token_type' in expected.token_set) {
      expect(ts.tokenType, `${label} — token_type`).toBe(expected.token_set.token_type);
    }
    if ('scope' in expected.token_set) {
      expect([...ts.scope], `${label} — scope`).toEqual(expected.token_set.scope);
    }
    if ('expires_at' in expected.token_set) {
      expect(ts.expiresAt, `${label} — expires_at`).toBe(expected.token_set.expires_at);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

function runExpiryCase(tc: FixtureCase): void {
  const input = tc.input as {
    token_set: { expires_at: number | null };
    now: number;
    skew_seconds?: number;
  };
  const tokens = new TokenSet({
    accessToken: 'access',
    tokenType: 'Bearer',
    expiresAt: input.token_set.expires_at,
    refreshToken: null,
    scope: [],
    obtainedAt: 0,
  });
  const actual = tokens.isExpired({
    skewSeconds: input.skew_seconds,
    now: () => input.now,
  });
  expect(actual, `Case ${tc.id}: ${tc.description}`).toBe(tc.expected.is_expired);
}

async function runRefreshCase(tc: FixtureCase): Promise<void> {
  const input = tc.input as {
    stored: Record<string, unknown>;
    response: { status: number; body: Record<string, unknown> };
    now: number;
    config?: FixtureConfig;
  };
  const label = `Case ${tc.id}: ${tc.description}`;

  const store = new MemoryTokenStore();
  const transport = new ScriptedTransport(null, [input.response]);
  const client = new DeviceAuthClient({
    ...configFromFixture(input.config, {
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    store,
    transport,
    wallClock: pinnedWallClock(input.now),
  });
  await store.save(
    client.storeKey,
    new TokenSet({
      accessToken: input.stored.access_token as string,
      tokenType: 'Bearer',
      expiresAt: (input.stored.expires_at as number | undefined) ?? null,
      refreshToken: (input.stored.refresh_token as string | undefined) ?? null,
      scope: (input.stored.scope as string[] | undefined) ?? [],
      obtainedAt: 0,
    }),
  );

  const expected = tc.expected as {
    outcome: string;
    stored: Record<string, unknown> | null;
    store_cleared?: boolean;
  };

  if (expected.outcome === 'success') {
    await client.refresh();
    const stored = await store.load(client.storeKey);
    expect(stored, `${label} — a record must remain`).not.toBeNull();
    const record = stored as TokenSet;
    const want = expected.stored as Record<string, unknown>;
    expect(record.accessToken, `${label} — access_token`).toBe(want.access_token);
    expect(record.refreshToken, `${label} — refresh_token (rotation replaces it)`).toBe(
      want.refresh_token,
    );
    expect(record.expiresAt, `${label} — expires_at`).toBe(want.expires_at);
    expect([...record.scope], `${label} — scope is replaced wholesale, never merged`).toEqual(
      want.scope,
    );
    return;
  }

  await expect(client.refresh(), `${label} — invalid_grant is terminal`).rejects.toBeInstanceOf(
    RefreshFailedError,
  );
  expect(await store.load(client.storeKey), `${label} — the store is cleared`).toBeNull();
}

function runRedactionCase(tc: FixtureCase): void {
  const input = tc.input as { token_set: Record<string, unknown> };
  const tokens = new TokenSet({
    accessToken: input.token_set.access_token as string,
    tokenType: (input.token_set.token_type as string | undefined) ?? 'Bearer',
    expiresAt: (input.token_set.expires_at as number | undefined) ?? null,
    refreshToken: (input.token_set.refresh_token as string | undefined) ?? null,
    scope: (input.token_set.scope as string[] | undefined) ?? [],
    obtainedAt: 0,
  });
  const forbidden = tc.expected.must_not_contain as string[];
  const label = `Case ${tc.id}: ${tc.description}`;

  // Every rendering a developer can plausibly reach for. `console.log` of an
  // object in Node goes through util.inspect, NOT toString, so covering only
  // toString would leave the most common leak path open.
  const renderings: Record<string, string> = {
    'String()': String(tokens),
    'toString()': tokens.toString(),
    'template literal': `${tokens}`,
    'util.inspect': inspect(tokens),
    'util.inspect(depth:null)': inspect(tokens, { depth: null }),
    'util.inspect nested': inspect({ credential: tokens }),
    'JSON.stringify': JSON.stringify(tokens),
    'JSON.stringify nested': JSON.stringify({ credential: tokens }),
  };
  for (const [how, rendered] of Object.entries(renderings)) {
    for (const secret of forbidden) {
      expect(rendered, `${label} — ${how} leaked ${secret}`).not.toContain(secret);
    }
  }
}

async function runParseCase(tc: FixtureCase): Promise<void> {
  const input = tc.input as {
    content_type: string;
    raw_body: string;
    status?: number;
    as?: string;
  };
  const label = `Case ${tc.id}: ${tc.description}`;
  const config = new DeviceAuthConfig({
    clientId: 'cid',
    deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
  });
  const ctx = { config, transport: new ScriptedTransport(null, []) };
  const response: AuthResponse = {
    status: input.status ?? 200,
    contentType: input.content_type,
    rawBody: input.raw_body,
  };

  if (tc.expected.outcome !== undefined) {
    // Fail-soft: an unknown error envelope becomes a protocol error that
    // CARRIES the raw body, never a crash on a missing key.
    const dispatch = await dispatchTokenResponse(ctx, response, 'token');
    expect(dispatch.action, `${label} — outcome`).toBe(tc.expected.outcome);
    if (tc.expected.raw_body_preserved === true) {
      expect(
        dispatch.action === 'protocol_error' ? dispatch.rawBody : null,
        `${label} — raw body preserved`,
      ).toBe(input.raw_body);
    }
    return;
  }

  const kind: RequestKind = input.as === 'device' ? 'device' : 'token';
  const parsed = await decodeResponse(ctx, kind, response);
  expect(parsed, `${label} — body must decode`).not.toBeNull();
  for (const [field, want] of Object.entries(tc.expected.parsed as Record<string, unknown>)) {
    expect((parsed as Record<string, unknown>)[field], `${label} — ${field}`).toEqual(want);
  }
}

async function runRequestCase(tc: FixtureCase): Promise<void> {
  const input = tc.input as {
    kind?: string;
    kinds?: string[];
    config?: FixtureConfig;
    params?: Record<string, unknown>;
  };
  const label = `Case ${tc.id}: ${tc.description}`;
  const kinds = input.kinds ?? [input.kind ?? 'device'];
  const scope = (input.params?.scope as string[] | undefined) ?? [];
  // `scope` is a first-class config field; every other fixture param is an
  // arbitrary provider-specific field, which is what `extra_*` is for.
  const extraParams = Object.fromEntries(
    Object.entries(input.params ?? {}).filter(([key]) => key !== 'scope'),
  ) as Record<string, string>;

  const transport = new ScriptedTransport(
    {
      device_code: 'dc',
      user_code: 'ABCD-EFGH',
      verification_uri: DEVICE_ENDPOINT,
      expires_in: 600,
      interval: 5,
    },
    // One denial ends the flow after exactly one token request.
    [{ status: 400, body: { error: 'access_denied' } }],
  );
  const clock = makeClock();
  const store = new MemoryTokenStore();
  const client = new DeviceAuthClient({
    ...configFromFixture(input.config, {
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    scope,
    extraDeviceParams: extraParams,
    extraTokenParams: extraParams,
    store,
    transport,
    clock: clock.now,
    sleep: clock.sleep,
    wallClock: pinnedWallClock(),
  });

  if (kinds.includes('device') || kinds.includes('token')) {
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
  }
  if (kinds.includes('refresh')) {
    // A separate scripted response for the refresh leg.
    const refreshTransport = new ScriptedTransport(null, [
      { status: 200, body: { access_token: 'new', token_type: 'Bearer', expires_in: 3600 } },
    ]);
    const refreshClient = new DeviceAuthClient({
      ...configFromFixture(input.config, {
        clientId: 'cid',
        deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
      }),
      scope,
      extraDeviceParams: extraParams,
      extraTokenParams: extraParams,
      store: new MemoryTokenStore(),
      transport: refreshTransport,
      wallClock: pinnedWallClock(),
    });
    await refreshClient.refresh(
      new TokenSet({
        accessToken: 'old',
        tokenType: 'Bearer',
        expiresAt: 0,
        refreshToken: 'r1',
        scope: [],
        obtainedAt: 0,
      }),
    );
    transport.requests.push(...refreshTransport.requests);
  }

  const expected = tc.expected as {
    body_contains?: Record<string, string>;
    body_excludes?: string[];
    headers_contain?: Record<string, string>;
    headers_exclude?: string[];
    encoding_by_kind?: Record<string, string>;
    basic_credentials_roundtrip?: Record<string, string>;
    form_body_roundtrip?: Record<string, string>;
  };

  for (const kind of kinds) {
    const request = transport.requests.find((r) => r.kind === kind);
    expect(request, `${label} — expected a ${kind} request`).toBeDefined();
    const req = request as AuthRequest;

    // Assert on the params map AND on the encoded body, so an encoding bug
    // cannot hide behind a correct params map.
    const encoded = encodeBody(req.encoding, req.params);
    const decodedBack =
      req.encoding === 'json'
        ? (JSON.parse(encoded.body) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(encoded.body));

    for (const [field, want] of Object.entries(expected.body_contains ?? {})) {
      expect(req.params[field], `${label} — ${kind} body ${field}`).toBe(want);
      expect(decodedBack[field], `${label} — ${kind} encoded body ${field}`).toBe(want);
    }
    for (const field of expected.body_excludes ?? []) {
      expect(req.params, `${label} — ${kind} body must not carry ${field}`).not.toHaveProperty(field);
      expect(decodedBack, `${label} — ${kind} encoded body must not carry ${field}`).not.toHaveProperty(
        field,
      );
    }
    for (const [header, want] of Object.entries(expected.headers_contain ?? {})) {
      expect(req.headers[header], `${label} — ${kind} header ${header}`).toBe(want);
    }
    for (const header of expected.headers_exclude ?? []) {
      expect(req.headers, `${label} — ${kind} must not send ${header}`).not.toHaveProperty(header);
    }
    if (expected.encoding_by_kind?.[kind] !== undefined) {
      expect(req.encoding, `${label} — ${kind} encoding`).toBe(expected.encoding_by_kind[kind]);
    }

    if (expected.basic_credentials_roundtrip !== undefined) {
      // Asserted the way a server reads it, NOT as exact bytes. Python's
      // quote_plus, JavaScript's URLSearchParams and encodeURIComponent, and
      // Rust's encoders spell space, `*` and `~` differently and all decode
      // identically, so pinning one spelling would force two SDKs to
      // hand-roll an encoder for no functional gain. What must not vary is
      // that encoding happens at all: raw concatenation round-trips the
      // secret's `+` back as a space and the server sees a different secret.
      const header = req.headers.Authorization;
      expect(header, `${label} — Basic header`).toMatch(/^Basic /);
      const decoded = atob(header.slice('Basic '.length));
      const separator = decoded.indexOf(':');
      expect(separator, `${label} — credentials must contain a ':'`).toBeGreaterThan(-1);
      const formDecode = (value: string): string =>
        (Object.values(Object.fromEntries(new URLSearchParams(`v=${value}`)))[0] ?? '');
      const roundTripped = {
        client_id: formDecode(decoded.slice(0, separator)),
        client_secret: formDecode(decoded.slice(separator + 1)),
      };
      for (const [field, want] of Object.entries(expected.basic_credentials_roundtrip)) {
        expect(roundTripped[field as 'client_id' | 'client_secret'], `${label} — ${field}`).toBe(want);
      }
    }

    if (expected.form_body_roundtrip !== undefined) {
      // Same reasoning: a conforming application/x-www-form-urlencoded body
      // is one that form-decodes back to what went in. `plus_only` is the
      // entry that catches no-encoding-at-all — a raw `a+b` decodes to `a b`.
      expect(req.encoding, `${label} — ${kind} must be form-encoded`).toBe('form');
      const roundTripped = Object.fromEntries(new URLSearchParams(encoded.body));
      for (const [field, want] of Object.entries(expected.form_body_roundtrip)) {
        expect(roundTripped[field], `${label} — ${kind} body ${field} round trip`).toBe(want);
      }
    }
  }
}

async function runCallbackCase(tc: FixtureCase): Promise<void> {
  const input = tc.input as {
    device_response: Record<string, unknown>;
    timeout_seconds?: number;
  };
  const label = `Case ${tc.id}: ${tc.description}`;
  const transport = new ScriptedTransport(input.device_response, [
    { status: 200, body: { access_token: 't', token_type: 'Bearer', expires_in: 3600 } },
  ]);
  const clock = makeClock();
  const events: UserCodeEvent[] = [];
  const client = new DeviceAuthClient({
    clientId: 'cid',
    deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    store: new MemoryTokenStore(),
    transport,
    clock: clock.now,
    sleep: clock.sleep,
    wallClock: pinnedWallClock(),
  });
  // A short `timeoutSeconds` may end the flow before the scripted success is
  // reached; the callback has already fired by then, which is the point.
  // Without a timeout the login must still succeed — swallowing that would
  // let a broken flow pass on the strength of the callback alone.
  try {
    await client.login({
      timeoutSeconds: input.timeout_seconds,
      onUserCode: (event) => events.push(event),
    });
  } catch (err) {
    if (input.timeout_seconds === undefined) throw err;
  }

  expect(events.length, `${label} — onUserCode fires exactly once`).toBe(1);
  const expected = tc.expected.on_user_code as Record<string, unknown>;
  const event = events[0];
  expect(event.verificationUri, `${label} — verification_uri`).toBe(expected.verification_uri);
  expect(event.userCode, `${label} — user_code`).toBe(expected.user_code);
  expect(event.verificationUriComplete, `${label} — verification_uri_complete`).toBe(
    expected.verification_uri_complete,
  );
  expect(event.expiresIn, `${label} — expires_in (the EFFECTIVE deadline)`).toBe(
    expected.expires_in,
  );
}

function runAliasValidationCase(tc: FixtureCase): void {
  const input = tc.input as { error_aliases: Record<string, string> };
  const label = `Case ${tc.id}: ${tc.description}`;
  const build = (): DeviceAuthConfig =>
    new DeviceAuthConfig({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      errorAliases: input.error_aliases,
    });
  if (tc.expected.valid === true) {
    expect(build, label).not.toThrow();
  } else {
    expect(build, label).toThrow(DeviceAuthConfigError);
  }
}

function runDiscoveryUrlCase(tc: FixtureCase): void {
  const input = tc.input as { issuer: string };
  const label = `Case ${tc.id}: ${tc.description}`;
  const candidates = discoveryCandidates(input.issuer);
  if (tc.expected.candidates !== undefined) {
    expect(candidates, `${label} — candidate order`).toEqual(tc.expected.candidates);
  }
  if (tc.expected.third_candidate !== undefined) {
    expect(candidates[2], `${label} — OIDC append`).toBe(tc.expected.third_candidate);
  }
}

interface ScriptedDiscoveryResponse {
  status: number;
  content_type?: string;
  raw_body: string;
}

async function runDiscoveryCase(tc: FixtureCase): Promise<void> {
  const input = tc.input as {
    config: FixtureConfig;
    metadata?: Record<string, unknown>;
    responses?: ScriptedDiscoveryResponse[];
  };
  const label = `Case ${tc.id}: ${tc.description}`;

  // A case supplying `metadata` gets it served at the first candidate; a case
  // supplying `responses` gets them in candidate order. Exhausted candidates
  // answer 404, so a rejected document falls through to the next one rather
  // than hanging the harness.
  const scripted: ScriptedDiscoveryResponse[] =
    input.responses
    ?? [{ status: 200, content_type: 'application/json', raw_body: JSON.stringify(input.metadata) }];
  let fetched = 0;
  const fetchImpl = (async () => {
    const next = scripted[fetched];
    fetched += 1;
    if (next === undefined) return new Response('', { status: 404 });
    return new Response(next.raw_body, {
      status: next.status,
      headers: { 'content-type': next.content_type ?? 'application/json' },
    });
  }) as unknown as typeof fetch;

  const warnings: DeviceAuthWarning[] = [];
  const config = new DeviceAuthConfig({
    ...configFromFixture(input.config, { clientId: 'cid' }),
    onWarning: (warning) => warnings.push(warning),
  });

  const expected = tc.expected as {
    accepted?: boolean;
    reason?: string;
    warned?: boolean;
    proceeds?: boolean;
    candidate_used?: number;
    token_endpoint?: string;
    device_authorization_endpoint?: string;
  };

  if (expected.accepted === false) {
    // Assert the DOCUMENT is rejected, not merely that discovery failed.
    // Cases 054 and 055 script metadata that also omits
    // `device_authorization_endpoint`, so `discover()` would throw either
    // way — checking only the throw would pass an implementation that
    // normalised the issuer before comparing. `resolveMetadata` is the
    // verbatim comparison itself.
    for (const scriptedResponse of scripted) {
      const document = JSON.parse(scriptedResponse.raw_body) as Record<string, unknown>;
      const resolution = resolveMetadata(input.config.issuer as string, document);
      expect(
        resolution.accepted,
        `${label} — metadata ${scriptedResponse.raw_body} must be rejected (${resolution.reason ?? ''})`,
      ).toBe(false);
      if (expected.reason !== undefined) {
        expect(resolution.reasonCode, `${label} — rejection reason`).toBe(expected.reason);
      }
    }
    await expect(config.discover({ fetchImpl }), `${label} — must be rejected`).rejects.toThrow();
    return;
  }

  const resolved = await config.discover({ fetchImpl });
  if (expected.proceeds !== undefined) {
    expect(expected.proceeds, `${label} — proceeds`).toBe(true);
  }
  if (expected.warned !== undefined) {
    expect(warnings.length > 0, `${label} — warned (${JSON.stringify(warnings)})`).toBe(
      expected.warned,
    );
  }
  if (expected.candidate_used !== undefined) {
    expect(fetched, `${label} — candidate used (1-based)`).toBe(expected.candidate_used);
  }
  if (expected.token_endpoint !== undefined) {
    expect(resolved.tokenEndpoint, `${label} — token_endpoint`).toBe(expected.token_endpoint);
  }
  if (expected.device_authorization_endpoint !== undefined) {
    expect(
      resolved.deviceAuthorizationEndpoint,
      `${label} — device_authorization_endpoint`,
    ).toBe(expected.device_authorization_endpoint);
  }
}

async function runHookCase(tc: FixtureCase, allCases: FixtureCase[]): Promise<void> {
  const input = tc.input as {
    hook?: string;
    hooks?: Record<string, unknown>;
    returns?: unknown;
    body?: Record<string, unknown>;
    config?: FixtureConfig;
    content_type?: string;
    raw_body?: string;
    baseline_case?: string;
  };
  const label = `Case ${tc.id}: ${tc.description}`;

  if (input.baseline_case !== undefined) {
    // With no hooks installed the output must be identical to the named
    // hook-free case. Re-run it and assert its own expectations hold.
    const baseline = allCases.find((c) => c.id === input.baseline_case);
    expect(baseline, `${label} — baseline case ${input.baseline_case} must exist`).toBeDefined();
    const run = await runPollCase(baseline as FixtureCase);
    assertPollExpectations(baseline as FixtureCase, run);
    return;
  }

  if (input.hook === 'transform_request') {
    const returns = input.returns as { params: Record<string, string>; headers: Record<string, string> };
    const transport = new ScriptedTransport(
      {
        device_code: 'dc',
        user_code: 'ABCD-EFGH',
        verification_uri: DEVICE_ENDPOINT,
        expires_in: 600,
        interval: 5,
      },
      [{ status: 400, body: { error: 'access_denied' } }],
    );
    const clock = makeClock();
    const client = new DeviceAuthClient({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      store: new MemoryTokenStore(),
      transport,
      clock: clock.now,
      sleep: clock.sleep,
      wallClock: pinnedWallClock(),
      hooks: {
        transformRequest: (_kind, params, headers) => ({
          params: { ...params, ...returns.params },
          headers: { ...headers, ...returns.headers },
        }),
      },
    });
    await expect(client.login()).rejects.toBeInstanceOf(AuthorizationDeniedError);
    const expected = tc.expected as {
      body_contains: Record<string, string>;
      headers_contain: Record<string, string>;
    };
    for (const request of transport.requests) {
      for (const [field, want] of Object.entries(expected.body_contains)) {
        expect(request.params[field], `${label} — ${request.kind} body ${field}`).toBe(want);
      }
      for (const [header, want] of Object.entries(expected.headers_contain)) {
        expect(request.headers[header], `${label} — ${request.kind} header ${header}`).toBe(want);
      }
    }
    return;
  }

  if (input.hook === 'parse_response') {
    const config = new DeviceAuthConfig({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      hooks: { parseResponse: () => input.returns as null },
    });
    const parsed = await decodeResponse(
      { config, transport: new ScriptedTransport(null, []) },
      'token',
      {
        status: 200,
        contentType: input.content_type ?? 'application/json',
        rawBody: input.raw_body ?? '{}',
      },
    );
    expect(parsed, `${label} — built-in parser must be used`).not.toBeNull();
    for (const [field, want] of Object.entries(tc.expected.parsed as Record<string, unknown>)) {
      expect((parsed as Record<string, unknown>)[field], `${label} — ${field}`).toEqual(want);
    }
    return;
  }

  // classify_error cases (045, 046, 047).
  const config = new DeviceAuthConfig({
    ...configFromFixture(input.config, {
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    hooks: { classifyError: () => input.returns as string | null },
  });
  const ctx = { config, transport: new ScriptedTransport(null, []) };
  // Case 045 supplies no body. The hook is only consulted once aliasing has
  // failed to produce a standard identifier, so the body must carry an error
  // the built-in path cannot resolve — otherwise the invalid return value
  // would never be reached.
  const body = input.body ?? { error: 'vendor_specific_unknown' };

  if (tc.expected.raises === true) {
    await expect(classifyErrorBody(ctx, body), `${label} — invalid return is rejected`).rejects.toThrow(
      /classifyError returned/,
    );
    return;
  }
  const identifier = await classifyErrorBody(ctx, body);
  expect(identifier, `${label} — identifier`).toBe(tc.expected.identifier ?? null);

  if (tc.expected.outcome !== undefined) {
    // An unresolved identifier plus a hook with no opinion must fall through
    // to the default outcome, which is a protocol error — not a silently
    // swallowed poll.
    const dispatch = await dispatchTokenResponse(
      ctx,
      { status: 400, contentType: 'application/json', rawBody: JSON.stringify(body) },
      'token',
    );
    expect(dispatch.action, `${label} — outcome`).toBe(tc.expected.outcome);
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const cases = loadCases();

describe.skipIf(cases.length === 0)('device authorization flow — cross-SDK conformance', () => {
  it('loads the whole corpus', () => {
    expect(cases.length, 'the corpus ships 65 cases').toBe(65);
  });

  for (const tc of cases) {
    it(`${tc.id}: ${tc.description}`, async () => {
      switch (tc.kind) {
        case 'poll': {
          const run = await runPollCase(tc);
          assertPollExpectations(tc, run);
          return;
        }
        case 'expiry':
          runExpiryCase(tc);
          return;
        case 'refresh':
          await runRefreshCase(tc);
          return;
        case 'redaction':
          runRedactionCase(tc);
          return;
        case 'callback':
          await runCallbackCase(tc);
          return;
        case 'parse':
          await runParseCase(tc);
          return;
        case 'request':
          await runRequestCase(tc);
          return;
        case 'alias_validation':
          runAliasValidationCase(tc);
          return;
        case 'discovery_url':
          runDiscoveryUrlCase(tc);
          return;
        case 'discovery':
          await runDiscoveryCase(tc);
          return;
        case 'hook':
          await runHookCase(tc, cases);
          return;
        default:
          throw new Error(`Unhandled fixture kind "${tc.kind}" in case ${tc.id}`);
      }
    });
  }
});

describe.skipIf(cases.length === 0)('corpus coverage', () => {
  it('every case kind has a runner', () => {
    const kinds = [...new Set(cases.map((c) => c.kind))].sort();
    expect(kinds).toEqual([
      'alias_validation',
      'callback',
      'discovery',
      'discovery_url',
      'expiry',
      'hook',
      'parse',
      'poll',
      'redaction',
      'refresh',
      'request',
    ]);
  });

  it('case 038 keeps the user code byte-for-byte on the way to the callback', async () => {
    // The corpus asserts this at the parse layer; this asserts it survives
    // all the way to `onUserCode`, which is where a well-meaning
    // `.toUpperCase()` would actually be added.
    const transport = new ScriptedTransport(
      {
        device_code: 'dc',
        user_code: 'wdjb-mjht',
        verification_uri: DEVICE_ENDPOINT,
        expires_in: 600,
        interval: 5,
      },
      [{ status: 200, body: { access_token: 't', token_type: 'Bearer', expires_in: 3600 } }],
    );
    const clock = makeClock();
    const seen: string[] = [];
    const client = new DeviceAuthClient({
      clientId: 'cid',
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      store: new MemoryTokenStore(),
      transport,
      clock: clock.now,
      sleep: clock.sleep,
      wallClock: pinnedWallClock(),
    });
    await client.login({ onUserCode: (event) => seen.push(event.userCode) });
    expect(seen).toEqual(['wdjb-mjht']);
  });

  it('normalises nothing a provider did not ask for', () => {
    // Guard for the TuiViewModel class of bug: a camelCase lookup against a
    // snake_case source silently reads undefined.
    const aliases = mergeFieldAliases();
    const body = decodeBody('application/json', '{"verification_url":"https://x.example"}');
    const normalised = normaliseFields(body as Record<string, unknown>, aliases);
    expect(normalised.verification_uri).toBe('https://x.example');
    expect(normalised.verification_url).toBe('https://x.example');
    expect((normalised as Record<string, unknown>).verificationUri).toBeUndefined();
  });

  it('keys the store as "<issuer>|<client_id>"', () => {
    expect(makeStoreKey('https://auth.example.com', 'apcore-cli')).toBe(
      'https://auth.example.com|apcore-cli',
    );
  });

  it('ships DeviceCodeGrant as an implementation of the Grant seam', () => {
    expect(new DeviceCodeGrant().grantType).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });
});
