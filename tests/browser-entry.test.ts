import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as browser from '../src/browser/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..', 'src');
const BROWSER_ENTRY = resolve(SRC_ROOT, 'browser', 'index.ts');

const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'crypto', 'child_process', 'url', 'util',
  'stream', 'events', 'buffer', 'process', 'module', 'http', 'https',
  'net', 'tls', 'dns', 'zlib', 'readline', 'vm', 'worker_threads',
  'perf_hooks', 'assert', 'querystring', 'string_decoder',
]);

function isNodeSpecifier(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  if (NODE_BUILTINS.has(spec)) return true;
  if (spec.startsWith('fs/') || spec.startsWith('path/')) return true;
  return false;
}

function collectImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^'"]*\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specifiers.push(m[1]);
  }
  return specifiers;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const withoutJs = spec.endsWith('.js') ? spec.slice(0, -3) : spec;
  const base = resolve(dirname(fromFile), withoutJs);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`Could not resolve relative import "${spec}" from ${fromFile}`);
}

interface StaticCheckFinding {
  file: string;
  reason: string;
}

function walkBrowserGraph(): StaticCheckFinding[] {
  const findings: StaticCheckFinding[] = [];
  const visited = new Set<string>();
  const stack: string[] = [BROWSER_ENTRY];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const src = readFileSync(file, 'utf8');
    const rel = file.slice(SRC_ROOT.length + 1);

    // Strip line + block comments before pattern-matching to avoid false
    // positives from docstrings that reference `process.env.*` etc.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

    // Process-global references. `process` as a bare identifier implies Node
    // (or a polyfill). Browser envs don't provide it by default.
    if (/\bprocess\s*\./.test(code) || /\bprocess\.env\b/.test(code)) {
      findings.push({ file: rel, reason: 'references global `process`' });
    }

    // createRequire / import.meta.url + require patterns — Node-only.
    if (/\bcreateRequire\s*\(/.test(code)) {
      findings.push({ file: rel, reason: 'uses `createRequire`' });
    }

    // Enumerate every import/export specifier; flag Node builtins and recurse
    // into relative imports so we audit the full transitive graph.
    for (const spec of collectImports(src)) {
      if (isNodeSpecifier(spec)) {
        findings.push({ file: rel, reason: `imports Node builtin "${spec}"` });
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec);
        if (resolved) stack.push(resolved);
      }
      // Bare package imports (e.g. 'apcore-js') are peer deps and assumed
      // browser-safe — out of scope for this static check.
    }
  }

  return findings;
}

describe('browser entry point', () => {
  it('exposes the expected browser-safe symbols', () => {
    const expected = [
      // Core types & scanned-module utilities
      'createScannedModule',
      'cloneModule',
      'BaseScanner',
      // HTTP verb mapping
      'SCANNER_VERB_MAP',
      'hasPathParams',
      'resolveHttpVerb',
      'generateSuggestedAlias',
      'extractPathParamNames',
      'substitutePathParams',
      // Schema / OpenAPI
      'enrichSchemaDescriptions',
      'resolveRef',
      'resolveSchema',
      'deepResolveRefs',
      'extractInputSchema',
      'extractOutputSchema',
      // Serializers & formatting
      'annotationsToDict',
      'moduleToDict',
      'modulesToDicts',
      'toMarkdown',
      // Binding parsing (runtime-neutral half of BindingLoader)
      'BindingParser',
      'BindingLoadError',
      'parseBindingDocument',
      // Write-pipeline types & errors
      'createWriteResult',
      'WriteError',
      'InvalidFormatError',
      // Runtime-neutral verifier primitives
      'RegistryVerifier',
      'runVerifierChain',
      // HTTP proxy writer
      'HTTPProxyRegistryWriter',
      'HTTPProxyRegistryWriterError',
      // OpenAPI scanner (pure)
      'OpenAPIScanner',
      'deriveModuleId',
      'InvalidSpecError',
      // TUI view model (pure)
      'modulesToViewModel',
      'formatViewModel',
      // Device authorization flow — the runtime-neutral half
      'TokenSet',
      'MemoryTokenStore',
      'makeStoreKey',
      'DeviceAuthConfig',
      'DeviceAuthClient',
      'DeviceCodeGrant',
      'FetchAuthTransport',
      'discoveryCandidates',
      'resolveMetadata',
      'validateErrorAliases',
      'formUrlEncodeComponent',
      'AuthorizationDeniedError',
      'AuthorizationExpiredError',
      'AuthorizationProtocolError',
      'NoCredentialError',
      'RefreshFailedError',
    ];
    for (const name of expected) {
      expect(browser, `expected "${name}" to be exported`).toHaveProperty(name);
    }
  });

  it('does not leak Node-only symbols', () => {
    // Symbols whose implementation touches node:fs / node:path / node:module
    // or references global `process` — these must stay out of /browser.
    const nodeOnly = [
      'YAMLWriter',
      'TypeScriptWriter',
      'RegistryWriter',
      'getWriter',
      'BindingLoader',
      'DisplayResolver',
      'AIEnhancer',
      'resolveTarget',
      'YAMLVerifier',
      'SyntaxVerifier',
      'MagicBytesVerifier',
      'JSONVerifier',
      'VERSION',
      'loadSpec',
      // FileTokenStore reads and writes the filesystem (node:fs, node:os,
      // node:path, process.env), so it stays on the Node entry point — the
      // same split that keeps BindingParser in /browser and BindingLoader
      // out of it. A browser consumer supplies its own TokenStore.
      'FileTokenStore',
      'defaultCredentialsPath',
    ];
    for (const name of nodeOnly) {
      expect(browser, `"${name}" must not be exported from /browser`).not.toHaveProperty(name);
    }
  });

  it('transitive dep graph has zero Node-only imports or globals', () => {
    const findings = walkBrowserGraph();
    const formatted = findings.map((f) => `  - ${f.file}: ${f.reason}`).join('\n');
    expect(findings, `Browser entry drags in Node-only code:\n${formatted}`).toEqual([]);
  });
});
