export interface WriteResult {
  readonly moduleId: string;
  readonly path: string | null;
  readonly verified: boolean;
  readonly verificationError: string | null;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface Verifier {
  verify(path: string, moduleId: string): VerifyResult;
}

export function createWriteResult(
  moduleId: string,
  path: string | null = null,
  verified = true,
  verificationError: string | null = null,
): WriteResult {
  return { moduleId, path, verified, verificationError };
}
