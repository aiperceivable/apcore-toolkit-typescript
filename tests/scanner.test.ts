import { describe, it, expect } from 'vitest';
import { DEFAULT_ANNOTATIONS } from 'apcore-js';
import { BaseScanner } from '../src/scanner.js';
import { createScannedModule } from '../src/types.js';
import type { ScannedModule } from '../src/types.js';

// Concrete test subclass
class TestScanner extends BaseScanner {
  private modules: ScannedModule[];

  constructor(modules: ScannedModule[] = []) {
    super();
    this.modules = modules;
  }

  scan(): ScannedModule[] {
    return this.modules;
  }

  getSourceName(): string {
    return 'test-source';
  }
}

function makeModule(id: string): ScannedModule {
  return createScannedModule({
    moduleId: id,
    description: `Module ${id}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tags: ['test'],
    target: `http://localhost/${id}`,
  });
}

describe('BaseScanner', () => {
  describe('concrete subclass', () => {
    it('can be instantiated and returns scan results', () => {
      const modules = [makeModule('mod-a'), makeModule('mod-b')];
      const scanner = new TestScanner(modules);

      expect(scanner.getSourceName()).toBe('test-source');
      expect(scanner.scan()).toEqual(modules);
    });
  });

  describe('filterModules', () => {
    const scanner = new TestScanner();
    const modules = [
      makeModule('users.list'),
      makeModule('users.create'),
      makeModule('orders.list'),
      makeModule('orders.delete'),
    ];

    it('returns all modules when no options provided', () => {
      const result = scanner.filterModules(modules);
      expect(result).toEqual(modules);
    });

    it('filters with include pattern — only matching modules returned', () => {
      const result = scanner.filterModules(modules, { include: 'users' });
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.moduleId)).toEqual([
        'users.list',
        'users.create',
      ]);
    });

    it('filters with exclude pattern — matching modules removed', () => {
      const result = scanner.filterModules(modules, { exclude: 'delete' });
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.moduleId)).toEqual([
        'users.list',
        'users.create',
        'orders.list',
      ]);
    });

    it('filters with both include and exclude', () => {
      const result = scanner.filterModules(modules, {
        include: 'orders',
        exclude: 'delete',
      });
      expect(result).toHaveLength(1);
      expect(result[0].moduleId).toBe('orders.list');
    });
  });

  describe('inferAnnotationsFromMethod', () => {
    it('GET → readonly=true, rest defaults', () => {
      const ann = BaseScanner.inferAnnotationsFromMethod('GET');
      expect(ann).toEqual({
        ...DEFAULT_ANNOTATIONS,
        readonly: true,
      });
    });

    it('DELETE → destructive=true', () => {
      const ann = BaseScanner.inferAnnotationsFromMethod('DELETE');
      expect(ann).toEqual({
        ...DEFAULT_ANNOTATIONS,
        destructive: true,
      });
    });

    it('PUT → idempotent=true', () => {
      const ann = BaseScanner.inferAnnotationsFromMethod('PUT');
      expect(ann).toEqual({
        ...DEFAULT_ANNOTATIONS,
        idempotent: true,
      });
    });

    it('post (lowercase) → all defaults (case insensitive)', () => {
      const ann = BaseScanner.inferAnnotationsFromMethod('post');
      expect(ann).toEqual({ ...DEFAULT_ANNOTATIONS });
    });

    it('get (lowercase) → readonly=true (case insensitive)', () => {
      const ann = BaseScanner.inferAnnotationsFromMethod('get');
      expect(ann).toEqual({
        ...DEFAULT_ANNOTATIONS,
        readonly: true,
      });
    });
  });

  describe('deduplicateIds', () => {
    const scanner = new TestScanner();

    it('returns same modules when no duplicates', () => {
      const modules = [makeModule('mod-a'), makeModule('mod-b')];
      const result = scanner.deduplicateIds(modules);
      expect(result).toEqual(modules);
      expect(result).toHaveLength(2);
    });

    it('appends _2, _3 for duplicates and adds warnings', () => {
      const modules = [
        makeModule('mod-a'),
        makeModule('mod-a'),
        makeModule('mod-a'),
      ];
      const result = scanner.deduplicateIds(modules);

      expect(result).toHaveLength(3);
      expect(result[0].moduleId).toBe('mod-a');
      expect(result[0].warnings).toEqual([]);

      expect(result[1].moduleId).toBe('mod-a_2');
      expect(result[1].warnings).toContain(
        "Module ID renamed from 'mod-a' to 'mod-a_2' to avoid collision",
      );

      expect(result[2].moduleId).toBe('mod-a_3');
      expect(result[2].warnings).toContain(
        "Module ID renamed from 'mod-a' to 'mod-a_3' to avoid collision",
      );
    });

    it('preserves original modules (returns new instances for renamed)', () => {
      const original = makeModule('mod-a');
      const duplicate = makeModule('mod-a');
      const modules = [original, duplicate];

      const result = scanner.deduplicateIds(modules);

      // First one is unchanged
      expect(result[0]).toBe(original);

      // Second one is a new instance (renamed)
      expect(result[1]).not.toBe(duplicate);
      expect(result[1].moduleId).toBe('mod-a_2');

      // Original duplicate is untouched
      expect(duplicate.moduleId).toBe('mod-a');
    });
  });
});
