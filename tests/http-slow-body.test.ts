import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Context, Registry } from 'apcore-js';
import { describe, expect, it } from 'vitest';
import {
  AuthTransportError, DeviceAuthConfig, FetchAuthTransport,
  HTTPProxyRegistryWriter, createScannedModule, loadSpec,
} from '../src/index.js';

const TIMEOUT_MS = 200;

async function withDrippingServer(
  status: number,
  exercise: (base: string) => Promise<void>,
  discovery = false,
): Promise<void> {
  let chunksSent = 0;
  let requests = 0;
  let resolveClosed!: (early: boolean) => void;
  const bodyClosed = new Promise<boolean>(resolve => { resolveClosed = resolve; });
  const timers = new Set<ReturnType<typeof setInterval>>();
  let base = '';

  function drip(response: ServerResponse): void {
    const body = '{"ok":true}';
    let offset = 1;
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.write(body[0]);
    chunksSent += 1;
    const timer = setInterval(() => {
      response.write(body[offset++]);
      chunksSent += 1;
      if (offset === body.length) response.end();
    }, 60);
    timers.add(timer);
    response.once('close', () => {
      clearInterval(timer);
      timers.delete(timer);
      resolveClosed(!response.writableFinished);
    });
  }

  const server = createServer((request, response) => {
    if (request.url === '/ready') { response.end('{}'); return; }
    request.resume();
    requests += 1;
    if (discovery && requests > 1) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        issuer: `${base}/tenant`, token_endpoint: `${base}/token`,
        device_authorization_endpoint: `${base}/device`,
      }));
      return;
    }
    drip(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await (await fetch(`${base}/ready`)).text();
    await exercise(base);
    expect(await bodyClosed).toBe(true);
    expect(chunksSent).toBeGreaterThan(1);
    expect(chunksSent).toBeLessThan(11);
    if (discovery) expect(requests).toBe(2);
  } finally {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('real HTTP slow-body deadlines', () => {
  it.each([200, 500])('aborts proxy status %s while chunks keep arriving and closes the connection', async (status) => {
    await withDrippingServer(status, async base => {
      const registry = new Registry();
      const writer = new HTTPProxyRegistryWriter({ baseUrl: base, timeoutMs: TIMEOUT_MS });
      expect(writer.write([createScannedModule({
        moduleId: 'probe.get', description: 'probe', target: 'probe:get',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, tags: [],
        metadata: { httpMethod: 'GET', urlPath: '/drip' },
      })], registry)[0].verified).toBe(true);
      const module = registry.get('probe.get') as unknown as {
        execute(inputs: Record<string, unknown>, ctx: Context): Promise<Record<string, unknown>>;
      };
      await expect(module.execute({}, Context.create())).rejects.toMatchObject({ code: 'MODULE_EXECUTE_ERROR' });
    });
  });

  it('aborts OpenAPI loading while chunks keep arriving', async () => {
    await withDrippingServer(200, async base => {
      await expect(loadSpec(`${base}/drip`, { timeout: TIMEOUT_MS })).rejects.toThrow('request');
    });
  });

  it.each([200, 400])('aborts authentication status %s while chunks keep arriving', async (status) => {
    await withDrippingServer(status, async base => {
      await expect(new FetchAuthTransport().send({
        kind: 'token', url: `${base}/token`, params: {}, headers: {},
        encoding: 'form', timeoutMs: TIMEOUT_MS,
      })).rejects.toBeInstanceOf(AuthTransportError);
    });
  });

  it('closes a dripping discovery candidate and accepts the next candidate', async () => {
    await withDrippingServer(200, async base => {
      const config = new DeviceAuthConfig({ clientId: 'probe', issuer: `${base}/tenant`, httpTimeoutMs: TIMEOUT_MS });
      await expect(config.discover()).resolves.toMatchObject({ tokenEndpoint: `${base}/token` });
    }, true);
  });
});
