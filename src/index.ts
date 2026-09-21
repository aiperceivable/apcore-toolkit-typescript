export type { ScannedModule } from './types.js';
export { createScannedModule, cloneModule } from './types.js';

// Tri-language parity note
// ------------------------
// The Python SDK exports `ConventionScanner`, a pydantic-specific scanner that
// walks `BaseModel` subclasses for endpoint metadata. It is intentionally
// Python-only: the pydantic conventions it relies on do not have TypeScript
// equivalents. Rust mirrors this decision (see
// apcore-toolkit-rust/src/scanner.rs for the same note).

export { BaseScanner } from './scanner.js';
export {
  SCANNER_VERB_MAP,
  hasPathParams,
  resolveHttpVerb,
  generateSuggestedAlias,
  extractPathParamNames,
  substitutePathParams,
} from './http-verb-map.js';
export { enrichSchemaDescriptions } from './schema-utils.js';
export {
  resolveRef,
  resolveSchema,
  deepResolveRefs,
  extractInputSchema,
  extractOutputSchema,
} from './openapi.js';
export {
  annotationsToDict,
  moduleToDict,
  modulesToDicts,
} from './serializers.js';
export { resolveTarget } from './resolve-target.js';
export {
  toMarkdown,
  formatSchema,
  formatModule,
  formatModules,
  formatCsv,
  formatJsonl,
} from './formatting/index.js';
export type {
  SchemaStyle,
  ModuleStyle,
  GroupBy,
  FormatSchemaOptions,
  FormatModuleOptions,
  FormatModulesOptions,
  FormatCsvOptions,
} from './formatting/index.js';
export { AIEnhancer } from './ai-enhancer.js';
export type { AIEnhancerOptions, Enhancer } from './ai-enhancer.js';
export { DisplayResolver } from './display/resolver.js';
export type {
  DisplayResolveOptions,
  DisplayMetadata,
  SurfaceDisplay,
} from './display/resolver.js';
export {
  BindingLoader,
  BindingLoadError,
  BindingParser,
  parseBindingDocument,
} from './binding-loader.js';
export type { BindingLoadOptions } from './binding-loader.js';
export { YAMLWriter } from './output/yaml-writer.js';
export { TypeScriptWriter } from './output/typescript-writer.js';
export { RegistryWriter } from './output/registry-writer.js';
export {
  HTTPProxyRegistryWriter,
  HTTPProxyRegistryWriterError,
} from './output/http-proxy-writer.js';
export type {
  HTTPProxyRegistryWriterOptions,
  ProxyRegistry,
} from './output/http-proxy-writer.js';
export { getWriter } from './output/factory.js';
export { OpenAPIScanner, deriveModuleId, InvalidSpecError } from './openapi-scanner.js';
export type { OpenAPIScanOptions } from './openapi-scanner.js';
export { loadSpec } from './openapi-loader.js';
export type { LoadSpecOptions } from './openapi-loader.js';
export { modulesToViewModel, formatViewModel } from './tui-view-model.js';
export type {
  TuiViewModel,
  Column,
  Row,
  Cell,
  Sort,
  Filter,
  TonePalette,
  ToneRule,
  Group,
  View,
  Justify,
  Exposure,
  Direction,
  Tone,
  CellKind,
  ModulesToViewModelOptions,
} from './tui-view-model.js';
// ---- Device Authorization Flow (RFC 8628) --------------------------------
// Protocol half only: the polling state machine, TokenSet lifecycle, and a
// portable TokenStore. Presentation (user-code display, browser launch,
// spinners) stays with the consumer and arrives through callbacks — the
// toolkit writes to no terminal. Spec: apcore-toolkit/docs/features/device-auth.md.
export {
  TokenSet,
  REDACTED,
  DEFAULT_SKEW_SECONDS,
  systemWallClock,
  MemoryTokenStore,
  makeStoreKey,
  FileTokenStore,
  defaultCredentialsPath,
  DeviceAuthConfig,
  discoveryCandidates,
  resolveMetadata,
  validateErrorAliases,
  REQUEST_KINDS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_DEVICE_EXPIRY_SECONDS,
  DEFAULT_HTTP_TIMEOUT_MS,
  DeviceCodeGrant,
  SLOW_DOWN_INCREMENT_SECONDS,
  effectiveDeadlineSeconds,
  invokeCallback,
  DeviceAuthClient,
  FetchAuthTransport,
  encodeBody,
  encodeScope,
  buildRequestFields,
  formUrlEncodeComponent,
  InvalidClassificationError,
  classifyErrorBody,
  decodeResponse,
  dispatchTokenResponse,
  sendRequest,
  BUILTIN_FIELD_ALIASES,
  DEVICE_CODE_GRANT_TYPE,
  REFRESH_TOKEN_GRANT_TYPE,
  STANDARD_ERROR_IDENTIFIERS,
  decodeBody,
  isStandardErrorIdentifier,
  mergeFieldAliases,
  normaliseFields,
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
} from './auth/index.js';
export type {
  TokenSetRecord,
  IsExpiredOptions,
  WallClock,
  TokenStore,
  FileTokenStoreOptions,
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
  DeviceLoginOptions,
  PollEvent,
  UserCodeEvent,
  Grant,
  GrantContext,
  MonotonicClock,
  SleepFn,
  DeviceAuthClientOptions,
  DeviceAuthRuntimeOptions,
  EnsureValidOptions,
  AuthRequest,
  AuthResponse,
  AuthTransport,
  EncodedBody,
  PipelineContext,
  TokenDispatch,
  DeviceAuthorization,
  StandardErrorIdentifier,
  WireBody,
} from './auth/index.js';

export { assertAnnotationsPreserved, DEFAULT_CONFORMANCE_FIELDS } from './conformance.js';
export type { AnnotationCarryingRegistry, AnnotationWriter } from './conformance.js';
export type { WriteResult, VerifyResult, Verifier } from './output/types.js';
// TS-only ergonomic factory: Python/Rust callers construct WriteResult directly
// via dataclass/struct literals. No counterpart in apcore-toolkit-python/-rust.
export { createWriteResult } from './output/types.js';
export { WriteError, InvalidFormatError } from './output/errors.js';
export {
  YAMLVerifier,
  SyntaxVerifier,
  RegistryVerifier,
  MagicBytesVerifier,
  JSONVerifier,
  runVerifierChain,
} from './output/verifiers.js';

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json') as { version: string };
export const VERSION: string = _pkg.version;

// Package-level free-function exports for cross-language parity.
// Python and Rust expose these as top-level symbols; TypeScript re-exports
// them directly from `scanner.ts` (where they are now the canonical
// implementation; the corresponding `BaseScanner` instance methods
// delegate to them). This eliminates the dummy abstract-subclass shim
// that earlier versions used.
export { filterModules, deduplicateIds } from './scanner.js';

import { BaseScanner as _BaseScanner } from './scanner.js';
import type { ModuleAnnotations } from 'apcore-js';

/**
 * Parity shim — delegates to BaseScanner.inferAnnotationsFromMethod for cross-SDK API symmetry.
 *
 * Infer behavioral annotations from an HTTP method string.
 * Package-level free function; thin wrapper over the static
 * {@link BaseScanner.inferAnnotationsFromMethod}.
 */
export function inferAnnotationsFromMethod(method: string): ModuleAnnotations {
  return _BaseScanner.inferAnnotationsFromMethod(method);
}
