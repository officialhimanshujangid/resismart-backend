import cron from 'node-cron';
import { Subscription } from '../models/subscription.model';
import { GlobalSetting } from '../models/global-setting.model';
import { Plan } from '../models/plan.model';
import EmailService from './email.service';
import { resolveSocietyEmail } from '../utils/society-email.util';
import { assignFreeTier } from './subscription-lifecycle.service';
import { logger } from '../utils/logger.util';

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

const planNameFor = async (planId: any, tenure: string): Promise<string> => {
  const plan = await Plan.findById(planId).select('name').lean();
  return plan?.name || (tenure === 'trial' ? 'Free' : 'Subscription');
};

/** Sends "expiring in N days" reminders for paid subs nearing their end date. */
export async function runExpiryReminders(): Promise<void> {
  const setting = await GlobalSetting.findOne();
  const days = setting?.expiryReminderDays?.length ? setting.expiryReminderDays : [3, 1];

  for (const n of days) {
    const target = new Date();
    target.setDate(target.getDate() + n);
    const subs = await Subscription.find({
      status: 'active',
      isFreeTier: { $ne: true },
      endDate: { $gte: startOfDay(target), $lte: endOfDay(target) },
    }).lean();

    let sent = 0;
    for (const sub of subs) {
      const { email, name } = await resolveSocietyEmail(sub.tenantId);
      if (!email) continue;
      EmailService.sendSubscriptionExpiryReminder(email, name, await planNameFor(sub.planId, sub.tenure), n, sub.endDate);
      sent++;
    }
    if (sent) logger.info(`[cron] Sent ${sent} expiry reminder(s) for the ${n}-day window`);
  }
}

/** Activates any scheduled (upcoming) subscriptions whose start date has arrived. */
export async function runPromoteScheduled(): Promise<void> {
  const now = new Date();
  const due = await Subscription.find({ status: 'scheduled', startDate: { $lte: now } }).sort({ startDate: 1 });

  for (const sub of due) {
    // Supersede the currently-running paid/free sub for this tenant.
    await Subscription.updateMany(
      { tenantId: sub.tenantId, tenantType: sub.tenantType, _id: { $ne: sub._id }, status: { $in: ['active', 'past_due', 'trialing'] } },
      { $set: { status: 'expired' }, $push: { history: { action: 'expired', note: 'Superseded by the scheduled plan that just started.', performedBy: 'system', date: now } } }
    );
    sub.status = 'active';
    sub.history.push({ action: 'activated', note: 'Scheduled plan started.', performedBy: 'system', date: now } as any);
    await sub.save();

    const { email, name } = await resolveSocietyEmail(sub.tenantId);
    if (email) EmailService.sendPaymentReceiptEmail(email, name, await planNameFor(sub.planId, sub.tenure), 0, sub.tenure);
  }
  if (due.length) logger.info(`[cron] Activated ${due.length} scheduled subscription(s)`);
}

/**
 * Paid plan lifecycle:
 *  - active past endDate  → past_due (grace begins; full access continues)
 *  - past_due past graceEndsAt → expired, then fall back to the free tier
 * Free-tier subscriptions never expire.
 */
export async function runExpireOverdue(): Promise<void> {
  const now = new Date();
  const setting = await GlobalSetting.findOne();
  const graceDays = setting?.gracePeriodDays ?? 7;

  // 1) active → past_due (start grace)
  const expiring = await Subscription.find({ status: 'active', isFreeTier: { $ne: true }, endDate: { $lt: now } });
  for (const sub of expiring) {
    const graceEnds = new Date(now);
    graceEnds.setDate(graceEnds.getDate() + graceDays);
    sub.status = 'past_due';
    sub.graceEndsAt = graceEnds;
    sub.history.push({ action: 'suspended', note: `Plan term ended; grace period until ${graceEnds.toLocaleDateString('en-IN')}.`, performedBy: 'system', date: now } as any);
    await sub.save();

    const { email, name } = await resolveSocietyEmail(sub.tenantId);
    if (email) EmailService.sendSubscriptionExpiryReminder(email, name, await planNameFor(sub.planId, sub.tenure), graceDays, graceEnds);
  }

  // 2) past_due → expired (grace over) → free tier
  const graceOver = await Subscription.find({ status: 'past_due', isFreeTier: { $ne: true } });
  let revertedCount = 0;
  for (const sub of graceOver) {
    if (sub.graceEndsAt && new Date(sub.graceEndsAt) > now) continue; // still in grace
    sub.status = 'expired';
    sub.history.push({ action: 'expired', note: 'Grace period ended; reverted to Free tier.', performedBy: 'system', date: now } as any);
    await sub.save();
    await assignFreeTier(sub.tenantId);
    revertedCount++;

    const { email, name } = await resolveSocietyEmail(sub.tenantId);
    if (email) EmailService.sendSubscriptionExpiredEmail(email, name, await planNameFor(sub.planId, sub.tenure));
  }

  if (expiring.length) logger.info(`[cron] ${expiring.length} plan(s) entered grace`);
  if (revertedCount) logger.info(`[cron] ${revertedCount} plan(s) reverted to Free tier`);
}

const runDailyJobs = async () => {
  try {
    await runPromoteScheduled();
    await runExpireOverdue();
    await runExpiryReminders();
  } catch (err: any) {
    logger.error(`[cron] Daily job failed: ${err.message}`);
  }
};

/** Registers scheduled jobs. Daily at 09:00 (server timezone). */
export function startCronJobs(): void {
  cron.schedule('0 9 * * *', runDailyJobs);
  logger.info('[cron] Scheduled daily subscription jobs at 09:00');
}

export default startCronJobs;
