// Unit tests for `loadSpec` — the `fetchImpl`-injectable HTTP/YAML/JSON
// loader in src/openapi-loader.ts. Deliberately outside the conformance
// corpus (see the file's own header comment); these tests own this SDK's
// I/O edges: injected-fetch success/failure and local-file-path loading.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadSpec } from '../src/index.js';

const dirs: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'apcore-openapi-loader-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function respond(body: string, status = 200, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('loadSpec — HTTP via injected fetchImpl', () => {
  it('fetches and parses a JSON spec', async () => {
    const fetchImpl = (async () =>
      respond(JSON.stringify({ openapi: '3.0.0', paths: {} }))) as unknown as typeof fetch;
    const spec = await loadSpec('https://api.example.com/openapi.json', { fetchImpl });
    expect(spec).toEqual({ openapi: '3.0.0', paths: {} });
  });

  it('fetches and parses a YAML spec', async () => {
    const yamlText = 'openapi: 3.0.0\npaths: {}\n';
    const fetchImpl = (async () => respond(yamlText, 200, 'application/yaml')) as unknown as typeof fetch;
    const spec = await loadSpec('https://api.example.com/openapi.yaml', { fetchImpl });
    expect(spec).toEqual({ openapi: '3.0.0', paths: {} });
  });

  it('merges static headers and authHeaderFactory into the request', async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return respond(JSON.stringify({ openapi: '3.0.0' }));
    }) as unknown as typeof fetch;
    await loadSpec('https://api.example.com/openapi.json', {
      fetchImpl,
      headers: { 'x-api-version': '2024-01' },
      authHeaderFactory: () => ({ authorization: 'Bearer t1' }),
    });
    expect(seenHeaders['x-api-version']).toBe('2024-01');
    expect(seenHeaders.authorization).toBe('Bearer t1');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => respond('not found', 404, 'text/plain')) as unknown as typeof fetch;
    await expect(loadSpec('https://api.example.com/openapi.json', { fetchImpl })).rejects.toThrow(
      /status 404/,
    );
  });

  it('throws when the fetch implementation rejects (network failure)', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.example.com');
    }) as unknown as typeof fetch;
    await expect(loadSpec('https://api.example.com/openapi.json', { fetchImpl })).rejects.toThrow(
      /request to https:\/\/api\.example\.com\/openapi\.json failed/,
    );
  });
});

describe('loadSpec — local file path', () => {
  it('loads and parses a local JSON file', async () => {
    const path = tempFile('spec.json', JSON.stringify({ openapi: '3.0.0', info: { title: 'x' } }));
    const spec = await loadSpec(path);
    expect(spec).toEqual({ openapi: '3.0.0', info: { title: 'x' } });
  });

  it('loads and parses a local YAML file', async () => {
    const path = tempFile('spec.yaml', 'openapi: 3.0.0\ninfo:\n  title: x\n');
    const spec = await loadSpec(path);
    expect(spec).toEqual({ openapi: '3.0.0', info: { title: 'x' } });
  });

  it('throws when the file does not exist (ENOENT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apcore-openapi-loader-'));
    dirs.push(dir);
    const missing = join(dir, 'missing.json');
    await expect(loadSpec(missing)).rejects.toThrow(/failed to read/);
  });

  it('throws a SyntaxError on malformed JSON', async () => {
    const path = tempFile('spec.json', '{ this is not valid json');
    await expect(loadSpec(path)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('throws a SyntaxError on malformed YAML', async () => {
    const path = tempFile('spec.yaml', 'openapi: [unterminated\n  - a\n bad: : indent\n');
    await expect(loadSpec(path)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('throws a SyntaxError when the parsed YAML is not an object', async () => {
    const path = tempFile('spec.yaml', '- just\n- a\n- list\n');
    await expect(loadSpec(path)).rejects.toBeInstanceOf(SyntaxError);
  });
});
