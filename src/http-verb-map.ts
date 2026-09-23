/**
 * HTTP verb semantic mapping utilities.
 *
 * Provides the canonical mapping from HTTP methods to semantic verbs used
 * by scanner implementations when generating user-facing command aliases.
 * All functions are pure and do not throw.
 */

/**
 * Canonical HTTP method to semantic verb mapping.
 *
 * Keys are uppercase HTTP methods. `GET_ID` is a synthetic key used when
 * GET routes have path parameters (single-resource access). Values are
 * lowercase semantic verbs used by CLI and MCP surfaces. The mapping is
 * considered immutable by convention; downstream code MUST NOT mutate it.
 */
export const SCANNER_VERB_MAP: Readonly<Record<string, string>> = Object.freeze({
  GET: 'list',
  GET_ID: 'get',
  POST: 'create',
  PUT: 'update',
  PATCH: 'patch',
  DELETE: 'delete',
  HEAD: 'head',
  OPTIONS: 'options',
});

/**
 * Regex covering path parameter syntax across major frameworks:
 *   FastAPI / Django / OpenAPI: {param}
 *   Express / NestJS / Gin / Axum: :param
 */
const _PATH_PARAM_CORE = '\\{[^}]+\\}|:[a-zA-Z_]\\w*';
const PATH_PARAM_RE = new RegExp(_PATH_PARAM_CORE);

/**
 * Full-match variant of PATH_PARAM_RE for segment-level testing.
 * Anchored at both ends so the whole segment must be a parameter.
 */
const PATH_PARAM_FULL_RE = new RegExp(`^(?:${_PATH_PARAM_CORE})$`);

/**
 * Named-capture variant used by parameter extraction and substitution.
 * Mirrors Python's `_PATH_PARAM_NAMED_RE`.
 */
const PATH_PARAM_NAMED_RE = new RegExp('\\{(?<brace>[^}]+)\\}|:(?<colon>[a-zA-Z_]\\w*)', 'g');

/**
 * Check if a URL path contains path parameter placeholders.
 *
 * Detects both brace-style (`{param}`) and colon-style (`:param`) parameters,
 * covering all major web frameworks.
 *
 * @param path - URL path string (e.g., `/tasks/{id}` or `/users/:userId`).
 * @returns True if the path contains at least one path parameter, false otherwise.
 */
export function hasPathParams(path: string): boolean {
  if (typeof path !== 'string') return false;
  return PATH_PARAM_RE.test(path);
}

/**
 * Map an HTTP method to its semantic verb.
 *
 * GET is contextual: collection routes (no path params) map to `"list"`,
 * single-resource routes (with path params) map to `"get"`. All other
 * methods have a static mapping. Unknown methods fall through to
 * the lowercase form of the input.
 *
 * @param method - HTTP method string (case-insensitive).
 * @param pathHasParams - True if the corresponding route has path parameters.
 * @returns Semantic verb string (e.g., `"create"`, `"list"`, `"get"`).
 */
import { PROTO_DENY as _PROTO_DENY } from './safe-keys.js';

export function resolveHttpVerb(method: string, pathHasParams: boolean): string {
  if (typeof method !== 'string') return 'unknown';
  const methodUpper = method.toUpperCase();
  if (methodUpper === 'GET') {
    const key = pathHasParams ? 'GET_ID' : 'GET';
    return Object.hasOwn(SCANNER_VERB_MAP, key) ? SCANNER_VERB_MAP[key] : method.toLowerCase();
  }
  if (_PROTO_DENY.has(methodUpper)) return method.toLowerCase();
  return Object.hasOwn(SCANNER_VERB_MAP, methodUpper) ? SCANNER_VERB_MAP[methodUpper] : method.toLowerCase();
}

/**
 * Return the set of parameter *names* declared in a URL path.
 *
 * Recognises both brace-style (`/users/{id}`) and colon-style
 * (`/users/:id`) placeholders, so the output is consistent across
 * frameworks that use different conventions.
 *
 * @param path - URL path string.
 * @returns Set of parameter names with the surrounding punctuation stripped
 *   (e.g., `new Set(["id", "org_id"])`).
 */
export function extractPathParamNames(path: string): Set<string> {
  const names = new Set<string>();
  if (typeof path !== 'string') return names;
  PATH_PARAM_NAMED_RE.lastIndex = 0;
  for (const match of path.matchAll(PATH_PARAM_NAMED_RE)) {
    const name = match.groups?.brace ?? match.groups?.colon;
    if (name) names.add(name);
  }
  return names;
}

/**
 * Substitute `{name}` and `:name` placeholders with `values[name]`.
 *
 * Keys in `values` that do not appear as placeholders are ignored. A
 * placeholder whose name is absent from `values` is left unchanged
 * (callers can detect the leftover via {@link extractPathParamNames}).
 *
 * @param path - URL path with placeholders.
 * @param values - Mapping from parameter name to substitution value.
 * @returns Path with all matching placeholders replaced.
 */
export function substitutePathParams(path: string, values: Record<string, unknown>): string {
  if (typeof path !== 'string') return path;
  PATH_PARAM_NAMED_RE.lastIndex = 0;
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of path.matchAll(PATH_PARAM_NAMED_RE)) {
    const matchIndex = match.index ?? 0;
    const whole = match[0];
    const name = match.groups?.brace ?? match.groups?.colon;
    parts.push(path.slice(lastIndex, matchIndex));
    if (name && Object.prototype.hasOwnProperty.call(values, name)) {
      parts.push(String(values[name]));
    } else {
      parts.push(whole);
    }
    lastIndex = matchIndex + whole.length;
  }
  parts.push(path.slice(lastIndex));
  return parts.join('');
}

/**
 * Generate a dot-separated suggested alias from HTTP route info.
 *
 * The alias is built from non-parameter path segments joined with the
 * resolved semantic verb. The output uses snake_case preserved from the
 * path; surface adapters apply their own naming conventions (e.g., CLI
 * converts underscores to hyphens).
 *
 * The GET-vs-list disambiguation checks whether the LAST path segment
 * is a path parameter (single-resource access) rather than whether the
 * path contains any parameters anywhere. This correctly treats nested
 * collection endpoints like `/orgs/{org_id}/members` as `"list"`.
 *
 * @example
 * generateSuggestedAlias('/tasks/user_data', 'POST');        // "tasks.user_data.create"
 * generateSuggestedAlias('/tasks/user_data', 'GET');         // "tasks.user_data.list"
 * generateSuggestedAlias('/tasks/user_data/{id}', 'GET');    // "tasks.user_data.get"
 * generateSuggestedAlias('/tasks/user_data/{id}', 'PUT');    // "tasks.user_data.update"
 * generateSuggestedAlias('/tasks/user_data/{id}', 'DELETE'); // "tasks.user_data.delete"
 * generateSuggestedAlias('/orgs/{org_id}/members', 'GET');   // "orgs.members.list"
 *
 * @param path - URL path (e.g., `/tasks/user_data/{id}`).
 * @param method - HTTP method (e.g., `POST`).
 * @returns Dot-separated alias string. If the path has no non-parameter
 *   segments, returns just the semantic verb (e.g., `"list"`).
 */
export function generateSuggestedAlias(path: string, method: string): string {
  if (typeof path !== 'string') return 'unknown';
  if (typeof method !== 'string') return 'unknown';
  const rawSegments = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((seg) => seg.length > 0);
  const segments = rawSegments.filter((seg) => !PATH_PARAM_FULL_RE.test(seg));
  const isSingleResource =
    rawSegments.length > 0 && PATH_PARAM_FULL_RE.test(rawSegments[rawSegments.length - 1]);
  const verb = resolveHttpVerb(method, isSingleResource);
  return [...segments, verb].join('.');
}
