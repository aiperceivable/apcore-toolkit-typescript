# Changelog

## [0.2.0] - 2026-03-12

### Added

- `AIEnhancer` class — SLM-based metadata enhancement using OpenAI-compatible
  APIs (Ollama, vLLM, LM Studio). Fills missing descriptions, infers behavioral
  annotations (all 11 fields: `readonly`, `destructive`, `idempotent`,
  `requires_approval`, `open_world`, `streaming`, `cacheable`, `cache_ttl`,
  `cache_key_fields`, `paginated`, `pagination_style`), and generates input
  schemas. AI-generated fields tagged with `x-generated-by: slm` for auditability.
- `createWriteResult()` factory and `runVerifierChain()` helper for writer operations.
  `verify: true` runs the built-in verifier (`YAMLVerifier`, `SyntaxVerifier`,
  `RegistryVerifier`) even when no custom `verifiers` are provided.
- `allowedPrefixes` parameter on `resolveTarget()` for path restriction security

### Fixed

- `inferAnnotationsFromMethod()` — `GET` now infers `cacheable: true` in addition
  to `readonly: true`, matching Python parity
- `filterModules()` — use `safeRegExp()` that tries regex first and falls back
  to escaped literal on invalid patterns (balances spec compliance with safety)
- `YAMLWriter._buildBinding()` — use `structuredClone()` for deep cloning nested
  schemas instead of shallow spread
- `WriteError` — use native ES2022 `Error.cause` instead of shadowing the property
- `JSONVerifier` — restored `schema` constructor parameter for cross-language
  API parity with Python SDK

### Tests

- 171 tests across 14 files, all passing
- Added `RegistryVerifier` test coverage (pass, fail, missing method)
- Added `resolveTarget` allowedPrefixes tests
- Full AIEnhancer test suite (15 tests)

---

## [0.1.0] - 2026-03-07

### Added

- `ScannedModule` interface — canonical representation of a scanned endpoint
- `BaseScanner` abstract class with filtering, deduplication, and annotation inference
- `enrichSchemaDescriptions()` — merge parameter descriptions into JSON Schema
- OpenAPI utilities: `resolveRef`, `resolveSchema`, `extractInputSchema`, `extractOutputSchema`
- Serializers: `annotationsToDict`, `moduleToDict`, `modulesToDicts`
- `toMarkdown()` — generic dict-to-Markdown conversion with depth control and table heuristics
- `YAMLWriter` — generate `.binding.yaml` files for `BindingLoader`
- `TypeScriptWriter` — generate TypeScript wrapper files with `module()` decorator
- `RegistryWriter` — direct registration into `apcore-js` Registry
- `getWriter()` factory function
- `resolveTarget()` — dynamic import resolution for `module:export` target strings
