import { describe, it, expect } from 'vitest';
import { flattenParams } from '../src/flatten-params.js';

describe('flattenParams', () => {
  it('passes parsed args to the wrapped function', () => {
    const original = (input: { name: string; age: number }) => `${input.name} is ${input.age}`;
    const schema = {
      parse: (data: unknown) => data as { name: string; age: number },
    };

    const wrapped = flattenParams(original, schema);
    const result = wrapped({ name: 'Alice', age: 30 });
    expect(result).toBe('Alice is 30');
  });

  it('uses schema.parse for validation', () => {
    const original = (input: { value: number }) => input.value * 2;
    const schema = {
      parse: (data: unknown) => {
        const d = data as Record<string, unknown>;
        if (typeof d.value !== 'number') throw new Error('value must be a number');
        return d as { value: number };
      },
    };

    const wrapped = flattenParams(original, schema);
    expect(wrapped({ value: 5 })).toBe(10);
    expect(() => wrapped({ value: 'not a number' })).toThrow('value must be a number');
  });
});
