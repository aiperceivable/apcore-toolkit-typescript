import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScannedModule } from '../src/types.js';
import type { ScannedModule } from '../src/types.js';

vi.mock('../src/resolve-target.js', () => ({
  resolveTarget: vi.fn().mockResolvedValue((inputs: Record<string, unknown>) => ({ result: 'ok' })),
}));

import { RegistryWriter } from '../src/output/registry-writer.js';

const REQUIRED_FIELDS = {
  moduleId: 'test.greet',
  description: 'Greet a user',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
  tags: ['test'],
  target: 'some-module:greet',
} as const;

describe('RegistryWriter', () => {
  let writer: RegistryWriter;
  let mockRegistry: { register: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    writer = new RegistryWriter();
    mockRegistry = { register: vi.fn() };
  });

  describe('dry run', () => {
    it('returns module IDs without calling registry.register', async () => {
      const mod = createScannedModule({ ...REQUIRED_FIELDS });
      const result = await writer.write([mod], mockRegistry, { dryRun: true });

      expect(result).toEqual(['test.greet']);
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('returns multiple module IDs on dry run', async () => {
      const mod1 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod.one' });
      const mod2 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod.two' });

      const result = await writer.write([mod1, mod2], mockRegistry, { dryRun: true });

      expect(result).toEqual(['mod.one', 'mod.two']);
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });
  });

  describe('register modules', () => {
    it('registers a single module into the registry', async () => {
      const mod = createScannedModule({ ...REQUIRED_FIELDS });
      const result = await writer.write([mod], mockRegistry);

      expect(result).toEqual(['test.greet']);
      expect(mockRegistry.register).toHaveBeenCalledOnce();
      expect(mockRegistry.register).toHaveBeenCalledWith('test.greet', expect.anything());
    });

    it('registers multiple modules into the registry', async () => {
      const mod1 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod.one' });
      const mod2 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod.two' });
      const mod3 = createScannedModule({ ...REQUIRED_FIELDS, moduleId: 'mod.three' });

      const result = await writer.write([mod1, mod2, mod3], mockRegistry);

      expect(result).toEqual(['mod.one', 'mod.two', 'mod.three']);
      expect(mockRegistry.register).toHaveBeenCalledTimes(3);
      expect(mockRegistry.register).toHaveBeenNthCalledWith(1, 'mod.one', expect.anything());
      expect(mockRegistry.register).toHaveBeenNthCalledWith(2, 'mod.two', expect.anything());
      expect(mockRegistry.register).toHaveBeenNthCalledWith(3, 'mod.three', expect.anything());
    });
  });

  describe('empty modules', () => {
    it('returns empty array for empty input', async () => {
      const result = await writer.write([], mockRegistry);

      expect(result).toEqual([]);
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('returns empty array for empty input with dry run', async () => {
      const result = await writer.write([], mockRegistry, { dryRun: true });

      expect(result).toEqual([]);
    });
  });

  describe('registry.register receives correct arguments', () => {
    it('is called with moduleId and a FunctionModule instance', async () => {
      const mod = createScannedModule({
        ...REQUIRED_FIELDS,
        moduleId: 'test.hello',
        description: 'Say hello',
        version: '2.0.0',
        tags: ['greeting', 'test'],
        documentation: 'Says hello to people',
        annotations: { readOnly: true },
        metadata: { author: 'tester' },
        examples: [{ name: 'basic', input: { name: 'World' }, output: { greeting: 'Hello, World!' } }],
      });

      await writer.write([mod], mockRegistry);

      expect(mockRegistry.register).toHaveBeenCalledOnce();
      const [registeredId, registeredModule] = mockRegistry.register.mock.calls[0];
      expect(registeredId).toBe('test.hello');
      // The registered module should be a FunctionModule with the correct properties
      expect(registeredModule).toBeDefined();
      expect(registeredModule.moduleId).toBe('test.hello');
      expect(registeredModule.description).toBe('Say hello');
      expect(registeredModule.version).toBe('2.0.0');
      expect(registeredModule.documentation).toBe('Says hello to people');
      expect(registeredModule.tags).toEqual(['greeting', 'test']);
      expect(registeredModule.annotations).toEqual({ readOnly: true });
      expect(registeredModule.metadata).toEqual({ author: 'tester' });
      expect(registeredModule.examples).toEqual([
        { name: 'basic', input: { name: 'World' }, output: { greeting: 'Hello, World!' } },
      ]);
    });
  });
});
