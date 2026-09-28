// Hand-written regression tests for openapi-scanner.ts, complementing the
// shared-fixture conformance suite. These cover module_id normalisation
// edge cases the corpus does not (non-ASCII, astral characters,
// idempotence), the legality warning, and malformed/non-conforming
// field-type handling found by a cross-SDK audit comparing this port
// against the Python reference and Rust port.

import { describe, it, expect } from 'vitest';
import { OpenAPIScanner, deriveModuleId, normalizeModuleId } from '../src/openapi-scanner.js';
import type { OpenAPIScanOptions } from '../src/openapi-scanner.js';
import * as rootEntry from '../src/index.js';
import * as browserEntry from '../src/browser/index.js';

const BASE = { openapi: '3.0.3', info: { title: 't', version: '1.0.0' } };
const OK = { responses: { 200: { description: 'ok' } } };

function scan(paths: Record<string, unknown>, options: OpenAPIScanOptions = {}) {
  return new OpenAPIScanner().scan({ ...BASE, paths }, options);
}

function legalityWarning(id: string, segment: string): string {
  return (
    `module_id '${id}' is not a legal apcore module ID: segment '${segment}' ` +
    'must match ^[a-z][a-z0-9_]*$; name this operation with a derive_module_id ' +
    'or transform_module hook'
  );
}

// Expected values below were produced by the spec's Python reference
// implementation of normalize_module_id, not derived from this port.
describe('normalizeModuleId', () => {
  it.each([
    ['getHTTPResponse', 'get_http_response'],
    ['getUserID', 'get_user_id'],
    ['XMLHttpRequest', 'xml_http_request'],
    ['ABC', 'abc'],
    // Known ugly outputs, pinned rather than special-cased.
    ['OAuth2Token', 'o_auth2_token'],
    ['getIDs', 'get_i_ds'],
  ])('acronym boundary: %j -> %j', (input, expected) => {
    expect(normalizeModuleId(input)).toBe(expected);
  });

  it.each([
    ['v2Items', 'v2_items'],
    ['getV2', 'get_v2'],
    ['get2FA', 'get2_fa'],
  ])('digit boundary: %j -> %j', (input, expected) => {
    expect(normalizeModuleId(input)).toBe(expected);
  });

  it.each([
    ['get_product_product__product_id__get', 'get_product_product_product_id_get'],
    ['__private__', 'private'],
    ['a__.__b', 'a.b'],
    ['list-pets', 'list_pets'],
  ])('underscore runs and hyphens: %j -> %j', (input, expected) => {
    expect(normalizeModuleId(input)).toBe(expected);
  });

  it.each([
    ['Users.GetUser', 'users.get_user'],
    ['Custom-Space.GetThing', 'custom_space.get_thing'],
    ['x..y', 'x.y'],
    ['.a.', 'a'],
    ['', ''],
  ])('dot segments: %j -> %j', (input, expected) => {
    expect(normalizeModuleId(input)).toBe(expected);
  });

  // U+212A KELVIN SIGN lowercases to ASCII `k` under Unicode rules. The
  // alphabet replace runs BEFORE lowercasing, so it becomes `_` and cannot
  // survive as a letter; nor does `[A-Z]` (no `i` flag) see it as a capital.
  it('replaces U+212A KELVIN SIGN instead of lowercasing it to ASCII k', () => {
    expect('K'.toLowerCase()).toBe('k'); // the trap this ordering avoids
    expect(normalizeModuleId('Kelvin')).toBe('elvin');
    expect(normalizeModuleId('getKelvin')).toBe('get_elvin');
    expect(normalizeModuleId('K')).toBe('');
  });

  it('replaces other non-ASCII letters without inserting a word boundary', () => {
    expect(normalizeModuleId('caféMenu')).toBe('caf_menu');
  });

  it('collapses the two code units of an astral character to one underscore', () => {
    expect(normalizeModuleId('create\u{1F600}User')).toBe('create_user');
    expect(normalizeModuleId('a\u{1F600}\u{1F600}b')).toBe('a_b');
    expect(normalizeModuleId('\u{1F600}')).toBe('');
  });

  it('leaves a digit-leading segment in place (not repaired here)', () => {
    expect(normalizeModuleId('3ds')).toBe('3ds');
    expect(normalizeModuleId('v1.2fa.post')).toBe('v1.2fa.post');
  });

  it('is idempotent on its own output', () => {
    const inputs = [
      'getHTTPResponse', 'OAuth2Token', 'getIDs', 'v2Items', '__private__',
      'Custom-Space.GetThing', 'Kelvin', 'create\u{1F600}User', 'x..y',
      'already_snake.case', '3ds', 'Pet-Store.users.get', '',
    ];
    for (const input of inputs) {
      const once = normalizeModuleId(input);
      expect(normalizeModuleId(once), JSON.stringify(input)).toBe(once);
    }
  });

  it('is not re-exported from either package entry point', () => {
    expect('normalizeModuleId' in rootEntry).toBe(false);
    expect('normalizeModuleId' in browserEntry).toBe(false);
    expect(typeof rootEntry.deriveModuleId).toBe('function');
    expect(typeof browserEntry.deriveModuleId).toBe('function');
  });
});

describe('deriveModuleId', () => {
  it('converts a camelCase operationId to snake_case', () => {
    expect(deriveModuleId('/users/{id}', 'get', { operationId: 'getUserById' })).toBe('get_user_by_id');
  });

  it('falls back to the path when the operationId normalises to empty', () => {
    expect(deriveModuleId('/widgets', 'get', { operationId: '\u{1F600}' })).toBe('widgets.get');
    expect(deriveModuleId('/widgets', 'get', { operationId: '__' })).toBe('widgets.get');
  });

  it.each([
    ['/user-profiles/{userId}', 'get', 'user_profiles.user_id.get'],
    ['/v1/_debug/', 'get', 'v1.debug.get'],
    ['/a b/c', 'post', 'a_b.c.post'],
    ['/users', 'GET', 'users.get'],
    ['/{}/x', 'get', 'x.get'],
    ['/', 'get', 'root.get'],
  ])('normalises the path branch: %s %s -> %j', (path, method, expected) => {
    expect(deriveModuleId(path, method, {})).toBe(expected);
  });

  it('does not repair a digit-leading segment (the scanner warns, not this function)', () => {
    expect(deriveModuleId('/v1/2fa', 'post', {})).toBe('v1.2fa.post');
  });
});

describe('OpenAPIScanner — final module_id normalisation and legality', () => {
  it('keeps the raw operationId in metadata while the ID is normalised', () => {
    const [mod] = scan({ '/users/{id}': { get: { operationId: 'getUserById', ...OK } } });
    expect(mod!.moduleId).toBe('get_user_by_id');
    expect((mod!.metadata['openapi'] as Record<string, unknown>)['operation_id']).toBe('getUserById');
    expect(mod!.warnings).toEqual([]);
  });

  it('warns on a digit-leading segment from the path branch, and still emits', () => {
    const [mod] = scan({ '/v1/2fa': { post: OK } });
    expect(mod!.moduleId).toBe('v1.2fa.post');
    expect(mod!.warnings).toEqual([legalityWarning('v1.2fa.post', '2fa')]);
  });

  it('warns on a digit-leading operationId', () => {
    const [mod] = scan({ '/x': { get: { operationId: '3ds', ...OK } } });
    expect(mod!.moduleId).toBe('3ds');
    expect(mod!.warnings).toEqual([legalityWarning('3ds', '3ds')]);
  });

  it('warns with an empty segment when a hook produces an empty ID', () => {
    const [mod] = scan({ '/x': { get: OK } }, { deriveModuleId: () => '' });
    expect(mod!.moduleId).toBe('');
    expect(mod!.warnings).toEqual([legalityWarning('', '')]);
  });

  it('normalises basePathPrefix with the ID, and names the prefix when it is the illegal segment', () => {
    expect(scan({ '/users': { get: OK } }, { basePathPrefix: 'Pet-Store' })[0]!.moduleId).toBe(
      'pet_store.users.get',
    );
    const [mod] = scan({ '/users': { get: OK } }, { basePathPrefix: '2024' });
    expect(mod!.moduleId).toBe('2024.users.get');
    expect(mod!.warnings).toEqual([legalityWarning('2024.users.get', '2024')]);
  });

  it('normalises an ID set by transformModule without mutating the returned module', () => {
    let returned: { moduleId: string } | undefined;
    const [mod] = scan(
      { '/x': { get: OK } },
      {
        transformModule: (m) => {
          const next = { ...m, moduleId: 'Mixed-Case.GetThing' };
          returned = next;
          return next;
        },
      },
    );
    expect(mod!.moduleId).toBe('mixed_case.get_thing');
    expect(mod!.warnings).toEqual([]);
    expect(returned!.moduleId).toBe('Mixed-Case.GetThing');
  });

  it('filters on the normalised ID', () => {
    const modules = scan(
      { '/pets': { get: { operationId: 'listPets', ...OK }, post: { operationId: 'createPets', ...OK } } },
      { include: '^list_pets$' },
    );
    expect(modules.map((m) => m.moduleId)).toEqual(['list_pets']);
  });

  it('deduplicates a collision that only normalisation created', () => {
    const modules = scan({
      '/a': { get: { operationId: 'listPets', ...OK } },
      '/b': { get: { operationId: 'list-pets', ...OK } },
    });
    expect(modules.map((m) => m.moduleId)).toEqual(['list_pets', 'list_pets_2']);
    expect(modules[1]!.warnings).toEqual([
      "Module ID renamed from 'list_pets' to 'list_pets_2' to avoid collision",
    ]);
  });

  it('checks legality before deduplication, so the warning names the pre-rename ID', () => {
    const modules = scan({
      '/a': { get: { operationId: '3ds', ...OK } },
      '/b': { get: { operationId: '3ds', ...OK } },
    });
    expect(modules.map((m) => m.moduleId)).toEqual(['3ds', '3ds_2']);
    expect(modules[1]!.warnings).toEqual([
      legalityWarning('3ds', '3ds'),
      "Module ID renamed from '3ds' to '3ds_2' to avoid collision",
    ]);
  });
});

describe('OpenAPIScanner — malformed field-type handling', () => {
  it('does not treat a string "deprecated" value as deprecated (strict boolean)', () => {
    const modules = scan({
      '/widgets': { get: { deprecated: 'false', responses: { 200: { description: 'ok' } } } },
    });
    expect(modules).toHaveLength(1);
    expect(modules[0]!.annotations?.extra?.['deprecated']).not.toBe(true);
  });

  it('omits a non-string operationId from metadata.openapi.operation_id', () => {
    const modules = scan({
      '/widgets': { get: { operationId: 12345, responses: { 200: { description: 'ok' } } } },
    });
    expect(modules).toHaveLength(1);
    const openapiMeta = modules[0]!.metadata['openapi'] as Record<string, unknown>;
    expect(openapiMeta['operation_id']).toBeUndefined();
    expect(modules[0]!.moduleId).toBe('widgets.get');
  });

  // A non-BMP character (an emoji, a UTF-16 surrogate pair) is replaced
  // per code UNIT in JS — `__` — where Python and Rust emit one `_`. The
  // `_`-run collapse makes the three SDKs agree; the emoji sits mid-string
  // so an edge-strip cannot mask a double-underscore regression.
  it('normalises a non-BMP character (emoji) in operationId to exactly one underscore', () => {
    const id = deriveModuleId('/widgets', 'get', { operationId: 'create\u{1F600}User' });
    expect(id).toBe('create_user');
  });

  // Regression: `tags` was cast with `as string[]` — a compile-time-only
  // assertion with no runtime check — so non-string entries in a malformed
  // spec's `tags` array (a number, `null`, etc.) passed straight through
  // into `ScannedModule.tags`, violating its documented `string[]` type.
  it('filters non-string entries out of operation.tags', () => {
    const modules = scan({
      '/widgets': {
        get: {
          tags: ['users', 5, null, 'active'],
          responses: { 200: { description: 'ok' } },
        },
      },
    });
    expect(modules).toHaveLength(1);
    expect(modules[0]!.tags).toEqual(['users', 'active']);
  });
});
