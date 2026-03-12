import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIEnhancer } from '../src/ai-enhancer.js';
import { createScannedModule } from '../src/types.js';

describe('AIEnhancer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars
    delete process.env.APCORE_AI_ENABLED;
    delete process.env.APCORE_AI_ENDPOINT;
    delete process.env.APCORE_AI_MODEL;
    delete process.env.APCORE_AI_THRESHOLD;
    delete process.env.APCORE_AI_BATCH_SIZE;
    delete process.env.APCORE_AI_TIMEOUT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('isEnabled', () => {
    it('returns false by default', () => {
      expect(AIEnhancer.isEnabled()).toBe(false);
    });

    it('returns true when APCORE_AI_ENABLED=true', () => {
      process.env.APCORE_AI_ENABLED = 'true';
      expect(AIEnhancer.isEnabled()).toBe(true);
    });

    it('returns true when APCORE_AI_ENABLED=1', () => {
      process.env.APCORE_AI_ENABLED = '1';
      expect(AIEnhancer.isEnabled()).toBe(true);
    });

    it('returns true when APCORE_AI_ENABLED=yes', () => {
      process.env.APCORE_AI_ENABLED = 'yes';
      expect(AIEnhancer.isEnabled()).toBe(true);
    });

    it('returns false for other values', () => {
      process.env.APCORE_AI_ENABLED = 'false';
      expect(AIEnhancer.isEnabled()).toBe(false);
    });
  });

  describe('constructor', () => {
    it('uses defaults when no options or env vars', () => {
      const enhancer = new AIEnhancer();
      expect(enhancer.endpoint).toBe('http://localhost:11434/v1');
      expect(enhancer.model).toBe('qwen:0.6b');
      expect(enhancer.threshold).toBe(0.7);
      expect(enhancer.batchSize).toBe(5);
      expect(enhancer.timeout).toBe(30);
    });

    it('accepts constructor options', () => {
      const enhancer = new AIEnhancer({
        endpoint: 'http://custom:8080/v1',
        model: 'llama3',
        threshold: 0.5,
        batchSize: 10,
        timeout: 60,
      });
      expect(enhancer.endpoint).toBe('http://custom:8080/v1');
      expect(enhancer.model).toBe('llama3');
      expect(enhancer.threshold).toBe(0.5);
      expect(enhancer.batchSize).toBe(10);
      expect(enhancer.timeout).toBe(60);
    });

    it('reads from env vars when no options', () => {
      process.env.APCORE_AI_ENDPOINT = 'http://env:9090/v1';
      process.env.APCORE_AI_MODEL = 'phi3';
      process.env.APCORE_AI_THRESHOLD = '0.9';
      process.env.APCORE_AI_BATCH_SIZE = '3';
      process.env.APCORE_AI_TIMEOUT = '15';
      const enhancer = new AIEnhancer();
      expect(enhancer.endpoint).toBe('http://env:9090/v1');
      expect(enhancer.model).toBe('phi3');
      expect(enhancer.threshold).toBe(0.9);
      expect(enhancer.batchSize).toBe(3);
      expect(enhancer.timeout).toBe(15);
    });

    it('throws for invalid threshold', () => {
      expect(() => new AIEnhancer({ threshold: 1.5 })).toThrow('between 0.0 and 1.0');
    });

    it('throws for invalid batchSize', () => {
      expect(() => new AIEnhancer({ batchSize: 0 })).toThrow('positive integer');
    });

    it('throws for invalid timeout', () => {
      expect(() => new AIEnhancer({ timeout: -1 })).toThrow('positive integer');
    });
  });

  describe('_parseResponse', () => {
    it('parses plain JSON', () => {
      const result = AIEnhancer._parseResponse('{"description": "test"}');
      expect(result).toEqual({ description: 'test' });
    });

    it('strips markdown code fences', () => {
      const result = AIEnhancer._parseResponse('```json\n{"description": "test"}\n```');
      expect(result).toEqual({ description: 'test' });
    });

    it('throws for invalid JSON', () => {
      expect(() => AIEnhancer._parseResponse('not json')).toThrow('invalid JSON');
    });
  });

  describe('enhance', () => {
    it('returns modules unchanged when no gaps', async () => {
      const mod = createScannedModule({
        moduleId: 'test.mod',
        description: 'A real description',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        outputSchema: { type: 'object' },
        tags: ['test'],
        target: 'test:mod',
        documentation: 'Full docs here',
        annotations: { readonly: true, destructive: false, idempotent: false },
      });
      const enhancer = new AIEnhancer();
      const result = await enhancer.enhance([mod]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(mod); // same reference, no changes
    });
  });
});
