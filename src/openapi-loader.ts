/**
 * `loadSpec` — fetch/parse an OpenAPI document from a local path or
 * `http(s)://` URL.
 *
 * Convenience helper, explicitly outside the conformance corpus (I/O
 * behaviour is deliberately not byte-specified). The URL/path is taken
 * verbatim — no candidate paths are probed. See `Contract: load_spec` in
 * `apcore-toolkit/docs/features/openapi-scanner.md`.
 *
 * Kept in its own file (not `openapi-scanner.ts`) because it needs Node's
 * `fs` for the local-file-path branch, and `OpenAPIScanner` /
 * `deriveModuleId` are pure and re-exported from `apcore-toolkit/browser`.
 * Mirrors the existing `binding-parser.ts` (pure) / `binding-loader.ts`
 * (Node-only) split in this package.
 *
 * Security: `source` is trusted input. Callers taking a URL from an
 * untrusted source are responsible for their own allowlisting (SSRF) — see
 * the spec doc's Security Considerations.
 */

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

/** Options for {@link loadSpec}. */
export interface LoadSpecOptions {
  /** Extra request headers (API-version headers, tenant selectors, ...). Ignored for local files. */
  headers?: Record<string, string>;
  /** Callable returning auth headers, invoked once per fetch. Ignored for local files. */
  authHeaderFactory?: () => Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 30_000 (30s). Ignored for local files. */
  timeout?: number;
  /** Optional fetch implementation (primarily for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function parseDocument(text: string, source: string): Record<string, unknown> {
  const stripped = text.trimStart();
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    // JSON.parse throws SyntaxError natively on malformed input, matching
    // the doc's Contract ("Malformed JSON/YAML: ... TypeScript SyntaxError").
    return JSON.parse(text) as Record<string, unknown>;
  }
  let loaded: unknown;
  try {
    loaded = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SyntaxError(`loadSpec: malformed YAML spec at ${source}: ${msg}`);
  }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new SyntaxError(`loadSpec: malformed spec at ${source}: expected an object, got ${typeof loaded}`);
  }
  return loaded as Record<string, unknown>;
}

/**
 * Load and parse an OpenAPI document from a local filesystem path or an
 * `http(s)://` URL, taken verbatim (no candidate paths are probed).
 *
 * JSON-or-YAML is sniffed from the trimmed text: `{`/`[` parses as JSON
 * (via `JSON.parse`, whose `SyntaxError` propagates on malformed input);
 * anything else parses as YAML via `js-yaml` (already a dependency of this
 * package), with parse errors normalised to `SyntaxError` for the same
 * cross-SDK error contract.
 *
 * @throws {Error} File not found/unreadable, or HTTP non-2xx / network failure.
 * @throws {SyntaxError} Malformed JSON or YAML.
 */
export async function loadSpec(
  source: string,
  options: LoadSpecOptions = {},
): Promise<Record<string, unknown>> {
  const { headers, authHeaderFactory, timeout = 30_000, fetchImpl } = options;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const f = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      throw new Error(
        'loadSpec: global fetch is unavailable — pass `fetchImpl` explicitly or run on Node 20+.',
      );
    }

    const requestHeaders: Record<string, string> = { ...(headers ?? {}) };
    if (authHeaderFactory) {
      Object.assign(requestHeaders, authHeaderFactory());
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response: Response;
      let text: string;
      try {
        response = await f(source, { headers: requestHeaders, signal: controller.signal });
        text = await response.text();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`loadSpec: request to ${source} failed: ${msg}`);
      }
      if (!response.ok) {
        throw new Error(`loadSpec: request to ${source} failed with status ${response.status} ${response.statusText}`);
      }
      return parseDocument(text, source);
    } finally {
      clearTimeout(timer);
    }
  }

  let text: string;
  try {
    text = fs.readFileSync(source, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`loadSpec: failed to read ${source}: ${msg}`);
  }
  return parseDocument(text, source);
}
