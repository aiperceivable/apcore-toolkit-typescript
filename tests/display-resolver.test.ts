import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DisplayResolver } from '../src/display-resolver.js';
import { createScannedModule } from '../src/types.js';
import type { ScannedModule } from '../src/types.js';

function mod(opts?: {
  moduleId?: string;
  description?: string;
  tags?: string[];
  documentation?: string | null;
  metadata?: Record<string, unknown>;
}): ScannedModule {
  return createScannedModule({
    moduleId: opts?.moduleId ?? 'image.resize',
    description: opts?.description ?? 'Resize an image',
    inputSchema: {},
    outputSchema: {},
    tags: opts?.tags ?? [],
    target: 'myapp:func',
    documentation: opts?.documentation ?? null,
    metadata: opts?.metadata ?? {},
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'display-resolver-test-'));
}

describe('DisplayResolver', () => {
  let resolver: DisplayResolver;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolver = new DisplayResolver();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // No binding — fields fall through to scanner values
  // -----------------------------------------------------------------------

  describe('no binding (pass-through)', () => {
    it('alias defaults to moduleId', () => {
      const result = resolver.resolve([mod({ moduleId: 'image.resize' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('image.resize');
    });

    it('description defaults to scanner description', () => {
      const result = resolver.resolve([mod({ description: 'Resize an image' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['description']).toBe('Resize an image');
    });

    it('tags from scanner', () => {
      const result = resolver.resolve([mod({ tags: ['image', 'transform'] })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['tags']).toEqual(['image', 'transform']);
    });

    it('guidance is null when not set', () => {
      const result = resolver.resolve([mod()]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['guidance']).toBeNull();
    });

    it('documentation from scanner', () => {
      const result = resolver.resolve([mod({ documentation: 'Full docs here.' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['documentation']).toBe('Full docs here.');
    });
  });

  // -----------------------------------------------------------------------
  // display.alias only — all surfaces inherit it
  // -----------------------------------------------------------------------

  describe('display.alias propagation', () => {
    it('propagates to all surfaces', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'product.get' })],
        {
          bindingData: {
            bindings: [{ module_id: 'product.get', display: { alias: 'product-get' } }],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('product-get');
      expect((d['cli'] as Record<string, unknown>)['alias']).toBe('product-get');
      expect((d['a2a'] as Record<string, unknown>)['alias']).toBe('product-get');
    });

    it('sanitized for MCP (hyphens are valid)', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'payment.status' })],
        {
          bindingData: {
            bindings: [{ module_id: 'payment.status', display: { alias: 'pay-status' } }],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('pay-status');
    });
  });

  // -----------------------------------------------------------------------
  // Surface-specific overrides
  // -----------------------------------------------------------------------

  describe('surface-specific overrides', () => {
    it('CLI alias override only affects CLI', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'order.list' })],
        {
          bindingData: {
            bindings: [
              {
                module_id: 'order.list',
                display: { alias: 'order-list', cli: { alias: 'orders' } },
              },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['cli'] as Record<string, unknown>)['alias']).toBe('orders');
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('order-list');
      expect((d['a2a'] as Record<string, unknown>)['alias']).toBe('order-list');
    });

    it('MCP alias override only affects MCP', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'order.list' })],
        {
          bindingData: {
            bindings: [
              {
                module_id: 'order.list',
                display: { alias: 'order-list', mcp: { alias: 'list_orders' } },
              },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('list_orders');
      expect((d['cli'] as Record<string, unknown>)['alias']).toBe('order-list');
      expect((d['a2a'] as Record<string, unknown>)['alias']).toBe('order-list');
    });

    it('surface description override', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'my.mod', description: 'Generic description' })],
        {
          bindingData: {
            bindings: [
              {
                module_id: 'my.mod',
                display: {
                  description: 'Default override',
                  cli: { description: 'CLI-specific description' },
                },
              },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['cli'] as Record<string, unknown>)['description']).toBe(
        'CLI-specific description',
      );
      expect((d['mcp'] as Record<string, unknown>)['description']).toBe('Default override');
      expect((d['a2a'] as Record<string, unknown>)['description']).toBe('Default override');
    });
  });

  // -----------------------------------------------------------------------
  // MCP alias validation
  // -----------------------------------------------------------------------

  describe('MCP alias validation', () => {
    it('exceeding 64 chars raises error', () => {
      expect(() =>
        resolver.resolve(
          [mod({ moduleId: 'my.mod' })],
          {
            bindingData: {
              bindings: [
                { module_id: 'my.mod', display: { mcp: { alias: 'a'.repeat(65) } } },
              ],
            },
          },
        ),
      ).toThrow(/exceeds.*64/);
    });

    it('module_id with dots is auto-sanitized', () => {
      const result = resolver.resolve([mod({ moduleId: 'image.resize' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('image_resize');
    });

    it('nested dots are sanitized', () => {
      const result = resolver.resolve([mod({ moduleId: 'product.catalog.get' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('product_catalog_get');
    });

    it('leading digit gets underscore prefix', () => {
      const result = resolver.resolve([mod({ moduleId: '1get-user' })]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['alias']).toBe('_1get-user');
    });
  });

  // -----------------------------------------------------------------------
  // suggested_alias fallback
  // -----------------------------------------------------------------------

  describe('suggested_alias fallback', () => {
    it('used when no display alias', () => {
      const m = mod({
        moduleId: 'product.get_product_product__product_id_.get',
        metadata: { suggested_alias: 'product.get_product.get' },
      });
      const result = resolver.resolve([m]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('product.get_product.get');
    });

    it('display alias takes priority over suggested_alias', () => {
      const m = mod({
        moduleId: 'product.get_product_product__product_id_.get',
        metadata: { suggested_alias: 'product.get_product.get' },
      });
      const result = resolver.resolve([m], {
        bindingData: {
          bindings: [
            {
              module_id: 'product.get_product_product__product_id_.get',
              display: { alias: 'product-detail' },
            },
          ],
        },
      });
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('product-detail');
    });
  });

  // -----------------------------------------------------------------------
  // Sparse overlay
  // -----------------------------------------------------------------------

  describe('sparse overlay', () => {
    it('unmentioned modules get scanner values', () => {
      const mods = Array.from({ length: 10 }, (_, i) =>
        mod({ moduleId: `mod.func${i}`, description: `Description ${i}`, tags: [`tag${i}`] }),
      );
      const result = resolver.resolve(mods, {
        bindingData: {
          bindings: [{ module_id: 'mod.func3', display: { alias: 'special-func' } }],
        },
      });
      expect(result).toHaveLength(10);
      const d3 = result[3].metadata['display'] as Record<string, unknown>;
      expect(d3['alias']).toBe('special-func');
      expect((d3['cli'] as Record<string, unknown>)['alias']).toBe('special-func');
      for (const i of [0, 1, 2, 4, 5, 6, 7, 8, 9]) {
        const d = result[i].metadata['display'] as Record<string, unknown>;
        expect(d['alias']).toBe(`mod.func${i}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Tags resolution
  // -----------------------------------------------------------------------

  describe('tags resolution', () => {
    it('display tags override scanner tags', () => {
      const result = resolver.resolve(
        [mod({ tags: ['old'] })],
        {
          bindingData: {
            bindings: [
              { module_id: 'image.resize', display: { tags: ['image', 'v2'] } },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['tags']).toEqual(['image', 'v2']);
    });

    it('binding entry tags not dropped', () => {
      const result = resolver.resolve(
        [mod({ tags: ['old'] })],
        {
          bindingData: {
            bindings: [{ module_id: 'image.resize', tags: ['payment', 'v2'] }],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['tags']).toEqual(['payment', 'v2']);
    });

    it('scanner tags used when no display tags', () => {
      const result = resolver.resolve(
        [mod({ tags: ['scanner-tag'] })],
        {
          bindingData: {
            bindings: [{ module_id: 'image.resize', description: 'override' }],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['tags']).toEqual(['scanner-tag']);
    });
  });

  // -----------------------------------------------------------------------
  // binding_data dict format (moduleId → entry map)
  // -----------------------------------------------------------------------

  describe('binding_data as direct map', () => {
    it('resolves from direct map format', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'image.resize' })],
        {
          bindingData: { 'image.resize': { display: { alias: 'img-resize' } } },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('img-resize');
    });
  });

  // -----------------------------------------------------------------------
  // binding_path file loading
  // -----------------------------------------------------------------------

  describe('binding_path file loading', () => {
    it('missing path logs warning and falls through', () => {
      const tmp = tmpDir();
      const result = resolver.resolve([mod()], {
        bindingPath: path.join(tmp, 'nonexistent.binding.yaml'),
      });
      expect(result).toHaveLength(1);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('image.resize');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('binding path not found'),
      );
      fs.rmSync(tmp, { recursive: true });
    });

    it('bindingData takes precedence over bindingPath', () => {
      const tmp = tmpDir();
      fs.writeFileSync(
        path.join(tmp, 'test.binding.yaml'),
        'bindings:\n  - module_id: image.resize\n    display:\n      alias: from-file\n',
      );
      const result = resolver.resolve(
        [mod({ moduleId: 'image.resize' })],
        {
          bindingPath: tmp,
          bindingData: {
            bindings: [
              { module_id: 'image.resize', display: { alias: 'from-data' } },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('from-data');
      fs.rmSync(tmp, { recursive: true });
    });

    it('loads single yaml file', () => {
      const tmp = tmpDir();
      const filePath = path.join(tmp, 'test.binding.yaml');
      fs.writeFileSync(
        filePath,
        'bindings:\n  - module_id: image.resize\n    display:\n      alias: img-resize\n',
      );
      const result = resolver.resolve([mod({ moduleId: 'image.resize' })], {
        bindingPath: filePath,
      });
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['alias']).toBe('img-resize');
      fs.rmSync(tmp, { recursive: true });
    });

    it('loads all yaml files from directory', () => {
      const tmp = tmpDir();
      fs.writeFileSync(
        path.join(tmp, 'a.binding.yaml'),
        'bindings:\n  - module_id: image.resize\n    display:\n      alias: img-resize\n',
      );
      fs.writeFileSync(
        path.join(tmp, 'b.binding.yaml'),
        'bindings:\n  - module_id: text.summarize\n    display:\n      alias: summarize\n',
      );
      const mods = [
        mod({ moduleId: 'image.resize' }),
        mod({ moduleId: 'text.summarize', description: 'Summarize text' }),
      ];
      const result = resolver.resolve(mods, { bindingPath: tmp });
      expect(
        (result[0].metadata['display'] as Record<string, unknown>)['alias'],
      ).toBe('img-resize');
      expect(
        (result[1].metadata['display'] as Record<string, unknown>)['alias'],
      ).toBe('summarize');
      fs.rmSync(tmp, { recursive: true });
    });
  });

  // -----------------------------------------------------------------------
  // Guidance resolution
  // -----------------------------------------------------------------------

  describe('guidance resolution', () => {
    it('guidance from display propagates to all surfaces', () => {
      const result = resolver.resolve(
        [mod()],
        {
          bindingData: {
            bindings: [
              {
                module_id: 'image.resize',
                display: { guidance: 'Use width/height in pixels.' },
              },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['guidance']).toBe('Use width/height in pixels.');
      expect((d['cli'] as Record<string, unknown>)['guidance']).toBe(
        'Use width/height in pixels.',
      );
      expect((d['mcp'] as Record<string, unknown>)['guidance']).toBe(
        'Use width/height in pixels.',
      );
      expect((d['a2a'] as Record<string, unknown>)['guidance']).toBe(
        'Use width/height in pixels.',
      );
    });

    it('surface guidance overrides default', () => {
      const result = resolver.resolve(
        [mod()],
        {
          bindingData: {
            bindings: [
              {
                module_id: 'image.resize',
                display: {
                  guidance: 'Default guidance.',
                  mcp: { guidance: 'MCP-specific guidance.' },
                },
              },
            ],
          },
        },
      );
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect((d['mcp'] as Record<string, unknown>)['guidance']).toBe(
        'MCP-specific guidance.',
      );
      expect((d['cli'] as Record<string, unknown>)['guidance']).toBe('Default guidance.');
    });

    it('no guidance is null', () => {
      const result = resolver.resolve([mod()]);
      const d = result[0].metadata['display'] as Record<string, unknown>;
      expect(d['guidance']).toBeNull();
      expect((d['cli'] as Record<string, unknown>)['guidance']).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Existing metadata preserved
  // -----------------------------------------------------------------------

  describe('existing metadata preserved', () => {
    it('non-display keys are untouched', () => {
      const m = mod({
        metadata: { source: 'openapi', operation_id: 'get_user_get' },
      });
      const result = resolver.resolve([m]);
      const meta = result[0].metadata;
      expect(meta['source']).toBe('openapi');
      expect(meta['operation_id']).toBe('get_user_get');
      expect(meta['display']).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // CLI alias validation
  // -----------------------------------------------------------------------

  describe('CLI alias validation', () => {
    it('invalid explicit CLI alias falls back with warning', () => {
      const result = resolver.resolve(
        [mod({ moduleId: 'my.mod' })],
        {
          bindingData: {
            bindings: [
              { module_id: 'my.mod', display: { cli: { alias: 'MyAlias' } } },
            ],
          },
        },
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MyAlias'));
      const d = result[0].metadata['display'] as Record<string, unknown>;
      // Falls back to display.alias -> moduleId
      expect((d['cli'] as Record<string, unknown>)['alias']).toBe('my.mod');
    });

    it('implicit moduleId alias does not warn', () => {
      resolver.resolve([mod({ moduleId: 'image.resize' })]);
      const warnCalls = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((msg) => msg.includes('CLI alias'));
      expect(warnCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Match-count logging
  // -----------------------------------------------------------------------

  describe('match-count logging', () => {
    it('logs info when binding map has matches', () => {
      resolver.resolve(
        [mod({ moduleId: 'image.resize' })],
        {
          bindingData: {
            bindings: [{ module_id: 'image.resize', display: { alias: 'ir' } }],
          },
        },
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('1/1 modules matched'),
      );
    });

    it('warns when binding loaded but zero modules matched', () => {
      resolver.resolve(
        [mod({ moduleId: 'image.resize' })],
        {
          bindingData: {
            bindings: [{ module_id: 'nonexistent.mod', display: { alias: 'x' } }],
          },
        },
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('none matched'),
      );
    });

    it('no log emitted when no binding provided', () => {
      resolver.resolve([mod()]);
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });
});
