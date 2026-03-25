/**
 * DisplayResolver — sparse binding.yaml display overlay.
 *
 * Resolves surface-facing presentation fields (alias, description, guidance)
 * for each ScannedModule by merging:
 *   surface-specific override > display default > binding-level > scanner value
 *
 * The resolved fields are stored in ScannedModule.metadata["display"] and
 * travel through RegistryWriter into FunctionModule.metadata["display"],
 * where CLI/MCP/A2A surfaces read them at render time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ScannedModule } from './types.js';
import { cloneModule } from './types.js';

const MCP_ALIAS_MAX = 64;
const MCP_ALIAS_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const CLI_ALIAS_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Surface-specific resolved display fields. */
export interface SurfaceDisplay {
  alias: string;
  description: string;
  guidance: string | null;
}

/** Full resolved display metadata. */
export interface DisplayMetadata {
  alias: string;
  description: string;
  documentation: string | null;
  guidance: string | null;
  tags: string[];
  cli: SurfaceDisplay;
  mcp: SurfaceDisplay;
  a2a: SurfaceDisplay;
}

/** Options for {@link DisplayResolver.resolve}. */
export interface DisplayResolveOptions {
  /**
   * Path to a single `.binding.yaml` file or a directory containing
   * `*.binding.yaml` files. Ignored when `bindingData` is provided.
   */
  bindingPath?: string;

  /**
   * Pre-parsed binding YAML content as an object (`{ bindings: [...] }`)
   * or a `moduleId → entry` map. Takes precedence over `bindingPath`.
   */
  bindingData?: Record<string, unknown>;
}

type BindingEntry = Record<string, unknown>;
type BindingMap = Record<string, BindingEntry>;

/**
 * Resolves display overlay fields for a list of ScannedModules.
 *
 * @example
 * ```ts
 * const resolver = new DisplayResolver();
 * const resolved = resolver.resolve(scannedModules, {
 *   bindingPath: './bindings/',
 * });
 * ```
 */
export class DisplayResolver {
  /**
   * Apply display overlay to a list of ScannedModules.
   *
   * @param modules - ScannedModule instances from a framework scanner.
   * @param options - Optional binding path or pre-parsed binding data.
   * @returns New ScannedModule list with `metadata["display"]` populated.
   */
  resolve(modules: ScannedModule[], options?: DisplayResolveOptions): ScannedModule[] {
    const bindingPath = options?.bindingPath ?? null;
    const bindingData = options?.bindingData ?? null;

    const bindingMap = this._buildBindingMap(bindingPath, bindingData);

    if (Object.keys(bindingMap).length > 0) {
      const matched = modules.filter((mod) => mod.moduleId in bindingMap).length;
      console.info(
        `DisplayResolver: ${matched}/${modules.length} modules matched binding entries.`,
      );
      if (matched === 0) {
        console.warn(
          `DisplayResolver: binding map loaded ${Object.keys(bindingMap).length} entries but none matched ` +
            'any scanned module_id — check binding.yaml module_id values.',
        );
      }
    }

    return modules.map((mod) => this._resolveOne(mod, bindingMap));
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private _buildBindingMap(
    bindingPath: string | null,
    bindingData: Record<string, unknown> | null,
  ): BindingMap {
    if (bindingData != null) {
      return this._parseBindingData(bindingData);
    }
    if (bindingPath != null) {
      return this._loadBindingFiles(bindingPath);
    }
    return {};
  }

  private _parseBindingData(data: Record<string, unknown>): BindingMap {
    // Accept either { bindings: [...] } or a direct moduleId → entry map
    if ('bindings' in data) {
      const bindings = (data['bindings'] as Array<Record<string, unknown>>) ?? [];
      const result: BindingMap = {};
      for (const entry of bindings) {
        const id = entry['module_id'] as string | undefined;
        if (id != null) {
          result[id] = entry;
        }
      }
      return result;
    }
    // Already a map
    const result: BindingMap = {};
    for (const [k, v] of Object.entries(data)) {
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = v as BindingEntry;
      }
    }
    return result;
  }

  private _loadBindingFiles(bindingPath: string): BindingMap {
    const result: BindingMap = {};

    let files: string[] = [];
    try {
      const stat = fs.statSync(bindingPath);
      if (stat.isFile()) {
        files = [bindingPath];
      } else if (stat.isDirectory()) {
        files = fs
          .readdirSync(bindingPath)
          .filter((f) => f.endsWith('.binding.yaml'))
          .sort()
          .map((f) => path.join(bindingPath, f));
      }
    } catch {
      console.warn(`DisplayResolver: binding path not found: ${bindingPath}`);
      return {};
    }

    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const data = (yaml.load(content) as Record<string, unknown>) ?? {};
        Object.assign(result, this._parseBindingData(data));
      } catch (exc) {
        console.warn(`DisplayResolver: failed to load ${f}: ${exc}`);
      }
    }

    return result;
  }

  private _resolveOne(mod: ScannedModule, bindingMap: BindingMap): ScannedModule {
    const entry = bindingMap[mod.moduleId] ?? {};
    const displayCfg = (entry['display'] as Record<string, unknown>) ?? {};
    const bindingDesc = entry['description'] as string | undefined;
    const bindingDocs = entry['documentation'] as string | undefined;
    const suggestedAlias = (mod.metadata?.['suggested_alias'] as string | undefined) ?? null;

    // -- Resolve cross-surface defaults --
    const defaultAlias: string =
      (displayCfg['alias'] as string) || suggestedAlias || mod.moduleId;
    const defaultDescription: string =
      (displayCfg['description'] as string) || bindingDesc || mod.description;
    const defaultDocumentation: string | null =
      (displayCfg['documentation'] as string) || bindingDocs || mod.documentation || null;
    const defaultGuidance: string | null = (displayCfg['guidance'] as string) || null;
    const resolvedTags: string[] =
      (displayCfg['tags'] as string[]) ?? (entry['tags'] as string[]) ?? [...mod.tags];

    // -- Resolve per-surface fields --
    const resolveSurface = (
      key: string,
    ): { surface: SurfaceDisplay; aliasExplicit: boolean } => {
      const sc = (displayCfg[key] as Record<string, unknown>) ?? {};
      const aliasExplicit = Boolean(sc['alias']);
      return {
        surface: {
          alias: (sc['alias'] as string) || defaultAlias,
          description: (sc['description'] as string) || defaultDescription,
          guidance: (sc['guidance'] as string) || defaultGuidance,
        },
        aliasExplicit,
      };
    };

    const { surface: cliSurface, aliasExplicit: cliAliasExplicit } = resolveSurface('cli');
    const { surface: mcpSurface } = resolveSurface('mcp');
    const { surface: a2aSurface } = resolveSurface('a2a');

    // Auto-sanitize MCP alias: replace non-[a-zA-Z0-9_-] chars with _,
    // then prepend _ if the result starts with a digit.
    const rawMcpAlias = mcpSurface.alias;
    let sanitized = rawMcpAlias.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitized.length > 0 && /^\d/.test(sanitized)) {
      sanitized = '_' + sanitized;
    }
    mcpSurface.alias = sanitized;
    if (sanitized !== rawMcpAlias) {
      console.debug(
        `Module '${mod.moduleId}': MCP alias auto-sanitized '${rawMcpAlias}' → '${sanitized}'.`,
      );
    }

    const display: DisplayMetadata = {
      alias: defaultAlias,
      description: defaultDescription,
      documentation: defaultDocumentation,
      guidance: defaultGuidance,
      tags: resolvedTags,
      cli: cliSurface,
      mcp: mcpSurface,
      a2a: a2aSurface,
    };

    // -- Validate aliases --
    this._validateAliases(display, mod.moduleId, cliAliasExplicit);

    const newMetadata = { ...mod.metadata, display };
    return cloneModule(mod, { metadata: newMetadata });
  }

  private _validateAliases(
    display: DisplayMetadata,
    moduleId: string,
    cliAliasExplicit: boolean,
  ): void {
    // MCP: MUST enforce 64-char hard limit (alias was already auto-sanitized)
    const mcpAlias = display.mcp.alias;
    if (mcpAlias.length > MCP_ALIAS_MAX) {
      throw new Error(
        `Module '${moduleId}': MCP alias '${mcpAlias}' exceeds ` +
          `${MCP_ALIAS_MAX}-character hard limit (OpenAI spec). ` +
          'Set display.mcp.alias to a shorter value.',
      );
    }
    if (!MCP_ALIAS_PATTERN.test(mcpAlias)) {
      throw new Error(
        `Module '${moduleId}': MCP alias '${mcpAlias}' does not match ` +
          'required pattern ^[a-zA-Z_][a-zA-Z0-9_-]*$.',
      );
    }

    // CLI: only validate user-explicitly-set aliases
    if (cliAliasExplicit) {
      const cliAlias = display.cli.alias;
      if (!CLI_ALIAS_PATTERN.test(cliAlias)) {
        console.warn(
          `Module '${moduleId}': CLI alias '${cliAlias}' does not match shell-safe pattern ` +
            `^[a-z][a-z0-9_-]*$ — falling back to default alias '${display.alias}'.`,
        );
        display.cli.alias = display.alias;
      }
    }
  }
}
