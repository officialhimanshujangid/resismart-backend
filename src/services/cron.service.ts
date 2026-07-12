import cron from 'node-cron';
import { Subscription } from '../models/subscription.model';
import { GlobalSetting } from '../models/global-setting.model';
import { Plan } from '../models/plan.model';
import EmailService from './email.service';
import { resolveTenantEmail } from '../utils/tenant-email.util';
import { assignFreeTier } from './subscription-lifecycle.service';
import { expireDueBoosts } from './listing-boost.service';
import { SavedSearch } from '../models/saved-search.model';
import { PropertyListing } from '../models/property-listing.model';
import { User } from '../models/user.model';
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
      const { email, name } = await resolveTenantEmail(sub.tenantId, sub.tenantType);
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

    const { email, name } = await resolveTenantEmail(sub.tenantId, sub.tenantType);
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

    const { email, name } = await resolveTenantEmail(sub.tenantId, sub.tenantType);
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

    const { email, name } = await resolveTenantEmail(sub.tenantId, sub.tenantType);
    if (email) EmailService.sendSubscriptionExpiredEmail(email, name, await planNameFor(sub.planId, sub.tenure));
  }

  if (expiring.length) logger.info(`[cron] ${expiring.length} plan(s) entered grace`);
  if (revertedCount) logger.info(`[cron] ${revertedCount} plan(s) reverted to Free tier`);
}

/** Emails saved-search owners when new listings match their criteria. */
export async function runSavedSearchAlerts(): Promise<void> {
  const now = new Date();
  const searches = await SavedSearch.find({ alertsEnabled: true }).lean();
  let notified = 0;

  for (const s of searches) {
    const cutoff = s.lastNotifiedAt || new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const c = s.criteria || {};
    const match: Record<string, any> = { status: 'ACTIVE', publishedAt: { $gt: cutoff } };
    if (c.kind) match.kind = c.kind;
    if (c.city) match.city = { $regex: c.city, $options: 'i' };
    if (c.pincode) match.pincode = c.pincode;
    if (c.bedrooms !== undefined) match.bedrooms = { $gte: c.bedrooms };
    if (c.minPaise !== undefined || c.maxPaise !== undefined) {
      match.pricePaise = {};
      if (c.minPaise !== undefined) match.pricePaise.$gte = c.minPaise;
      if (c.maxPaise !== undefined) match.pricePaise.$lte = c.maxPaise;
    }

    const matches = await PropertyListing.find(match).sort({ publishedAt: -1 }).limit(10).select('title pricePaise priceType city slug').lean();
    await SavedSearch.updateOne({ _id: s._id }, { $set: { lastNotifiedAt: now } });
    if (!matches.length) continue;

    const user = await User.findById(s.userId).select('email name').lean();
    if (!user?.email) continue;
    const rows = matches.map((m) => `<li><strong>${m.title}</strong> — ₹${(m.pricePaise / 100).toLocaleString('en-IN')}${m.priceType === 'PER_MONTH' ? '/mo' : ''}${m.city ? ` · ${m.city}` : ''}</li>`).join('');
    EmailService.sendEmail({
      to: user.email,
      subject: `${matches.length} new propert${matches.length === 1 ? 'y' : 'ies'} match your saved search`,
      html: `<p>New listings matching "${s.name || 'your saved search'}":</p><ul>${rows}</ul>`,
    });
    notified++;
  }
  if (notified) logger.info(`[cron] Sent ${notified} saved-search alert email(s)`);
}

const runDailyJobs = async () => {
  try {
    await runPromoteScheduled();
    await runExpireOverdue();
    await runExpiryReminders();
    await runSavedSearchAlerts();
  } catch (err: any) {
    logger.error(`[cron] Daily job failed: ${err.message}`);
  }
};

/** Expires ad-boosts whose window has ended, resetting listings to the free base radius. */
export async function runExpireBoosts(): Promise<void> {
  try {
    await expireDueBoosts();
  } catch (err: any) {
    logger.error(`[cron] Boost expiry failed: ${err.message}`);
  }
}

/** Expires ACTIVE listings whose expiresAt has passed; emails the listing author. */
export async function runExpireListings(): Promise<void> {
  const now = new Date();
  const due = await PropertyListing.find({ status: 'ACTIVE', expiresAt: { $lte: now } })
    .select('title slug createdByUserId')
    .limit(500)
    .lean();

  if (!due.length) return;

  // Bulk-expire all at once
  const ids = due.map((l) => l._id);
  await PropertyListing.updateMany({ _id: { $in: ids } }, { $set: { status: 'EXPIRED' } });

  // Email authors best-effort
  for (const listing of due) {
    try {
      const owner = await User.findById(listing.createdByUserId).select('email name').lean();
      if (owner?.email) {
        EmailService.sendListingExpiredEmail(owner.email, owner.name, listing.title, listing.slug);
      }
    } catch (_) { /* non-fatal */ }
  }

  logger.info(`[cron] Expired ${due.length} listing(s)`);
}

/** Registers scheduled jobs. Daily subscription jobs at 09:00; listing expiry at 09:05; boost expiry hourly. */
export function startCronJobs(): void {
  cron.schedule('0 9 * * *', runDailyJobs);
  cron.schedule('5 9 * * *', runExpireListings);
  cron.schedule('0 * * * *', runExpireBoosts);
  logger.info('[cron] Scheduled daily subscription jobs (09:00), listing expiry (09:05), and hourly boost expiry');
}

export default startCronJobs;
