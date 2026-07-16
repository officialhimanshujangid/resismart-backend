import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { FinancePolicy } from '../models/finance-policy.model';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { resolveModules, MODULE_CATALOG } from '../services/finance-modules.service';

/** Fields a client is never allowed to set through the policy update body. */
function stripSecrets(policy: any) {
  const obj = policy.toObject ? policy.toObject() : policy;
  if (obj?.settlement?.ownKeys) {
    delete obj.settlement.ownKeys.keySecretEnc;
    delete obj.settlement.ownKeys.keySecretIv;
    delete obj.settlement.ownKeys.keySecretTag;
    delete obj.settlement.ownKeys.webhookSecretEnc;
    delete obj.settlement.ownKeys.webhookSecretIv;
    delete obj.settlement.ownKeys.webhookSecretTag;
  }
  return obj;
}

/**
 * GET /finance/society/modules — which optional screens this society uses.
 *
 * Its own endpoint because the sidebar needs it on every page, for admins and
 * committee alike, and shouldn't have to pull the whole policy (secrets and all)
 * to draw a menu.
 */
export const getModules = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    res.json({ modules: await resolveModules(societyId), catalog: MODULE_CATALOG });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getPolicy = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const policy = await getOrCreatePolicy(societyId, req.user!.userId, req.user!.userName || 'Admin');
    res.json(stripSecrets(policy));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updatePolicy = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const policy = await getOrCreatePolicy(societyId, req.user!.userId, req.user!.userName || 'Admin');

    // req.body is zod-validated + whitelisted. Settlement secrets are managed via
    // a dedicated endpoint (Phase 5), never through this general policy update.
    const body = { ...req.body };
    delete body.settlement?.ownKeys;

    // Closing or reopening the books is an audit-relevant act, so stamp who did
    // it. '' / null reopens; a date closes everything on or before it.
    if (body.lock && 'lockedUpToDate' in body.lock) {
      const d = body.lock.lockedUpToDate;
      body.lock = d
        ? { lockedUpToDate: new Date(d), lockedBy: new mongoose.Types.ObjectId(req.user!.userId), lockedByName: req.user!.userName || 'Admin', lockedAt: new Date() }
        : { lockedUpToDate: null, lockedBy: null, lockedByName: null, lockedAt: null };
    }

    policy.set(body);
    policy.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    policy.updatedByName = req.user!.userName || 'Admin';
    await policy.save();

    res.json(stripSecrets(policy));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
