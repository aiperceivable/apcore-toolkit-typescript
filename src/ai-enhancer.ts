/**
 * AI-driven metadata enhancement using local SLMs.
 *
 * Uses an OpenAI-compatible local API (e.g., Ollama, vLLM, LM Studio) to fill
 * metadata gaps that static analysis cannot resolve: missing descriptions,
 * behavioral annotation inference, and schema inference for untyped functions.
 *
 * All AI-generated fields are tagged with `x-generated-by: slm` in the module's
 * metadata dict for auditability.
 */

import type { ModuleAnnotations } from 'apcore-js';
import { DEFAULT_ANNOTATIONS } from 'apcore-js';
import type { ScannedModule } from './types.js';
import { cloneModule } from './types.js';

const _DEFAULT_ENDPOINT = 'http://localhost:11434/v1';
const _DEFAULT_MODEL = 'qwen:0.6b';
const _DEFAULT_THRESHOLD = 0.7;
const _DEFAULT_BATCH_SIZE = 5;
const _DEFAULT_TIMEOUT = 30;

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const val = Number(raw);
  if (Number.isNaN(val)) throw new Error(`${name} must be a valid number, got "${raw}"`);
  return val;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) throw new Error(`${name} must be a valid integer, got "${raw}"`);
  return val;
}

export interface AIEnhancerOptions {
  endpoint?: string;
  model?: string;
  threshold?: number;
  batchSize?: number;
  timeout?: number;
}

export class AIEnhancer {
  readonly endpoint: string;
  readonly model: string;
  readonly threshold: number;
  readonly batchSize: number;
  readonly timeout: number;

  constructor(options?: AIEnhancerOptions) {
    this.endpoint = options?.endpoint ?? process.env.APCORE_AI_ENDPOINT ?? _DEFAULT_ENDPOINT;
    this.model = options?.model ?? process.env.APCORE_AI_MODEL ?? _DEFAULT_MODEL;
    this.threshold = options?.threshold ?? parseFloatEnv('APCORE_AI_THRESHOLD', _DEFAULT_THRESHOLD);
    this.batchSize = options?.batchSize ?? parseIntEnv('APCORE_AI_BATCH_SIZE', _DEFAULT_BATCH_SIZE);
    this.timeout = options?.timeout ?? parseIntEnv('APCORE_AI_TIMEOUT', _DEFAULT_TIMEOUT);

    if (this.threshold < 0 || this.threshold > 1) {
      throw new Error('APCORE_AI_THRESHOLD must be a number between 0.0 and 1.0');
    }
    if (this.batchSize <= 0) {
      throw new Error('APCORE_AI_BATCH_SIZE must be a positive integer');
    }
    if (this.timeout <= 0) {
      throw new Error('APCORE_AI_TIMEOUT must be a positive integer');
    }
  }

  static isEnabled(): boolean {
    const val = (process.env.APCORE_AI_ENABLED ?? 'false').toLowerCase();
    return val === 'true' || val === '1' || val === 'yes';
  }

  async enhance(modules: ScannedModule[]): Promise<ScannedModule[]> {
    const results: ScannedModule[] = [...modules];

    const pending: Array<{ idx: number; module: ScannedModule; gaps: string[] }> = [];
    for (let i = 0; i < modules.length; i++) {
      const gaps = this._identifyGaps(modules[i]);
      if (gaps.length > 0) {
        pending.push({ idx: i, module: modules[i], gaps });
      }
    }

    for (let batchStart = 0; batchStart < pending.length; batchStart += this.batchSize) {
      const batch = pending.slice(batchStart, batchStart + this.batchSize);
      for (const { idx, module, gaps } of batch) {
        try {
          const enhanced = await this._enhanceModule(module, gaps);
          results[idx] = enhanced;
        } catch {
          // AI enhancement failed — keep original
        }
      }
    }

    return results;
  }

  private _identifyGaps(module: ScannedModule): string[] {
    const gaps: string[] = [];
    if (!module.description || module.description === module.moduleId) {
      gaps.push('description');
    }
    if (!module.documentation) {
      gaps.push('documentation');
    }
    if (module.annotations == null || JSON.stringify(module.annotations) === JSON.stringify(DEFAULT_ANNOTATIONS)) {
      gaps.push('annotations');
    }
    const props = (module.inputSchema as Record<string, unknown>).properties;
    if (!props || (typeof props === 'object' && Object.keys(props).length === 0)) {
      gaps.push('input_schema');
    }
    return gaps;
  }

  private async _enhanceModule(module: ScannedModule, gaps: string[]): Promise<ScannedModule> {
    const prompt = this._buildPrompt(module, gaps);
    const response = await this._callLLM(prompt);
    const parsed = AIEnhancer._parseResponse(response);

    const updates: Record<string, unknown> = {};
    const confidence: Record<string, number> = {};
    const warnings: string[] = [...module.warnings];

    if (gaps.includes('description') && parsed.description) {
      const conf = parsed.confidence?.description ?? 0;
      confidence.description = conf;
      if (conf >= this.threshold) {
        updates.description = parsed.description;
      } else {
        warnings.push(`Low confidence (${conf.toFixed(2)}) for description — skipped. Review manually.`);
      }
    }

    if (gaps.includes('documentation') && parsed.documentation) {
      const conf = parsed.confidence?.documentation ?? 0;
      confidence.documentation = conf;
      if (conf >= this.threshold) {
        updates.documentation = parsed.documentation;
      } else {
        warnings.push(`Low confidence (${conf.toFixed(2)}) for documentation — skipped. Review manually.`);
      }
    }

    if (gaps.includes('annotations') && parsed.annotations && typeof parsed.annotations === 'object') {
      const annData = parsed.annotations as Record<string, unknown>;
      const annConf = (parsed.confidence ?? {}) as Record<string, number>;
      const accepted: Record<string, unknown> = {};
      const boolFields = [
        'readonly', 'destructive', 'idempotent', 'requires_approval',
        'open_world', 'streaming', 'cacheable', 'paginated',
      ];
      for (const field of boolFields) {
        if (typeof annData[field] === 'boolean') {
          const fieldConf = annConf[`annotations.${field}`] ?? annConf[field] ?? 0;
          confidence[`annotations.${field}`] = fieldConf;
          if (fieldConf >= this.threshold) {
            accepted[field] = annData[field];
          } else {
            warnings.push(`Low confidence (${fieldConf.toFixed(2)}) for annotations.${field} — skipped. Review manually.`);
          }
        }
      }
      if (Object.keys(accepted).length > 0) {
        const base = module.annotations ?? { ...DEFAULT_ANNOTATIONS };
        updates.annotations = { ...base, ...accepted };
      }
    }

    if (gaps.includes('input_schema') && parsed.input_schema) {
      const conf = parsed.confidence?.input_schema ?? 0;
      confidence.input_schema = conf;
      if (conf >= this.threshold) {
        updates.inputSchema = parsed.input_schema;
      } else {
        warnings.push(`Low confidence (${conf.toFixed(2)}) for input_schema — skipped. Review manually.`);
      }
    }

    if (Object.keys(updates).length === 0) {
      if (warnings.length !== module.warnings.length) {
        return cloneModule(module, { warnings });
      }
      return module;
    }

    const metadata: Record<string, unknown> = { ...module.metadata };
    metadata['x-generated-by'] = 'slm';
    metadata['x-ai-confidence'] = confidence;

    return cloneModule(module, { ...updates, metadata, warnings } as Partial<ScannedModule>);
  }

  private _buildPrompt(module: ScannedModule, gaps: string[]): string {
    const parts = [
      'You are analyzing a function to generate metadata for an AI-perceivable module system.',
      '',
      `Module ID: ${module.moduleId}`,
      `Target: ${module.target}`,
    ];
    if (module.description) {
      parts.push(`Current description: ${module.description}`);
    }

    parts.push('');
    parts.push('Please provide the following missing metadata as JSON:');
    parts.push('{');

    if (gaps.includes('description')) {
      parts.push('  "description": "<≤200 chars, what this function does>",');
    }
    if (gaps.includes('documentation')) {
      parts.push('  "documentation": "<detailed Markdown explanation>",');
    }
    if (gaps.includes('annotations')) {
      parts.push('  "annotations": {');
      parts.push('    "readonly": <true if no side effects>,');
      parts.push('    "destructive": <true if deletes/overwrites data>,');
      parts.push('    "idempotent": <true if safe to retry>,');
      parts.push('    "cacheable": <true if results can be cached>');
      parts.push('  },');
    }
    if (gaps.includes('input_schema')) {
      parts.push('  "input_schema": <JSON Schema object for function parameters>,');
    }

    parts.push('  "confidence": {');
    parts.push('    "description": 0.0, "documentation": 0.0');
    parts.push('  }');
    parts.push('}');
    parts.push('');
    parts.push('Respond with ONLY valid JSON, no markdown fences or explanation.');

    return parts.join('\n');
  }

  private async _callLLM(prompt: string): Promise<string> {
    const url = `${this.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const payload = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`SLM API returned ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as Record<string, unknown>;
      const choices = data.choices as Array<{ message: { content: string } }> | undefined;
      if (!choices?.[0]?.message?.content) {
        throw new Error('Unexpected API response structure');
      }
      return choices[0].message.content;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`SLM request timed out after ${this.timeout}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  static _parseResponse(response: string): Record<string, unknown> {
    let text = response.trim();
    if (text.startsWith('```')) {
      const lines = text.split('\n');
      if (lines[0].startsWith('```')) lines.shift();
      if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
      text = lines.join('\n');
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`SLM returned invalid JSON: ${(err as Error).message}`);
    }
  }
}
