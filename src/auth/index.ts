/**
 * RFC 8628 Device Authorization Flow — the protocol half.
 *
 * The presentation half (showing the user code, opening a browser,
 * rendering a spinner) stays in the consumer and is reached through
 * callbacks. **The toolkit writes nothing to a terminal.**
 *
 * Specification: `apcore-toolkit/docs/features/device-auth.md`.
 * Conformance corpus: `apcore-toolkit/conformance/fixtures/device_auth.json`.
 */

export { TokenSet, REDACTED, DEFAULT_SKEW_SECONDS, systemWallClock } from './token-set.js';
export type { TokenSetRecord, IsExpiredOptions, WallClock } from './token-set.js';

export { MemoryTokenStore, makeStoreKey } from './token-store.js';
export type { TokenStore } from './token-store.js';

export { FileTokenStore, defaultCredentialsPath } from './file-token-store.js';
export type { FileTokenStoreOptions } from './file-token-store.js';

export {
  DeviceAuthConfig,
  discoveryCandidates,
  resolveMetadata,
  validateErrorAliases,
  REQUEST_KINDS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_DEVICE_EXPIRY_SECONDS,
  DEFAULT_HTTP_TIMEOUT_MS,
} from './config.js';
export type {
  ClientAuthMethod,
  DeviceAuthConfigInit,
  DeviceAuthHooks,
  DeviceAuthWarning,
  DiscoverOptions,
  MetadataRejection,
  MetadataResolution,
  RequestEncoding,
  RequestKind,
  TransformedRequest,
  WarningSink,
} from './config.js';

export {
  DeviceCodeGrant,
  SLOW_DOWN_INCREMENT_SECONDS,
  effectiveDeadlineSeconds,
} from './device-code-grant.js';
export type { DeviceLoginOptions, PollEvent, UserCodeEvent } from './device-code-grant.js';

export { invokeCallback } from './grant.js';
export type { Grant, GrantContext, MonotonicClock, SleepFn } from './grant.js';

export { DeviceAuthClient } from './client.js';
export type {
  DeviceAuthClientOptions,
  DeviceAuthRuntimeOptions,
  EnsureValidOptions,
} from './client.js';

export {
  FetchAuthTransport,
  encodeBody,
  encodeScope,
  buildRequestFields,
  formUrlEncodeComponent,
} from './transport.js';
export type { AuthRequest, AuthResponse, AuthTransport, EncodedBody } from './transport.js';

export {
  InvalidClassificationError,
  classifyErrorBody,
  decodeResponse,
  dispatchTokenResponse,
  sendRequest,
} from './pipeline.js';
export type { PipelineContext, TokenDispatch } from './pipeline.js';

export {
  BUILTIN_FIELD_ALIASES,
  DEVICE_CODE_GRANT_TYPE,
  REFRESH_TOKEN_GRANT_TYPE,
  STANDARD_ERROR_IDENTIFIERS,
  decodeBody,
  isStandardErrorIdentifier,
  mergeFieldAliases,
  normaliseFields,
} from './wire.js';
export type { DeviceAuthorization, StandardErrorIdentifier, WireBody } from './wire.js';

export {
  AuthTransportError,
  AuthorizationDeniedError,
  AuthorizationExpiredError,
  AuthorizationProtocolError,
  CredentialPermissionError,
  DeviceAuthConfigError,
  DeviceAuthError,
  DiscoveryError,
  NoCredentialError,
  RefreshFailedError,
} from './errors.js';
