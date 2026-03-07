/**
 * Dynamically imports a module and resolves a named export.
 *
 * Target format: `"module/path:exportName"`.
 * The LAST `:` is used as the separator so that Node.js built-in prefixes
 * like `node:path` are supported (e.g. `"node:path:join"`).
 */
export async function resolveTarget(target: string): Promise<unknown> {
  const lastColon = target.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(
      `Invalid target format: "${target}". Expected "module/path:exportName".`,
    );
  }

  const modulePath = target.slice(0, lastColon);
  const exportName = target.slice(lastColon + 1);

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
