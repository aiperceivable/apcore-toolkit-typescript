/**
 * `DeviceCodeGrant` — the RFC 8628 polling state machine.
 *
 * This is the part that must be identical across the Python, TypeScript,
 * and Rust SDKs, and the part best suited to conformance testing: it is
 * pure logic over a response sequence and an injected clock. The corpus
 * (`conformance/fixtures/device_auth.json`) drives it with a scripted
 * transport and records the sleeps; **no HTTP mocking is involved.**
 *
 * Nothing here writes to a terminal. No print, no spinner, no colour, no
 * browser launch. Events reach the consumer through `onUserCode` and
 * `onPoll`; a library that writes to stdout cannot be used by a daemon, a
 * GUI, or a test.
 */

import { DEFAULT_DEVICE_EXPIRY_SECONDS } from './config.js';
import {
  AuthTransportError,
  AuthorizationDeniedError,
  AuthorizationExpiredError,
  AuthorizationProtocolError,
} from './errors.js';
import { invokeCallback, type Grant, type GrantContext } from './grant.js';
import { decodeResponse, dispatchTokenResponse, sendRequest } from './pipeline.js';
import { TokenSet } from './token-set.js';
import { encodeScope } from './transport.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  WireField,
  toDeviceAuthorization,
  type DeviceAuthorization,
} from './wire.js';

/** RFC 8628 §3.5's fixed backoff increment. Never a multiplier. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * The deadline actually in force, in seconds.
 *
 * One derivation, used by both `onUserCode` and the poll loop. Deriving it
 * twice is how all three SDKs ended up clamping the loop while telling the
 * consumer the server's larger number, so a countdown rendered "expires in
 * 600s" while the flow died at 7 (case 060c). `timeoutSeconds` is a hard
 * ceiling independent of the server's `expires_in`, and when both apply the
 * shorter wins — for every reader of the number, not just the loop.
 *
 * @param expiresIn the effective server lifetime; the 15-minute fallback has
 *   already been applied at parse time, so this is never null
 * @param timeoutSeconds the caller's optional ceiling
 */
export function effectiveDeadlineSeconds(
  expiresIn: number,
  timeoutSeconds: number | undefined,
): number {
  return timeoutSeconds === undefined ? expiresIn : Math.min(expiresIn, timeoutSeconds);
}

/** What `onUserCode` receives, once, after the device-code response. */
export interface UserCodeEvent {
  /** Where the user must go. Consumers auto-opening a browser MUST check the scheme is https. */
  readonly verificationUri: string;
  /**
   * The code, byte-for-byte as the server sent it.
   *
   * MUST NOT be upper-cased, stripped, or re-grouped — not when storing,
   * not when displaying. It is case-sensitive at some providers, and at
   * least one embeds it unmodified into a URL query parameter.
   */
  readonly userCode: string;
  /**
   * The URI with the code embedded, or `null` — which is **the norm**.
   * Only one surveyed provider returns it and another documents it as
   * unsupported, so never build a QR-code-only UI around it. It is passed
   * separately rather than pre-merged so the consumer still shows the
   * plain URI and code for manual entry.
   */
  readonly verificationUriComplete: string | null;
  /**
   * The deadline actually in force, in seconds — the server's `expires_in`,
   * the 15-minute fallback when the provider omits it, or the caller's
   * `timeoutSeconds` when that is shorter.
   *
   * Never null, and never the unclamped server value: this is the same
   * number the poll loop stops on, so a countdown built from it is correct
   * by construction rather than by the consumer re-deriving the fallback
   * and the clamp for themselves.
   */
  readonly expiresIn: number;
}

/** What `onPoll` receives, before each poll attempt. */
export interface PollEvent {
  /** 1-based. */
  readonly attempt: number;
  /** Seconds waited before this attempt. */
  readonly interval: number;
  /** Seconds elapsed since the device-code request, on the monotonic clock. */
  readonly elapsed: number;
}

/** Options for {@link DeviceCodeGrant.authorize}. */
export interface DeviceLoginOptions {
  /** Invoked once, after the device-code response. Exceptions are swallowed. */
  onUserCode?: (event: UserCodeEvent) => void;
  /** Invoked before each poll. Exceptions are swallowed. */
  onPoll?: (event: PollEvent) => void;
  /**
   * Hard ceiling independent of the server's `expires_in`. When both
   * apply, the **shorter** wins — for the poll loop and for what
   * `onUserCode` is told, which are the same number.
   */
  timeoutSeconds?: number;
}

/**
 * The device authorization grant.
 *
 * @example
 * ```ts
 * const grant = new DeviceCodeGrant();
 * const tokens = await grant.authorize(ctx, {
 *   onUserCode: ({ verificationUri, userCode }) => ui.show(verificationUri, userCode),
 * });
 * ```
 */
export class DeviceCodeGrant implements Grant<DeviceLoginOptions> {
  readonly grantType = DEVICE_CODE_GRANT_TYPE;

  /**
   * Request a device code, notify the consumer, then poll until the flow
   * resolves or the deadline elapses.
   */
  async authorize(ctx: GrantContext, options: DeviceLoginOptions = {}): Promise<TokenSet> {
    const authorization = await this.requestDeviceCode(ctx);
    // Derived once, before the callback, and handed to both it and the loop.
    const deadlineSeconds = effectiveDeadlineSeconds(
      authorization.expiresIn,
      options.timeoutSeconds,
    );
    invokeCallback(ctx.warn, 'onUserCode', options.onUserCode, {
      verificationUri: authorization.verificationUri,
      userCode: authorization.userCode,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresIn: deadlineSeconds,
    });
    return this.poll(ctx, authorization, deadlineSeconds, options);
  }

  /**
   * `POST` to the device authorization endpoint.
   *
   * The resulting `device_code` is a short-lived pre-authorization secret
   * and is never written to the store — only the resulting `TokenSet` is.
   */
  async requestDeviceCode(ctx: GrantContext): Promise<DeviceAuthorization> {
    const { config } = ctx;
    if (config.deviceAuthorizationEndpoint === null) {
      throw new AuthorizationProtocolError(
        'No device authorization endpoint: set `deviceAuthorizationEndpoint`, or call `config.discover()` first.',
      );
    }
    const base: Record<string, string> = {};
    const scope = encodeScope(config);
    if (scope !== null) base[WireField.SCOPE] = scope;

    const response = await sendRequest(ctx, 'device', config.deviceAuthorizationEndpoint, base);
    const body = await decodeResponse(ctx, 'device', response);
    if (response.status < 200 || response.status >= 300) {
      throw new AuthorizationProtocolError(
        `Device authorization request failed with HTTP ${String(response.status)}`,
        response.rawBody,
        response.status,
      );
    }
    if (body === null) {
      throw new AuthorizationProtocolError(
        'Device authorization response body could not be decoded',
        response.rawBody,
        response.status,
      );
    }
    return toDeviceAuthorization(body, response.rawBody, DEFAULT_DEVICE_EXPIRY_SECONDS);
  }

  /**
   * The loop.
   *
   * Sleep *before* the first poll (RFC 8628 §3.5: the client should not
   * poll faster than the interval, and the user has not had time to act
   * yet), then check the deadline, then poll. Polling stops at
   * `expires_in` even when the server never returns `expired_token` —
   * relying on the server's error alone leaves a client polling
   * indefinitely against a server that never sends it.
   */
  private async poll(
    ctx: GrantContext,
    authorization: DeviceAuthorization,
    deadlineSeconds: number,
    options: DeviceLoginOptions,
  ): Promise<TokenSet> {
    const { config } = ctx;
    const tokenEndpoint = config.tokenEndpoint;
    if (tokenEndpoint === null) {
      throw new AuthorizationProtocolError(
        'No token endpoint: set `tokenEndpoint`, or call `config.discover()` first.',
      );
    }

    let interval = authorization.interval ?? config.defaultInterval;
    // `deadlineSeconds` arrives already derived — the same value handed to
    // `onUserCode`. Re-deriving it here is exactly the drift case 060c pins.
    const deadlineMs = deadlineSeconds * 1000;

    const baseParams: Record<string, string> = {
      [WireField.GRANT_TYPE]: DEVICE_CODE_GRANT_TYPE,
      [WireField.DEVICE_CODE]: authorization.deviceCode,
    };

    const started = ctx.clock();
    let attempt = 0;

    for (;;) {
      await ctx.sleep(interval * 1000);
      const elapsedMs = ctx.clock() - started;
      if (elapsedMs >= deadlineMs) {
        throw new AuthorizationExpiredError(
          `Device authorization deadline of ${String(deadlineSeconds)}s elapsed after ${String(attempt)} poll(s)`,
          true,
        );
      }

      attempt += 1;
      invokeCallback(ctx.warn, 'onPoll', options.onPoll, {
        attempt,
        interval,
        elapsed: elapsedMs / 1000,
      });

      let dispatch;
      let rawBody = '';
      try {
        const response = await sendRequest(ctx, 'token', tokenEndpoint, baseParams);
        rawBody = response.rawBody;
        dispatch = await dispatchTokenResponse(ctx, response, 'token');
      } catch (err) {
        if (err instanceof AuthTransportError) {
          // A dropped connection mid-flow is common on flaky networks, and
          // the deadline already bounds the total wait, so retrying cannot
          // loop forever.
          continue;
        }
        throw err;
      }

      switch (dispatch.action) {
        case 'success':
          return TokenSet.fromTokenResponse(dispatch.body, rawBody, ctx.wallClock);
        case 'pending':
          continue;
        case 'slow_down':
          interval = dispatch.interval ?? interval + SLOW_DOWN_INCREMENT_SECONDS;
          continue;
        case 'denied':
          throw new AuthorizationDeniedError();
        case 'expired':
          throw new AuthorizationExpiredError('Device code expired (server returned expired_token)');
        case 'protocol_error':
          throw new AuthorizationProtocolError(dispatch.message, dispatch.rawBody, dispatch.status);
      }
    }
  }
}
