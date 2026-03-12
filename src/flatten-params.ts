/**
 * Wraps a function, converting Zod schema parameters into flat keyword arguments.
 *
 * This is the TypeScript equivalent of Python's `flatten_pydantic_params()`.
 * It takes a function whose first parameter is a Zod-validated object and returns
 * a new function that accepts the object's fields as individual keyword arguments.
 *
 * @param func - The original function accepting a single object parameter
 * @param zodSchema - A Zod schema describing the object's shape
 * @returns A new function that accepts flattened parameters
 */
export function flattenParams<T extends Record<string, unknown>>(
  func: (input: T) => unknown,
  zodSchema: { parse(data: unknown): T; shape?: Record<string, unknown> },
): (args: Record<string, unknown>) => unknown {
  return (args: Record<string, unknown>) => {
    const parsed = zodSchema.parse(args);
    return func(parsed);
  };
}
