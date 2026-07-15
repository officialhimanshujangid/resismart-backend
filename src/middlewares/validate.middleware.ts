import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Validation middleware. Parses the chosen request part with a zod schema and,
 * on success, REPLACES it with the parsed (whitelisted) data. Because unknown
 * keys are stripped by zod, this doubles as protection against mass-assignment:
 * downstream handlers only ever see fields the schema declares.
 *
 * Matches the repo's error convention: `{ error: <first issue message> }`.
 */
export const validate = (schema: ZodSchema, target: ValidationTarget = 'body') =>
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[target]);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    // Overwrite with the sanitized data. For `query`/`params` (read-only getters
    // on some Express versions) assign field-by-field to avoid a setter throw.
    if (target === 'body') {
      req.body = parsed.data;
    } else {
      Object.assign(req[target] as Record<string, unknown>, parsed.data);
    }
    next();
  };

export default validate;
