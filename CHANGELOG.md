# Changelog

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
