/** HTTP vead ja sisendi kontroll. */
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `Vigane sisend: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim());
  }
  return result.data;
}
