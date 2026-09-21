/**
 * The `Grant` seam.
 *
 * Six of the eight components in this feature are grant-independent —
 * `TokenSet`, expiry, the `TokenStore` protocol and `FileTokenStore`,
 * refresh with rotation, provider configuration and normalisation, the
 * extension hooks, and redaction. Only the polling state machine and the
 * device-authorization request are device-flow specific.
 *
 * V1 ships `DeviceCodeGrant` alone (recorded Decision 5), but the
 * interface ships with it. The reason is concrete rather than
 * architectural taste: one major vendor's `--device-auth` is **not** RFC
 * 8628 — it sends JSON, has no `device_code` and no `verification_uri`,
 * signals "still pending" purely by HTTP 403/404 with no error body, and
 * polls to obtain an *authorization code* plus a server-supplied PKCE
 * verifier which a second exchange turns into a token. Its pending signal
 * directly contradicts this SDK's dispatch-on-body rule. Both rules are
 * correct for their own protocol, and they cannot coexist inside one state
 * machine. With this interface a consumer adds such a grant without
 * forking; without it, they would be bending RFC 8628's state machine
 * until it no longer describes RFC 8628.
 */

import type { DeviceAuthConfig, DeviceAuthWarning } from './config.js';
import type { TokenSet, WallClock } from './token-set.js';
import type { AuthTransport } from './transport.js';

/** Monotonic milliseconds. Never wall-clock: see {@link GrantContext.now}. */
export type MonotonicClock = () => number;

/** Suspends for `ms` milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Everything a grant is handed. Both clocks and the sleep are injected so
 * the state machine is conformance-testable without real time passing.
 */
export interface GrantContext {
  readonly config: DeviceAuthConfig;
  /** How bytes travel. Scripted by the conformance harness; no fetch mocking. */
  readonly transport: AuthTransport;
  /**
   * **Monotonic** milliseconds, for elapsed-time measurement only.
   *
   * Monotonic rather than wall-clock so that an NTP correction or a laptop
   * suspend/resume mid-flow cannot make the deadline jump backwards or
   * fire early.
   */
  readonly clock: MonotonicClock;
  /**
   * **Wall-clock** Unix seconds, for `expiresAt` only.
   *
   * The opposite choice from {@link clock}, deliberately: `expiresAt` must
   * survive a process restart, and a monotonic value is meaningless across
   * one. Two clocks, two purposes; this is not an inconsistency.
   */
  readonly wallClock: WallClock;
  readonly sleep: SleepFn;
  /** Warning sink. The toolkit writes to no terminal. */
  readonly warn: (warning: DeviceAuthWarning) => void;
}

/**
 * One way of obtaining a {@link TokenSet}.
 *
 * @typeParam TOptions - per-grant options, e.g. the device flow's callbacks.
 */
export interface Grant<TOptions = unknown> {
  /** The `grant_type` this implementation sends, for diagnostics. */
  readonly grantType: string;
  /** Run the grant to completion, or throw one of the device-auth errors. */
  authorize(ctx: GrantContext, options?: TOptions): Promise<TokenSet>;
}

/**
 * Invoke a consumer callback without letting it influence the flow.
 *
 * A rendering failure in the UI layer is not a reason to lose an in-flight
 * authorization, so exceptions are swallowed and recorded as a warning —
 * never propagated.
 */
export function invokeCallback<T>(
  warn: (warning: DeviceAuthWarning) => void,
  name: string,
  callback: ((event: T) => void) | undefined,
  event: T,
): void {
  if (!callback) return;
  try {
    const result = callback(event) as unknown;
    if (typeof (result as { catch?: unknown } | null)?.catch === 'function') {
      (result as Promise<void>).catch((err: unknown) => {
        warn({ code: 'callback_failed', message: `${name} callback rejected`, cause: err });
      });
    }
  } catch (err) {
    warn({ code: 'callback_failed', message: `${name} callback threw`, cause: err });
  }
}
