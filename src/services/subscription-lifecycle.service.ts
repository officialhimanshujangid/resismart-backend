import mongoose from 'mongoose';
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { GlobalSetting } from '../models/global-setting.model';

const FREE_PLAN_NAME = 'Free';
const FAR_FUTURE = new Date('2099-12-31T00:00:00.000Z');

const DEFAULT_CAPS: Record<string, number> = {
  max_staff_count: 5,
  max_flat_count: 5,
  max_member_count: 20,
  max_visitor_count: 50,
  max_tickets_count: 20,
  max_service_count: 5,
};

/** Converts a Map/object of capabilities into a plain object. */
export function capsToObject(caps: any): Record<string, any> {
  if (!caps) return {};
  return caps instanceof Map ? Object.fromEntries(caps) : caps;
}

/** Free-tier capability limits from GlobalSetting (falls back to sane defaults). */
export async function getFreeTierCaps(): Promise<Record<string, number>> {
  const setting = await GlobalSetting.findOne();
  if (setting?.defaultTrialCapabilities) {
    const caps = setting.defaultTrialCapabilities as any;
    return caps instanceof Map ? Object.fromEntries(caps) : caps;
  }
  return DEFAULT_CAPS;
}

/** Find-or-create the internal Free plan whose capabilities mirror the free-tier limits. */
export async function ensureFreeTierPlan(): Promise<any> {
  const caps = await getFreeTierCaps();
  // Keep backward-compat with the older "Free Trial" system plan name.
  let plan = await Plan.findOne({ isSystem: true, name: { $in: [FREE_PLAN_NAME, 'Free Trial'] } });
  if (!plan) {
    plan = await Plan.create({
      name: FREE_PLAN_NAME,
      description: 'Default free tier — active whenever there is no valid paid plan.',
      isSystem: true,
      isActive: false,
      basePrice: 0,
      capabilities: caps,
    });
  } else {
    plan.capabilities = new Map(Object.entries(caps)) as any;
    await plan.save();
  }
  return plan;
}

/**
 * Ensures a society has the perpetual free-tier subscription active.
 * Idempotent — skips if a non-cancelled free-tier sub already governs access.
 */
export async function assignFreeTier(tenantIdRaw: mongoose.Types.ObjectId | string, tenantType: string = 'SOCIETY', performedBy = 'system'): Promise<any> {
  const tenantId = new mongoose.Types.ObjectId(String(tenantIdRaw));
  const plan = await ensureFreeTierPlan();

  const existingFree = await Subscription.findOne({
    tenantId, tenantType, isFreeTier: true, status: { $in: ['trialing', 'active'] },
  });
  if (existingFree) return existingFree;

  const now = new Date();
  return Subscription.create({
    tenantId,
    tenantType,
    planId: plan._id,
    tenure: 'trial',
    status: 'trialing',
    isFreeTier: true,
    startDate: now,
    endDate: FAR_FUTURE,
    history: [{ action: 'trial_started', toPlanId: plan._id, note: 'Free tier activated (no valid paid plan).', performedBy, date: now }],
  });
}

/**
 * The subscription currently GOVERNING access for a tenant:
 * a paid active/past_due (grace) sub if present, otherwise the free tier.
 * Excludes future 'scheduled' subs. Creates the free tier if nothing exists.
 */
export async function getGoverningSubscription(tenantIdRaw: mongoose.Types.ObjectId | string, tenantType: string = 'SOCIETY'): Promise<any> {
  const tenantId = new mongoose.Types.ObjectId(String(tenantIdRaw));
  const now = new Date();

  // Prefer a paid, currently-running sub (active or in grace).
  const paid = await Subscription.findOne({
    tenantId, tenantType, isFreeTier: { $ne: true },
    status: { $in: ['active', 'past_due'] },
    startDate: { $lte: now },
  }).sort({ startDate: -1 }).populate('planId');
  if (paid) return paid;

  // Otherwise the free tier (create if missing).
  let free = await Subscription.findOne({
    tenantId, tenantType, isFreeTier: true, status: { $in: ['trialing', 'active'] },
  }).populate('planId');

  if (!free) {
    // Should generally be created at approval time, but just in case:
    free = await assignFreeTier(tenantIdRaw, tenantType);
    free = await Subscription.findById(free?._id).populate('planId');
  }

  return free;
}

/**
 * Effective capability limits + plan context for enforcement.
 */
export async function getEffectiveLimits(tenantIdRaw: mongoose.Types.ObjectId | string, tenantType: string = 'SOCIETY'): Promise<{
  limits: Record<string, any>;
  planName: string;
  status: string;
  isFreeTier: boolean;
  endDate?: Date;
  graceEndsAt?: Date;
}> {
  const sub = await getGoverningSubscription(tenantIdRaw, tenantType);
  if (!sub) {
    return { limits: await getFreeTierCaps(), planName: 'Free', status: 'none', isFreeTier: true };
  }
  const planDoc: any = sub.planId;
  let limits: Record<string, any> = {};
  if (sub.isFreeTier) {
    // Free tier always follows the latest configured limits.
    limits = await getFreeTierCaps();
  } else if (sub.capabilities && (sub.capabilities instanceof Map ? sub.capabilities.size : Object.keys(sub.capabilities).length)) {
    // Paid plan: use the snapshot taken at purchase — editing the plan later does NOT change it.
    limits = capsToObject(sub.capabilities);
  } else if (planDoc?.capabilities) {
    // Legacy subscriptions created before snapshots existed → fall back to the live plan.
    limits = capsToObject(planDoc.capabilities);
  } else {
    limits = await getFreeTierCaps();
  }
  return {
    limits,
    planName: planDoc?.name || 'Free',
    status: sub.status,
    isFreeTier: Boolean(sub.isFreeTier),
    endDate: sub.endDate,
    graceEndsAt: sub.graceEndsAt,
  };
}

export { FAR_FUTURE, FREE_PLAN_NAME };
