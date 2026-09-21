/**
 * Error taxonomy for the RFC 8628 device-authorization client.
 *
 * Mirrors the `Errors` blocks of
 * `apcore-toolkit/docs/features/device-auth.md` (contracts for
 * `DeviceAuthClient.login`, `DeviceAuthClient.ensure_valid`, and
 * `TokenStore`). Python and Rust raise the same set under the same names,
 * so a consumer porting between SDKs matches on the same conditions.
 */

/** Base class for every device-auth failure. */
export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

/**
 * Configuration is invalid and the client refuses to be constructed.
 *
 * Raised for an `errorAliases` entry mapping onto a non-RFC identifier
 * (conformance case 025), a non-HTTPS endpoint, or a missing `clientId`.
 */
export class DeviceAuthConfigError extends DeviceAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceAuthConfigError';
  }
}

/** The end user refused the authorization request (`access_denied`). */
export class AuthorizationDeniedError extends DeviceAuthError {
  constructor(message = 'Authorization was denied by the user') {
    super(message);
    this.name = 'AuthorizationDeniedError';
  }
}

/**
 * The device code expired — either because the server said `expired_token`
 * or because the client's own deadline elapsed first.
 */
export class AuthorizationExpiredError extends DeviceAuthError {
  /** True when the client stopped on its own deadline rather than a server error. */
  readonly deadlineExceeded: boolean;

  constructor(message: string, deadlineExceeded = false) {
    super(message);
    this.name = 'AuthorizationExpiredError';
    this.deadlineExceeded = deadlineExceeded;
  }
}

/**
 * An unrecognised error identifier, an unparseable body, or a success
 * payload with no `access_token`.
 *
 * Carries `rawBody` so an operator keeps the only diagnostic a provider
 * with a proprietary error envelope gives them — the spec's "fail soft on
 * shape" rule, asserted by conformance case 051.
 */
export class AuthorizationProtocolError extends DeviceAuthError {
  /** The undecoded response body, preserved verbatim. */
  readonly rawBody: string;
  /** HTTP status the body arrived with, when one is known. */
  readonly status: number | null;

  constructor(message: string, rawBody = '', status: number | null = null) {
    super(message);
    this.name = 'AuthorizationProtocolError';
    this.rawBody = rawBody;
    this.status = status;
  }
}

/**
 * Nothing usable is in the store: no record at all, or a record whose
 * access token has expired with no refresh token to renew it. The caller
 * must run `login()` again.
 */
export class NoCredentialError extends DeviceAuthError {
  constructor(message = 'No stored credential; call login() first') {
    super(message);
    this.name = 'NoCredentialError';
  }
}

/**
 * A refresh was rejected with `invalid_grant`. The refresh token is spent
 * or revoked, the store has been cleared, and a fresh `login()` is the
 * only correct response — never a retry.
 */
export class RefreshFailedError extends DeviceAuthError {
  constructor(message = 'Refresh token was rejected (invalid_grant)') {
    super(message);
    this.name = 'RefreshFailedError';
  }
}

/**
 * An existing credentials file has permissions broader than `0600`.
 * The store refuses to read it rather than silently using a credential
 * other local users can read.
 */
export class CredentialPermissionError extends DeviceAuthError {
  /** Absolute path of the offending file. */
  readonly path: string;

  constructor(path: string, mode: number) {
    super(
      `Credentials file ${path} has mode ${(mode & 0o777).toString(8).padStart(4, '0')} — `
        + 'refusing to read a credential readable by other local users. '
        + `Run: chmod 600 ${path}`,
    );
    this.name = 'CredentialPermissionError';
    this.path = path;
  }
}

/**
 * A transport-level failure (connection reset, DNS failure, timeout).
 *
 * The polling state machine treats this as retryable rather than terminal,
 * per the dispatch table's "Transport failure" row; the deadline still
 * bounds the total wait.
 */
export class AuthTransportError extends DeviceAuthError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AuthTransportError';
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Endpoint discovery could not produce a usable metadata document. */
export class DiscoveryError extends DeviceAuthError {
  /** Every candidate URL that was tried, in order. */
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[]) {
    super(message);
    this.name = 'DiscoveryError';
    this.candidates = candidates;
  }
}
