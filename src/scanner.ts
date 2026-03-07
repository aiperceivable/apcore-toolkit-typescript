import type { ModuleAnnotations } from 'apcore-js';
import { DEFAULT_ANNOTATIONS } from 'apcore-js';
import type { ScannedModule } from './types.js';
import { cloneModule } from './types.js';

export abstract class BaseScanner {
  abstract scan(...args: unknown[]): ScannedModule[] | Promise<ScannedModule[]>;
  abstract getSourceName(): string;

  filterModules(
    modules: ScannedModule[],
    options?: { include?: string; exclude?: string },
  ): ScannedModule[] {
    let result = modules;

    if (options?.include != null) {
      const include = options.include;
      result = result.filter((m) => new RegExp(include).test(m.moduleId));
    }

    if (options?.exclude != null) {
      const exclude = options.exclude;
      result = result.filter((m) => !new RegExp(exclude).test(m.moduleId));
    }

    return result;
  }

  static inferAnnotationsFromMethod(method: string): ModuleAnnotations {
    const upper = method.toUpperCase();

    if (upper === 'GET') {
      return { ...DEFAULT_ANNOTATIONS, readonly: true };
    }
    if (upper === 'DELETE') {
      return { ...DEFAULT_ANNOTATIONS, destructive: true };
    }
    if (upper === 'PUT') {
      return { ...DEFAULT_ANNOTATIONS, idempotent: true };
    }

    return { ...DEFAULT_ANNOTATIONS };
  }

  deduplicateIds(modules: ScannedModule[]): ScannedModule[] {
    const seen = new Map<string, number>();
    const result: ScannedModule[] = [];

    for (const module of modules) {
      const mid = module.moduleId;
      const count = seen.get(mid) ?? 0;
      seen.set(mid, count + 1);

      if (count > 0) {
        const newId = `${mid}_${count + 1}`;
        result.push(
          cloneModule(module, {
            moduleId: newId,
            warnings: [
              ...module.warnings,
              `Module ID renamed from '${mid}' to '${newId}' to avoid collision`,
            ],
          }),
        );
      } else {
        result.push(module);
      }
    }

    return result;
  }
}
