import { resolve, isAbsolute } from 'node:path';

/**
 * Dynamically imports a module and resolves a named export.
 *
 * Target format: `"module/path:exportName"`.
 * The LAST `:` is used as the separator so that Node.js built-in prefixes
 * like `node:path` are supported (e.g. `"node:path:join"`).
 *
 * @param target - The target string in "module:export" format.
 * @param allowedPrefixes - Optional list of allowed directory prefixes for
 *   absolute/relative paths. If provided, file-path imports must resolve
 *   under one of these directories. Package-name imports (no leading `.` or `/`)
 *   are always allowed.
 */
export async function resolveTarget(
  target: string,
  allowedPrefixes?: string[],
): Promise<unknown> {
  const lastColon = target.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(
      `Invalid target format: "${target}". Expected "module/path:exportName".`,
    );
  }

  const modulePath = target.slice(0, lastColon);
  const exportName = target.slice(lastColon + 1);

  // Validate file-path imports against allowedPrefixes
  const isFilePath = modulePath.startsWith('.') || isAbsolute(modulePath);
  if (isFilePath && allowedPrefixes != null && allowedPrefixes.length > 0) {
    const resolved = resolve(modulePath);
    const allowed = allowedPrefixes.some((prefix) =>
      resolved.startsWith(resolve(prefix)),
    );
    if (!allowed) {
      throw new Error(
        `Import path "${modulePath}" is not under any allowed prefix: ${allowedPrefixes.join(', ')}`,
      );
    }
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(modulePath)) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to import module "${modulePath}": ${message}`);
  }

  if (mod[exportName] === undefined) {
    throw new Error(
      `Export "${exportName}" not found in module "${modulePath}".`,
    );
  }

  return mod[exportName];
}
