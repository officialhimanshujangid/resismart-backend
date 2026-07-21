import { Request, Response, NextFunction } from 'express';
import { OpsModule } from '../models/society-ops-policy.model';
import {
  resolveOpsModules, planAllows, planLimit, CAPABILITIES, defaultResidentFeatures,
} from '../services/entitlement.service';
import { getEffectiveLimits } from '../services/subscription-lifecycle.service';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * Gate 1 and gate 2, enforced on the request rather than only in the menu.
 *
 * **404, not 403** — and the difference is the whole point. A module the
 * society did not buy should not appear to exist: 403 says "this is here and
 * you may not have it", which invites a support call about a feature that was
 * never sold. 404 says what is true.
 *
 * Before this existed, `enforceLimit` was the only plan check anywhere, and it
 * could only refuse a *creation* at the moment of writing. So a society whose
 * plan excluded Complaints still saw the menu, opened the page, typed out
 * their problem, and only then got an error.
 */
export function requireModule(module: OpsModule) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      return res.status(401).json({ success: false, message: 'Not signed in to a society.' });
    }

    try {
      const { limits } = await getEffectiveLimits(String(societyId));
      const on = await resolveOpsModules(String(societyId), limits);
      if (!on.includes(module)) {
        return res.status(404).json({
          success: false,
          code: 'MODULE_NOT_AVAILABLE',
          message: 'This is not part of what your society uses.',
        });
      }
      return next();
    } catch (e: any) {
      // Fails CLOSED, like `requirePermission` and unlike the setup gates.
      // "We could not check what you bought" must never mean "go ahead".
      logger.error(`requireModule(${module}) failed: ${e.message}`);
      return res.status(503).json({ success: false, message: 'Could not check your plan. Try again.' });
    }
  };
}

/**
 * Gate 4 — whether the society offers this to residents at all.
 *
 * Only binds residents. Staff and committee reach these endpoints through
 * their own permissions, and a society that has switched off "residents may
 * invite guests" has said nothing about whether the office may issue a pass.
 */
export function requireResidentFeature(feature: string) {
  const RESIDENT_ROLES = ['RESIDENT_OWNER', 'RESIDENT_TENANT', 'FAMILY_MEMBER'];

  return async (req: Request, res: Response, next: NextFunction) => {
    const role = String(req.user?.activeRole || '');
    if (!RESIDENT_ROLES.includes(role)) return next();

    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      return res.status(401).json({ success: false, message: 'Not signed in to a society.' });
    }

    try {
      const policy = await SocietyOpsPolicy.findOne({ societyId: oid(societyId) })
        .select('residentFeatures').lean();
      const features = { ...defaultResidentFeatures(), ...(policy?.residentFeatures as any || {}) };
      if (features[feature] === false) {
        return res.status(403).json({
          success: false,
          code: 'FEATURE_OFF_FOR_RESIDENTS',
          message: 'Your society handles this at the office. Please speak to them.',
        });
      }
      return next();
    } catch (e: any) {
      logger.error(`requireResidentFeature(${feature}) failed: ${e.message}`);
      return res.status(503).json({ success: false, message: 'Could not check your society settings. Try again.' });
    }
  };
}

/**
 * Gate 1's numeric half: you may create up to what you bought.
 *
 * Replaces the old `enforceLimit`, which had to be handed a counting function
 * at every call site and was therefore wired to exactly two routes out of
 * seven capabilities. Here the counting lives with the capability, so adding a
 * limit to a new route is one word.
 *
 * A society already over a newly-lowered limit is never broken: existing data
 * stays readable and writable, only NEW creations are refused.
 */
export function enforceCapacity(key: string) {
  const spec = CAPABILITIES.find(c => c.key === key);

  return async (req: Request, res: Response, next: NextFunction) => {
    const societyId = req.user?.activeTenantId;
    if (!societyId || !spec) return next();

    try {
      const { limits, planName, isFreeTier } = await getEffectiveLimits(String(societyId));

      if (!planAllows(limits, key)) {
        return res.status(404).json({
          success: false, code: 'MODULE_NOT_AVAILABLE',
          message: 'This is not part of what your society uses.',
        });
      }

      const ceiling = planLimit(limits, key);
      if (ceiling === null) return next();

      const used = await spec.count(String(societyId));
      if (used >= ceiling) {
        return res.status(402).json({
          success: false,
          code: 'PLAN_LIMIT_REACHED',
          upgradeRequired: true,
          capability: key, limit: ceiling, current: used, planName, isFreeTier,
          // Says the number, the noun, and what to do — not "PLAN_LIMIT_REACHED".
          message: `Your ${isFreeTier ? 'free' : planName} plan covers ${ceiling} ${spec.noun}, and you have ${used}. `
            + 'Ask your ResiSmart contact to upgrade, or remove one you no longer need.',
        });
      }
      return next();
    } catch (e: any) {
      logger.error(`enforceCapacity(${key}) failed: ${e.message}`);
      return res.status(503).json({ success: false, message: 'Could not check your plan. Try again.' });
    }
  };
}
