import { RazorpayService } from './razorpay.service';
import { isRazorpayConfigured } from '../config/appConfig';
import { logger } from '../utils/logger.util';

const PERIOD_MAP: Record<string, { period: 'monthly' | 'yearly'; interval: number }> = {
  monthly: { period: 'monthly', interval: 1 },
  quarterly: { period: 'monthly', interval: 3 },
  halfYearly: { period: 'monthly', interval: 6 },
  yearly: { period: 'yearly', interval: 1 },
};

/**
 * Ensures every enabled billing cycle on a plan has a matching Razorpay Plan
 * object (filling `razorpayPlanId`). Razorpay plans are immutable, so a cycle
 * whose id is empty (new plan, pricing changed, or pre-existing legacy plan)
 * gets a fresh one. Saves the plan if anything changed. Returns true if updated.
 */
export async function ensureRazorpayPlans(plan: any): Promise<boolean> {
  if (!isRazorpayConfigured() || plan.isSystem) return false;
  let changed = false;
  for (const cyc of plan.billingCycles) {
    if (!cyc.isEnabled || cyc.razorpayPlanId) continue;
    const pricing = plan.getPricingForTenure(cyc.tenure);
    const map = PERIOD_MAP[cyc.tenure];
    if (!pricing || pricing.totalPrice <= 0 || !map) continue;
    try {
      const rp = await RazorpayService.createPlan({
        period: map.period,
        interval: map.interval,
        name: `${plan.name} — ${cyc.label}`,
        amountPaise: pricing.totalPrice * 100,
        currency: plan.currency || 'INR',
      });
      cyc.razorpayPlanId = rp.id;
      changed = true;
    } catch (e: any) {
      logger.error(`Failed to create Razorpay plan for ${plan.name}/${cyc.tenure}: ${e.message}`);
    }
  }
  if (changed) await plan.save();
  return changed;
}
