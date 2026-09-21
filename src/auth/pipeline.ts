/**
 * The request/response pipeline and the fixed hook invocation order.
 *
 * ```
 * transform_request  ->  [HTTP]  ->  parse_response  ->  field-name aliasing
 *                                          ->  error_aliases  ->  classify_error
 *                                          ->  state-machine dispatch
 * ```
 *
 * That order is itself conformance-tested (case 047), because two hooks
 * disagreeing about the same body must resolve the same way in all three
 * SDKs. Dispatch is the closed layer: nothing below this file's
 * {@link TokenDispatch} may be influenced by a hook.
 */

import type { DeviceAuthConfig, RequestKind } from './config.js';
import { DeviceAuthError } from './errors.js';
import type { AuthResponse, AuthTransport } from './transport.js';
import { buildRequestFields } from './transport.js';
import {
  STANDARD_ERROR_IDENTIFIERS,
  WireField,
  decodeBody,
  isStandardErrorIdentifier,
  normaliseFields,
  readErrorIdentifier,
  readSeconds,
  readString,
  type StandardErrorIdentifier,
  type WireBody,
} from './wire.js';

/** Everything the pipeline needs that is not per-request. */
export interface PipelineContext {
  readonly config: DeviceAuthConfig;
  readonly transport: AuthTransport;
}

/**
 * Build, hook, and send one request.
 *
 * `transformRequest` runs immediately before the request goes out and
 * receives **no URL**: request targeting stays with configuration and
 * discovery, because a hook able to redirect the token request is a hook
 * able to exfiltrate credentials. An exception from it propagates — this
 * hook is load-bearing, unlike the observational callbacks.
 */
export async function sendRequest(
  ctx: PipelineContext,
  kind: RequestKind,
  url: string,
  baseParams: Readonly<Record<string, string>>,
): Promise<AuthResponse> {
  const { config } = ctx;
  const built = buildRequestFields(config, kind, baseParams);
  let params = built.params;
  let headers = built.headers;

  const { transformRequest } = config.hooks;
  if (transformRequest) {
    const result = await transformRequest(kind, { ...params }, { ...headers });
    if (result.params !== undefined) params = { ...params, ...result.params };
    if (result.headers !== undefined) headers = { ...headers, ...result.headers };
  }

  return ctx.transport.send({
    kind,
    url,
    params,
    headers,
    encoding: config.requestEncoding[kind],
    timeoutMs: config.httpTimeoutMs,
  });
}

/**
 * Decode a response into a field-normalised wire body, or `null` when the
 * body cannot be decoded at all.
 *
 * `parseResponse` runs *before* the built-in parsers and returning `null`
 * means "no opinion, use the default", so a hook can special-case one
 * endpoint and ignore the rest. Field-name aliasing is applied afterwards
 * either way, so a hook's output and the built-in parser's output reach
 * dispatch in the same shape.
 */
export async function decodeResponse(
  ctx: PipelineContext,
  kind: RequestKind,
  response: AuthResponse,
): Promise<WireBody | null> {
  const { config } = ctx;
  const hooked = config.hooks.parseResponse
    ? await config.hooks.parseResponse(kind, response.status, response.contentType, response.rawBody)
    : null;
  const decoded = hooked ?? decodeBody(response.contentType, response.rawBody);
  if (decoded === null) return null;
  return normaliseFields(decoded, config.fieldAliases);
}

/**
 * Thrown when `classifyError` returns something outside its contract.
 *
 * Never coerced, never defaulted, never passed through to dispatch: a hook
 * that can invent a state can drive the machine somewhere it has no branch
 * for. Conformance case 045 asserts this rejection.
 */
export class InvalidClassificationError extends DeviceAuthError {
  constructor(returned: unknown) {
    super(
      `classifyError returned ${JSON.stringify(returned)}, which is not an RFC 8628 identifier. `
        + `It must return one of ${STANDARD_ERROR_IDENTIFIERS.join(', ')} — or null for "no opinion".`,
    );
    this.name = 'InvalidClassificationError';
  }
}

/**
 * Resolve an error body onto one of the four RFC identifiers, or `null`
 * when nothing recognises it.
 *
 * Order is fixed: `errorAliases` first, then `classifyError`. When the
 * alias step already produced a standard identifier the hook is not
 * consulted — the alias wins (case 047). The two are not interchangeable:
 * one says the user refused, the other says a code timed out.
 *
 * `invalid_grant` is deliberately **not** aliased by default. Mapping it
 * onto `expired_token` is right for a provider that reports device-code
 * expiry that way and wrong everywhere else, where it also covers a
 * malformed or already-redeemed code, so a blanket mapping would mask
 * genuine errors as benign expiry (case 040).
 */
export async function classifyErrorBody(
  ctx: PipelineContext,
  body: WireBody,
): Promise<StandardErrorIdentifier | null> {
  const { config } = ctx;
  const raw = readErrorIdentifier(body, config.fieldAliases);
  const aliased = raw === null ? null : (config.errorAliases[raw] ?? raw);
  if (isStandardErrorIdentifier(aliased)) return aliased;

  const { classifyError } = config.hooks;
  if (!classifyError) return null;
  const returned = await classifyError(body);
  if (returned === null || returned === undefined) return null;
  if (!isStandardErrorIdentifier(returned)) throw new InvalidClassificationError(returned);
  return returned;
}

/** What the state machine should do with one token-endpoint response. */
export type TokenDispatch =
  /** A success payload carrying `access_token`. */
  | { readonly action: 'success'; readonly body: WireBody }
  /** `authorization_pending` — keep polling, interval unchanged. */
  | { readonly action: 'pending' }
  /** `slow_down` — back off; `interval` is the server's own number when it sent one. */
  | { readonly action: 'slow_down'; readonly interval: number | null }
  /** `access_denied` — the user refused. */
  | { readonly action: 'denied' }
  /** `expired_token` — the device code is dead. */
  | { readonly action: 'expired' }
  /** Anything else: an unrecognised identifier, or a body nothing could read. */
  | {
      readonly action: 'protocol_error';
      readonly message: string;
      /** The undecoded body, so the error can carry the operator's only diagnostic. */
      readonly rawBody: string;
      readonly status: number;
    };

/**
 * Dispatch on the response **body**, never on the HTTP status.
 *
 * RFC 8628 §3.5 describes error responses as HTTP 400 and keying the state
 * machine on the status is the tempting shortcut. Live providers make it
 * wrong: one returns `authorization_pending` as **428** and both
 * `slow_down` and `access_denied` as **403**, and a second, independent
 * provider also uses 403 for `access_denied`. A status-driven client
 * treats all three as fatal and breaks against them entirely (cases
 * 031-033).
 *
 * The status decides exactly one thing: whether the body is a success
 * payload (`2xx`) or an error payload (everything else).
 */
export async function dispatchTokenResponse(
  ctx: PipelineContext,
  response: AuthResponse,
  kind: RequestKind = 'token',
): Promise<TokenDispatch> {
  const body = await decodeResponse(ctx, kind, response);

  if (response.status >= 200 && response.status < 300) {
    if (body === null) {
      return {
        action: 'protocol_error',
        message: 'Success response body could not be decoded',
        rawBody: response.rawBody,
        status: response.status,
      };
    }
    const accessToken = readString(body, WireField.ACCESS_TOKEN);
    if (accessToken === null || accessToken === '') {
      return {
        action: 'protocol_error',
        message: 'Success response carries no access_token',
        rawBody: response.rawBody,
        status: response.status,
      };
    }
    return { action: 'success', body };
  }

  if (body === null) {
    return {
      action: 'protocol_error',
      message: `HTTP ${String(response.status)}: error body could not be decoded`,
      rawBody: response.rawBody,
      status: response.status,
    };
  }

  const identifier = await classifyErrorBody(ctx, body);
  switch (identifier) {
    case 'authorization_pending':
      return { action: 'pending' };
    case 'slow_down':
      // Some providers return an updated `interval` inside the slow_down
      // body. When present it is authoritative and used verbatim: the
      // server's own number beats guessing, and costs one conditional.
      return { action: 'slow_down', interval: readSeconds(body, WireField.INTERVAL) };
    case 'access_denied':
      return { action: 'denied' };
    case 'expired_token':
      return { action: 'expired' };
    default: {
      // Fail soft on shape: report the raw body rather than crashing on a
      // missing key. One surveyed provider returns some errors in the OAuth
      // envelope and others, on the same endpoint, in a proprietary one.
      const reported = readErrorIdentifier(body, ctx.config.fieldAliases);
      const description = readString(body, WireField.ERROR_DESCRIPTION);
      const detail = reported === null
        ? 'no recognisable error identifier'
        : `unrecognised error identifier ${JSON.stringify(reported)}`;
      return {
        action: 'protocol_error',
        message: `HTTP ${String(response.status)}: ${detail}${description === null ? '' : ` (${description})`}`,
        rawBody: response.rawBody,
        status: response.status,
      };
    }
  }
}
