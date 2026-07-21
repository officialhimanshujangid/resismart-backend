import { Request, Response, NextFunction } from 'express';
import { isOpsBlocked } from '../services/ops-setup.service';

/**
 * Stop a brand-new society logging visitors against nothing.
 *
 * Applied to the two routes that create a visitor entry, and nowhere else. The
 * finance gate is mounted on its whole router because a wrong opening balance
 * is unfixable; this is narrower on purpose, because the failure it prevents is
 * smaller and the cost of over-reaching is much larger — a guard locked out of
 * the console falls back to a paper book and that evening's record is gone.
 *
 * `isOpsBlocked` is false the moment a single entry exists, so a society that
 * was already using the gate before this shipped is never affected. It can only
 * ever fire on the very first arrival at a society with no gates named.
 *
 * Fails OPEN on a lookup error, for the same reason.
 */
export async function requireOpsSetup(req: Request, res: Response, next: NextFunction) {
  const societyId = req.user?.activeTenantId;
  if (!societyId) return next();   // enforceTenantAccess already had its say

  try {
    if (!(await isOpsBlocked(String(societyId)))) return next();
  } catch {
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'OPS_SETUP_INCOMPLETE',
    message:
      'No gate has been set up for this society yet. Add one in Operations → Gate → Gates, or the register cannot say which door anybody came through.',
  });
}
