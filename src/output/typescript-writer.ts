import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ScannedModule } from '../types.js';

export class TypeScriptWriter {
  write(
    modules: ScannedModule[],
    outputDir: string,
    options?: { dryRun?: boolean },
  ): string[] {
    const dryRun = options?.dryRun ?? false;
    const results: string[] = [];
    const timestamp = new Date().toISOString();

    const resolvedOut = dryRun ? '' : resolve(outputDir);

    if (!dryRun) {
      mkdirSync(resolvedOut, { recursive: true });
    }

    for (const mod of modules) {
      const code = this._generateCode(mod, timestamp);
      results.push(code);

      if (!dryRun) {
        // Path traversal protection: check raw moduleId before sanitization
        const rawResolved = resolve(join(resolvedOut, mod.moduleId));
        if (!rawResolved.startsWith(resolvedOut + '/') && rawResolved !== resolvedOut) {
          console.warn('Skipping module with path traversal in id: %s', mod.moduleId);
          continue;
        }

        const sanitized = this._sanitizeIdentifier(mod.moduleId);
        const filename = `${sanitized}.ts`;
        writeFileSync(resolve(join(resolvedOut, filename)), code, 'utf-8');
      }
    }

    return results;
  }

  private _generateCode(mod: ScannedModule, timestamp: string): string {
    const { modulePath, exportName } = this._parseTarget(mod.target);

    const lines: string[] = [];
    lines.push(`// Auto-generated apcore module: ${JSON.stringify(mod.moduleId)}`);
    lines.push(`// Generated: ${timestamp}`);
    lines.push('// Do not edit manually unless you intend to customize behavior.');
    lines.push('');
    lines.push("import { module } from 'apcore-js';");
    lines.push('');
    lines.push('export default module({');
    lines.push(`  id: ${JSON.stringify(mod.moduleId)},`);
    lines.push(`  description: ${JSON.stringify(mod.description)},`);
    lines.push(`  inputSchema: ${JSON.stringify(mod.inputSchema)},`);
    lines.push(`  outputSchema: ${JSON.stringify(mod.outputSchema)},`);
    lines.push(`  tags: ${JSON.stringify([...mod.tags])},`);
    lines.push(`  version: ${JSON.stringify(mod.version)},`);

    if (mod.annotations !== null) {
      lines.push(`  annotations: ${JSON.stringify(mod.annotations)},`);
    }

    lines.push('  async execute(inputs) {');
    lines.push(`    const { ${exportName}: _original } = await import(${JSON.stringify(modulePath)});`);
    lines.push('    return _original(inputs);');
    lines.push('  },');
    lines.push('});');
    lines.push('');

    return lines.join('\n');
  }

  private _parseTarget(target: string): { modulePath: string; exportName: string } {
    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) {
      throw new Error(`Invalid target format: ${target}`);
    }
    const exportName = target.slice(lastColon + 1);
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exportName)) {
      throw new Error(`Invalid export name: ${exportName}`);
    }
    return {
      modulePath: target.slice(0, lastColon),
      exportName,
    };
  }

  private _sanitizeIdentifier(name: string): string {
    let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
    if (/^[0-9]/.test(sanitized)) {
      sanitized = `_${sanitized}`;
    }
    return sanitized;
  }
}
