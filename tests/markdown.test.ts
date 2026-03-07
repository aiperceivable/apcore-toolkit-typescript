import { describe, it, expect } from 'vitest';
import { toMarkdown } from '../src/formatting/markdown.js';

describe('toMarkdown', () => {
  // 1. Scalar dict renders as bullet list with bold keys
  it('renders scalar dict as bullet list with bold keys', () => {
    const result = toMarkdown({ name: 'Alice', age: 30 });
    expect(result).toBe('- **name**: Alice\n- **age**: 30\n');
  });

  // 2. Throws TypeError for non-object input
  it('throws TypeError for array input', () => {
    expect(() => toMarkdown([] as any)).toThrow(TypeError);
    expect(() => toMarkdown([] as any)).toThrow('toMarkdown() expects a dict, got array');
  });

  it('throws TypeError for string input', () => {
    expect(() => toMarkdown('hello' as any)).toThrow(TypeError);
    expect(() => toMarkdown('hello' as any)).toThrow('toMarkdown() expects a dict, got string');
  });

  it('throws TypeError for number input', () => {
    expect(() => toMarkdown(42 as any)).toThrow(TypeError);
    expect(() => toMarkdown(42 as any)).toThrow('toMarkdown() expects a dict, got number');
  });

  it('throws TypeError for null input', () => {
    expect(() => toMarkdown(null as any)).toThrow(TypeError);
    expect(() => toMarkdown(null as any)).toThrow('toMarkdown() expects a dict, got null');
  });

  // 3. fields option filters top-level keys (preserves order)
  it('filters top-level keys with fields option', () => {
    const result = toMarkdown({ a: 1, b: 2, c: 3 }, { fields: ['c', 'a'] });
    expect(result).toBe('- **c**: 3\n- **a**: 1\n');
  });

  it('filters top-level keys preserving fields order', () => {
    const result = toMarkdown({ x: 10, y: 20, z: 30 }, { fields: ['z', 'x'] });
    expect(result).toBe('- **z**: 30\n- **x**: 10\n');
  });

  it('fields option ignores keys not present in data', () => {
    const result = toMarkdown({ a: 1, b: 2 }, { fields: ['a', 'missing'] });
    expect(result).toBe('- **a**: 1\n');
  });

  // 4. exclude option removes keys at ALL nesting levels
  it('excludes keys at top level', () => {
    const result = toMarkdown({ a: 1, b: 2, c: 3 }, { exclude: ['b'] });
    expect(result).toBe('- **a**: 1\n- **c**: 3\n');
  });

  it('excludes keys at nested levels', () => {
    const result = toMarkdown(
      { name: 'Alice', details: { age: 30, secret: 'hidden' } },
      { exclude: ['secret'] },
    );
    expect(result).toContain('**name**: Alice');
    expect(result).not.toContain('secret');
    expect(result).toContain('**age**: 30');
  });

  // 5. Nested dict at depth=0 renders with ## headings
  it('renders nested dict at depth=0 with ## heading', () => {
    const result = toMarkdown({ name: 'Alice', address: { city: 'NYC', zip: '10001' } });
    expect(result).toContain('\n## address\n');
    expect(result).toContain('- **city**: NYC');
    expect(result).toContain('- **zip**: 10001');
  });

  it('renders deeply nested dicts with increasing heading levels', () => {
    const result = toMarkdown({
      level1: {
        level2: {
          value: 'deep',
        },
      },
    });
    expect(result).toContain('## level1');
    expect(result).toContain('### level2');
    expect(result).toContain('- **value**: deep');
  });

  // 6. Deeper nested dict renders with bullets and indentation
  it('renders nested dict inside a list item with indented bullets', () => {
    const result = toMarkdown({
      items: [
        { label: 'A', sub: { x: 1 } },
      ],
    }, { maxDepth: 5 });
    // The list items get nested with indentation
    expect(result).toContain('- **items**:');
  });

  // 7. maxDepth truncates with compact repr
  it('truncates at maxDepth with compact repr', () => {
    const result = toMarkdown(
      { a: { b: { c: { d: 'deep' } } } },
      { maxDepth: 2 },
    );
    // At depth 2, the nested dict {c: {d: deep}} should be compacted
    expect(result).toContain('**b**:');
    expect(result).toContain('{c: {d: deep}}');
  });

  it('maxDepth=1 compacts immediate nested dicts', () => {
    const result = toMarkdown(
      { outer: { inner: 'val' } },
      { maxDepth: 1 },
    );
    expect(result).toContain('- **outer**: {inner: val}');
  });

  // 8. Scalar dict with >= tableThreshold keys renders as 2-column table
  it('renders scalar dict as table when keys >= tableThreshold', () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const result = toMarkdown(data, { tableThreshold: 5 });
    expect(result).toContain('| Field | Value |');
    expect(result).toContain('|-------|-------|');
    expect(result).toContain('| a | 1 |');
    expect(result).toContain('| e | 5 |');
  });

  it('does not render as table when keys < tableThreshold', () => {
    const data = { a: 1, b: 2, c: 3 };
    const result = toMarkdown(data, { tableThreshold: 5 });
    expect(result).not.toContain('| Field | Value |');
    expect(result).toContain('- **a**: 1');
  });

  // 9. List of uniform scalar dicts renders as multi-column table
  it('renders list of uniform scalar dicts as table', () => {
    const result = toMarkdown({
      users: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    });
    expect(result).toContain('| name | age |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| Alice | 30 |');
    expect(result).toContain('| Bob | 25 |');
  });

  it('does not render single-item list as table', () => {
    const result = toMarkdown({
      users: [{ name: 'Alice', age: 30 }],
    });
    expect(result).not.toContain('| name | age |');
    expect(result).toContain('**name**: Alice');
  });

  it('does not render non-uniform dicts as table', () => {
    const result = toMarkdown({
      items: [
        { name: 'A', x: 1 },
        { name: 'B', y: 2 },
      ],
    });
    expect(result).not.toContain('| name |');
  });

  // 10. Empty list renders as *(empty)*
  it('renders empty list as *(empty)*', () => {
    const result = toMarkdown({ items: [] });
    expect(result).toContain('*(empty)*');
  });

  // 11. Scalar list renders as bullet items
  it('renders scalar list as bullet items', () => {
    const result = toMarkdown({ tags: ['alpha', 'beta', 'gamma'] });
    expect(result).toContain('- **tags**:');
    expect(result).toContain('  - alpha');
    expect(result).toContain('  - beta');
    expect(result).toContain('  - gamma');
  });

  // 12. Special values formatting
  it('formats null as *N/A*', () => {
    const result = toMarkdown({ value: null });
    expect(result).toBe('- **value**: *N/A*\n');
  });

  it('formats true as Yes', () => {
    const result = toMarkdown({ active: true });
    expect(result).toBe('- **active**: Yes\n');
  });

  it('formats false as No', () => {
    const result = toMarkdown({ active: false });
    expect(result).toBe('- **active**: No\n');
  });

  it('formats float with 4 significant digits (86.8571 -> 86.86)', () => {
    const result = toMarkdown({ score: 86.8571 });
    expect(result).toBe('- **score**: 86.86\n');
  });

  it('formats float 0.00012345 with 4 significant digits', () => {
    const result = toMarkdown({ tiny: 0.00012345 });
    expect(result).toBe('- **tiny**: 0.0001234\n');
  });

  it('formats integer without decimal formatting', () => {
    const result = toMarkdown({ count: 42 });
    expect(result).toBe('- **count**: 42\n');
  });

  // 13. Title option prepends # heading
  it('prepends title heading when title option given', () => {
    const result = toMarkdown({ a: 1 }, { title: 'My Report' });
    expect(result).toBe('# My Report\n\n- **a**: 1\n');
  });

  // 14. Pipe characters escaped in table cells
  it('escapes pipe characters in table cells', () => {
    const data = { a: 'x|y', b: 'z', c: 'w', d: 'v', e: 'u' };
    const result = toMarkdown(data, { tableThreshold: 5 });
    expect(result).toContain('| x\\|y |');
  });

  it('escapes pipe characters in list table cells', () => {
    const result = toMarkdown({
      items: [
        { name: 'a|b', val: 1 },
        { name: 'c', val: 2 },
      ],
    });
    expect(result).toContain('| a\\|b | 1 |');
  });

  // 15. Compact repr truncation at max_len
  it('truncates compact repr at max_len=80', () => {
    const longValue: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      longValue[`key${i}`] = `value${i}`;
    }
    const result = toMarkdown({ nested: longValue }, { maxDepth: 1 });
    // Should be truncated with "..."
    expect(result).toContain('...');
    // The line should be reasonably bounded
    const line = result.split('\n').find(l => l.includes('**nested**'))!;
    // compact repr is capped at 80 chars
    const reprPart = line.replace('- **nested**: ', '');
    expect(reprPart.length).toBeLessThanOrEqual(80);
  });

  // Additional edge cases
  it('handles empty dict', () => {
    const result = toMarkdown({});
    expect(result).toBe('\n');
  });

  it('heading level caps at 6', () => {
    // Build deeply nested structure
    const data = {
      l1: { l2: { l3: { l4: { l5: { value: 'deep' } } } } },
    };
    const result = toMarkdown(data, { maxDepth: 10 });
    // depth 0 -> ##, depth 1 -> ###, depth 2 -> ####, depth 3 -> #####, depth 4 -> ######
    expect(result).toContain('######');
    // Should not have ####### (7 hashes)
    expect(result).not.toMatch(/^#{7,}\s/m);
  });

  it('exclude works on list table columns', () => {
    const result = toMarkdown({
      users: [
        { name: 'Alice', age: 30, secret: 'x' },
        { name: 'Bob', age: 25, secret: 'y' },
      ],
    }, { exclude: ['secret'] });
    expect(result).toContain('| name | age |');
    expect(result).not.toContain('secret');
  });

  it('renders list of mixed scalar items', () => {
    const result = toMarkdown({ items: [1, 'two', true, null] });
    expect(result).toContain('  - 1');
    expect(result).toContain('  - two');
    expect(result).toContain('  - Yes');
    expect(result).toContain('  - *N/A*');
  });

  it('compact repr for list', () => {
    const result = toMarkdown({ data: [1, 2, 3] }, { maxDepth: 1 });
    expect(result).toContain('- **data**: [1, 2, 3]');
  });

  it('nested list inside list renders compact', () => {
    const result = toMarkdown({ matrix: [[1, 2], [3, 4]] });
    expect(result).toContain('- **matrix**:');
    expect(result).toContain('  - [1, 2]');
    expect(result).toContain('  - [3, 4]');
  });
});
