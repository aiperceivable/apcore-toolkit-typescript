import { afterEach, describe, expect, it, vi } from 'vitest';
import { CancelToken, Context, ExecutionCancelledError, Registry } from 'apcore-js';
import {
  AuthTransportError, AuthorizationExpiredError, DeviceAuthConfig, DeviceCodeGrant,
  DiscoveryError, FetchAuthTransport, HTTPProxyRegistryWriter, createScannedModule, loadSpec,
  type AuthRequest, type AuthResponse, type AuthTransport, type GrantContext,
} from '../src/index.js';

/** Headers arrive immediately, but the body only terminates when the signal aborts. */
function stalledBodyFetch(status = 200): { fetchImpl: typeof fetch; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    }), { status });
  };
  return { fetchImpl, signals };
}

function proxy(fetchImpl: typeof fetch, timeout = 250, authHeaderFactory?: () => Record<string, string>) {
  const registry = new Registry();
  const writer = new HTTPProxyRegistryWriter({ baseUrl: 'https://example.test', fetchImpl, timeoutMs: timeout, authHeaderFactory });
  const results = writer.write([createScannedModule({
    moduleId: 'probe.get', description: 'probe', target: 'probe:get',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, tags: [],
    metadata: { httpMethod: 'GET', urlPath: '/probe' },
  })], registry);
  expect(results[0].verified).toBe(true);
  return registry.get('probe.get') as unknown as {
    execute(inputs: Record<string, unknown>, ctx: Context): Promise<Record<string, unknown>>;
  };
}

const authRequest: AuthRequest = {
  kind: 'token', url: 'https://example.test/token', params: {}, headers: {},
  encoding: 'form', timeoutMs: 250,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HTTP proxy cancellation', () => {
  it('rejects pre-cancelled calls before auth or HTTP work begins', async () => {
    const token = new CancelToken(); token.cancel();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const auth = vi.fn(() => ({}));
    await expect(proxy(fetchImpl, 250, auth).execute({}, Context.create(null, null, token)))
      .rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'])('aborts during %s and reports execution cancellation', async (phase) => {
    vi.useFakeTimers();
    const token = new CancelToken();
    const { fetchImpl: bodyFetch, signals } = stalledBodyFetch();
    const fetchImpl: typeof fetch = phase === 'body' ? bodyFetch : async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
    const outcome = proxy(fetchImpl).execute({}, Context.create(null, null, token))
      .then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    await vi.advanceTimersByTimeAsync(25);
    token.cancel();
    await vi.advanceTimersByTimeAsync(250);
    expect(signals[0].aborted).toBe(true);
    expect((await outcome).error).toBeInstanceOf(ExecutionCancelledError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a request if cancellation happens while credentials are resolved', async () => {
    const token = new CancelToken();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const module = proxy(fetchImpl, 250, () => { token.cancel(); return {}; });
    await expect(module.execute({}, Context.create(null, null, token)))
      .rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])('releases cancellation listeners and timers on %s', async (outcome) => {
    vi.useFakeTimers();
    const token = new CancelToken();
    const add = vi.spyOn(token.signal, 'addEventListener');
    const remove = vi.spyOn(token.signal, 'removeEventListener');
    const fetchImpl: typeof fetch = async () => {
      if (outcome === 'failure') throw new Error('offline');
      return new Response('{"ok":true}');
    };
    const result = proxy(fetchImpl).execute({}, Context.create(null, null, token));
    if (outcome === 'failure') await expect(result).rejects.toThrow('HTTP transport error');
    else await expect(result).resolves.toEqual({ ok: true });
    const added = add.mock.calls.filter(([name]) => name === 'abort');
    expect(added).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith('abort', added[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('HTTP timeouts cover response bodies', () => {
  it.each([200, 500])('bounds proxy body reads for status %s without a context token', async (status) => {
    vi.useFakeTimers();
    const { fetchImpl, signals } = stalledBodyFetch(status);
    const outcome = proxy(fetchImpl).execute({}, Context.create())
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(251);
    expect(signals[0].aborted).toBe(true);
    expect(await outcome).toMatchObject({ code: 'MODULE_EXECUTE_ERROR' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds OpenAPI body reads after receiving successful headers', async () => {
    vi.useFakeTimers();
    const { fetchImpl, signals } = stalledBodyFetch();
    const outcome = loadSpec('https://example.test/openapi.json', { fetchImpl, timeout: 250 })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(251);
    expect(signals[0].aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 400])('bounds authentication body reads for status %s', async (status) => {
    vi.useFakeTimers();
    const { fetchImpl, signals } = stalledBodyFetch(status);
    const outcome = new FetchAuthTransport(fetchImpl).send(authRequest)
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(251);
    expect(signals[0].aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(AuthTransportError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears completed OpenAPI and auth timers', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response('{}');
    };
    await loadSpec('https://example.test/openapi.json', { fetchImpl, timeout: 250 });
    await new FetchAuthTransport(fetchImpl).send(authRequest);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
  });
});

function grantHarness(options: { httpTimeoutMs?: number; interval?: number; tokenDelay?: number;
  tokenError?: boolean; hookDelay?: number; parseDelay?: number } = {}) {
  let elapsed = 0;
  const requests: AuthRequest[] = [];
  const sleeps: number[] = [];
  const response = (body: unknown): AuthResponse => ({
    status: 200, contentType: 'application/json', rawBody: JSON.stringify(body),
  });
  const transport: AuthTransport = {
    async send(request) {
      requests.push(request);
      if (request.kind === 'device') return response({
        device_code: 'dc', user_code: 'code', verification_uri: 'https://example.test/verify',
        expires_in: 7, interval: options.interval ?? 5,
      });
      elapsed += options.tokenDelay ?? 0;
      if (options.tokenError) throw new AuthTransportError('timeout');
      return response({ access_token: 'token', token_type: 'Bearer' });
    },
  };
  const ctx: GrantContext = {
    config: new DeviceAuthConfig({
      clientId: 'cid', deviceAuthorizationEndpoint: 'https://example.test/device',
      tokenEndpoint: 'https://example.test/token', httpTimeoutMs: options.httpTimeoutMs ?? 30000,
      hooks: {
        transformRequest: (kind) => { if (kind === 'token') elapsed += options.hookDelay ?? 0; return {}; },
        parseResponse: (kind) => { if (kind === 'token') elapsed += options.parseDelay ?? 0; return null; },
      },
    }), transport, clock: () => elapsed, wallClock: () => 1000,
    sleep: async ms => { sleeps.push(ms); elapsed += ms; }, warn: () => undefined,
  };
  return { ctx, requests, sleeps, elapsed: () => elapsed, advance: (ms: number) => { elapsed += ms; } };
}

describe('device grant flow deadline', () => {
  it.each([30000, 1000])('caps poll request timeout by remaining flow budget and configured %sms', async (httpTimeoutMs) => {
    const h = grantHarness({ httpTimeoutMs });
    await new DeviceCodeGrant().authorize(h.ctx);
    expect(h.requests[1].timeoutMs).toBe(Math.min(httpTimeoutMs, 2000));
  });

  it('caps sleep at the remaining deadline without sending another request', async () => {
    const h = grantHarness({ interval: 20 });
    await expect(new DeviceCodeGrant().authorize(h.ctx)).rejects.toBeInstanceOf(AuthorizationExpiredError);
    expect(h.sleeps).toEqual([7000]);
    expect(h.requests).toHaveLength(1);
  });

  it.each(['onPoll', 'transformRequest'])('does not send a poll after %s exhausts the budget', async (hook) => {
    const h = grantHarness({ hookDelay: hook === 'transformRequest' ? 3000 : 0 });
    await expect(new DeviceCodeGrant().authorize(h.ctx, {
      onPoll: hook === 'onPoll' ? () => h.advance(3000) : undefined,
    })).rejects.toBeInstanceOf(AuthorizationExpiredError);
    expect(h.requests).toHaveLength(1);
  });

  it('recomputes the remaining budget after request hooks', async () => {
    const h = grantHarness({ hookDelay: 500 });
    await new DeviceCodeGrant().authorize(h.ctx);
    expect(h.requests[1].timeoutMs).toBe(1500);
  });

  it.each(['response', 'parseResponse'])('rejects a success received after the deadline during %s', async (phase) => {
    const h = grantHarness({ tokenDelay: phase === 'response' ? 3000 : 0,
      parseDelay: phase === 'parseResponse' ? 3000 : 0 });
    await expect(new DeviceCodeGrant().authorize(h.ctx)).rejects.toMatchObject({ deadlineExceeded: true });
  });

  it('does not sleep again after an in-flight transport failure exhausts the budget', async () => {
    const h = grantHarness({ tokenDelay: 2000, tokenError: true });
    await expect(new DeviceCodeGrant().authorize(h.ctx)).rejects.toMatchObject({ deadlineExceeded: true });
    expect(h.elapsed()).toBe(7000);
    expect(h.sleeps).toEqual([5000]);
  });
});


describe('authentication discovery deadlines', () => {
  it('times out a stalled candidate body and tries the next candidate', async () => {
    vi.useFakeTimers();
    const { fetchImpl: stalled, signals } = stalledBodyFetch();
    let calls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      calls += 1;
      if (calls === 1) return stalled(url, init);
      return new Response(JSON.stringify({
        issuer: 'https://example.test', token_endpoint: 'https://example.test/token',
        device_authorization_endpoint: 'https://example.test/device',
      }));
    };
    const config = new DeviceAuthConfig({ clientId: 'cid', issuer: 'https://example.test', httpTimeoutMs: 250 });
    const result = config.discover({ fetchImpl });
    await vi.advanceTimersByTimeAsync(251);
    expect(signals[0]?.aborted).toBe(true);
    await expect(result).resolves.toMatchObject({ tokenEndpoint: 'https://example.test/token' });
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds every discovery candidate instead of hanging on the first one', async () => {
    vi.useFakeTimers();
    const { fetchImpl, signals } = stalledBodyFetch();
    const config = new DeviceAuthConfig({ clientId: 'cid', issuer: 'https://example.test', httpTimeoutMs: 250 });
    const result = config.discover({ fetchImpl }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(751);
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(await result).toBeInstanceOf(DiscoveryError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('counts onUserCode time against the issued device code deadline', async () => {
  const h = grantHarness();
  await expect(new DeviceCodeGrant().authorize(h.ctx, { onUserCode: () => h.advance(8000) }))
    .rejects.toMatchObject({ deadlineExceeded: true });
  expect(h.sleeps).toEqual([]);
  expect(h.requests).toHaveLength(1);
});
