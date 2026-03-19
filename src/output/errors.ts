export class WriteError extends Error {
  readonly path: string;
  override readonly cause: Error;

  constructor(path: string, cause: Error) {
    super(`Write failed for ${path}: ${cause.message}`, { cause });
    this.name = 'WriteError';
    this.path = path;
    this.cause = cause;
  }
}
