// Typed application errors → JSON `{ error: { code, message, data } }` (see middleware/errors.ts).
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NAME_CONFLICT'
  | 'INVALID_NAME'
  | 'QUOTA_FULL'
  | 'FILE_TOO_LARGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'RANGE_NOT_SATISFIABLE'
  | 'UPLOAD_STATE'
  | 'READ_ONLY'
  | 'RATE_LIMITED'
  | 'ORIGIN_MISMATCH'
  | 'CSRF'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NAME_CONFLICT: 409,
  INVALID_NAME: 400,
  QUOTA_FULL: 413,
  FILE_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  RANGE_NOT_SATISFIABLE: 416,
  UPLOAD_STATE: 409,
  READ_ONLY: 403,
  RATE_LIMITED: 429,
  ORIGIN_MISMATCH: 403,
  CSRF: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
