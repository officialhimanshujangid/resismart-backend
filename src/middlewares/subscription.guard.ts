import { Request, Response, NextFunction } from 'express';
import { getEffectiveLimits } from '../services/subscription-lifecycle.service';

/**
 * Enforces capability limits for a society's CURRENT effective plan.
 *
 * Effective plan = the paid plan while active or within its grace period;
 * otherwise the perpetual Free tier. When a creation would exceed the limit the
 * request is rejected with HTTP 402 and `upgradeRequired: true` so the client can
 * show an "upgrade your plan" screen.
 *
 * @param capabilityKey   e.g. 'max_flat_count'
 * @param getCurrentCount returns the society's current usage for that capability
 */
export const enforceLimit = (
  capabilityKey: string,
  getCurrentCount: (societyId: string) => Promise<number>
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) {
        res.status(403).json({ error: 'No active society context found' });
        return;
      }

      const { limits, planName, status, isFreeTier } = await getEffectiveLimits(societyId);
      const limit = limits?.[capabilityKey];

      // null / undefined / -1 => unlimited
      if (limit === null || limit === undefined || Number(limit) === -1) {
        return next();
      }

      const currentCount = await getCurrentCount(societyId);
      if (currentCount >= Number(limit)) {
        res.status(402).json({
          error: isFreeTier || status === 'expired'
            ? `You are on the Free tier (limit ${limit} for ${capabilityKey.replace(/^max_|_count$/g, '').replace(/_/g, ' ')}). Upgrade to a paid plan to add more.`
            : `Your ${planName} plan allows up to ${limit}. Please upgrade to add more.`,
          upgradeRequired: true,
          code: 'PLAN_LIMIT_REACHED',
          capability: capabilityKey,
          limit: Number(limit),
          current: currentCount,
          planName,
          isFreeTier,
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export default enforceLimit;
