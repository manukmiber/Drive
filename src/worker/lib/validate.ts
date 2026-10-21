import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';
import { AppError } from './errors';

/** zValidator that reports failures in our `{ error: { code: 'VALIDATION' } }` shape. */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new AppError('VALIDATION', 'invalid request', { issues: result.error.issues });
    }
  });
}
