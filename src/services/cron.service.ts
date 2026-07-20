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
import { SocietyFinanceSettings } from '../models/society-finance-settings.model';
import { SocietyFinanceService } from './society-finance.service';
import { FinancePolicy } from '../models/finance-policy.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { autoCloseStragglers, reconcileDay, purgeOldEntries } from './visitor.service';
import { purgeOld as purgeOldNotifications } from './notification.service';
import { pruneStaleTokens } from './push.service';
import { sweepExpired as sweepExpiredApprovals } from './gate-approval.service';
import { expireOld as expireOldPasses } from './gate-pass.service';
import { expireOld as expireOldTransfers } from './admin-transfer.service';
import { generateInvoicesForSociety } from './invoicing.service';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import FinanceNotificationService from './finance-notification.service';

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
  
  // Finance: daily invoice generation honoring each society's configured
  // generation day (FinancePolicy.billing.generationDay), replacing the old
  // hardcoded 1st-of-month bill run.
  cron.schedule('30 0 * * *', async () => {
    const day = new Date().getDate();
    logger.info(`[cron] Invoice generation check for day ${day}`);
    try {
      const policies = await FinancePolicy.find({ 'billing.autoGenerateEnabled': true, 'billing.generationDay': day }).select('societyId').lean();
      for (const p of policies) {
        try {
          const r = await generateInvoicesForSociety(p.societyId.toString());
          logger.info(`[cron] Society ${p.societyId}: ${r.created} invoice(s) generated for ${r.period} (${r.skipped} skipped)`);
        } catch (e: any) {
          logger.error(`[cron] Invoice gen failed for society ${p.societyId}: ${e.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[cron] Invoice generation job failed: ${err.message}`);
    }
  });

  cron.schedule('0 10 * * *', async () => {
    logger.info('[cron] Running late fee application');
    try {
      const societies = await SocietyFinanceSettings.find({ lateFeeEnabled: true }).lean();
      for (const soc of societies) {
        await SocietyFinanceService.applyLateFeesToSociety(soc.societyId.toString());
      }
    } catch (err: any) {
      logger.error(`[cron] Late fee application failed: ${err.message}`);
    }
  });

  // Finance: daily due-date reminders + funds reconciliation (08:30).
  cron.schedule('30 8 * * *', async () => {
    logger.info('[cron] Running finance reminders + funds reconciliation');
    try {
      const policies = await FinancePolicy.find({ $or: [{ 'reminders.enabled': true }] }).select('societyId reminders').lean();
      const today = startOfDay(new Date());
      for (const p of policies) {
        try {
          for (const n of p.reminders?.beforeDueDays || []) {
            const t = new Date(today); t.setDate(t.getDate() + n);
            await sendDueReminders(p.societyId.toString(), { $gte: t, $lte: endOfDay(t) }, n);
          }
          for (const n of p.reminders?.afterDueDays || []) {
            const t = new Date(today); t.setDate(t.getDate() - n);
            await sendDueReminders(p.societyId.toString(), { $gte: t, $lte: endOfDay(t) }, -n);
          }
        } catch (e: any) { logger.error(`[cron] reminders failed for ${p.societyId}: ${e.message}`); }
      }
      // No fund reconcile pass: balances derive from the ledger on read.
    } catch (err: any) {
      logger.error(`[cron] Finance reminders job failed: ${err.message}`);
    }
  });

  // ------------------------------------------------------------------- gate
  //
  // Runs hourly rather than nightly because each society closes off at its own
  // hour, and a single fixed time would be the middle of the evening for half
  // of them. The job only acts on societies whose chosen hour has just passed.
  cron.schedule('10 * * * *', async () => {
    const hour = new Date().getHours();
    try {
      const policies = await SocietyOpsPolicy.find({
        'gate.exit.trackExit': true,
        'gate.exit.autoCloseAtHour': hour,
      }).select('societyId').lean();

      for (const p of policies) {
        const societyId = String(p.societyId);
        try {
          const closed = await autoCloseStragglers(societyId);
          if (closed > 0) {
            // The morning number the committee can actually act on. Exit
            // tracking has no forcing function, so the only honest fix is to
            // make the gap visible and let management close it.
            const day = await reconcileDay(societyId);
            logger.info(
              `[cron] Society ${societyId}: ${day.entries} entries, ${day.exitsRecorded} exits recorded ` +
              `(${day.accuracy}%), ${day.estimated} closed off automatically`,
            );
          }
        } catch (err: any) {
          logger.error(`[cron] Gate close-off failed for society ${societyId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[cron] Gate close-off sweep failed: ${err.message}`);
    }
  });

  // Retention purge. Under the DPDP Act personal data has to go once its
  // purpose is served, and a visitor's photograph is personal data.
  cron.schedule('40 3 * * *', async () => {
    try {
      const policies = await SocietyOpsPolicy.find({}).select('societyId').lean();
      for (const p of policies) {
        try { await purgeOldEntries(String(p.societyId)); }
        catch (err: any) { logger.error(`[cron] Gate purge failed for society ${p.societyId}: ${err.message}`); }
      }
    } catch (err: any) {
      logger.error(`[cron] Gate purge sweep failed: ${err.message}`);
    }
  });

  /**
   * Approval timeouts, every minute.
   *
   * A minute rather than an hour because the unit here is a person standing at
   * a gate: a request that says "60 seconds" and resolves at the top of the
   * next hour is worse than not having a timeout at all. One indexed query per
   * minute over PENDING rows, which is nothing.
   */
  cron.schedule('* * * * *', async () => {
    try {
      const { resolved } = await sweepExpiredApprovals();
      if (resolved) logger.info(`[cron] ${resolved} gate approvals timed out`);
    } catch (err: any) {
      logger.error(`[cron] Approval sweep failed: ${err.message}`);
    }
  });

  // Notification housekeeping, in the same quiet hour.
  //
  // Two different jobs sharing one slot: old notifications go because they are
  // a nudge and not a record (the complaint and the entry are kept elsewhere),
  // and long-dead devices go because writing to a phone that was uninstalled
  // last spring costs a request every single time somebody is told anything.
  cron.schedule('50 3 * * *', async () => {
    try {
      const policies = await SocietyOpsPolicy.find({}).select('societyId').lean();
      for (const p of policies) {
        try { await purgeOldNotifications(String(p.societyId)); }
        catch (err: any) { logger.error(`[cron] Notification purge failed for society ${p.societyId}: ${err.message}`); }
      }
      const retired = await pruneStaleTokens();
      if (retired) logger.info(`[cron] Retired ${retired} dead push devices`);
      // Not cosmetic: an ACTIVE pass holds its six-digit code against the
      // partial unique index, so leaving spent ones active slowly makes codes
      // harder to allocate.
      const expired = await expireOldPasses();
      if (expired) logger.info(`[cron] Expired ${expired} gate passes`);
      // An admin handover nobody answered must not sit INITIATED forever — it
      // holds the society's one live-transfer slot and blocks a second attempt.
      const lapsed = await expireOldTransfers();
      if (lapsed) logger.info(`[cron] Expired ${lapsed} admin handover invitations`);
    } catch (err: any) {
      logger.error(`[cron] Notification housekeeping failed: ${err.message}`);
    }
  });

  logger.info('[cron] Scheduled daily subscription jobs (09:00), listing expiry (09:05), hourly boost expiry, finance jobs, and gate close-off/purge');
}

/** Email due/overdue reminders for a society's outstanding invoices (deduped per offset per day). */
async function sendDueReminders(societyId: string, dueMatch: any, offsetDays: number): Promise<void> {
  const invoices = await MaintenanceInvoice.find({
    societyId, outstandingPaise: { $gt: 0 }, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
    dueDate: dueMatch, primaryOwnerUserId: { $exists: true },
  }).limit(500);
  const today = startOfDay(new Date()).getTime();
  for (const inv of invoices) {
    if (inv.remindersSent?.some(r => r.offsetDays === offsetDays && startOfDay(new Date(r.sentAt)).getTime() === today)) continue;
    const owner = await User.findById(inv.primaryOwnerUserId).select('email name').lean();
    if (!owner?.email) continue;
    const amt = `₹${(inv.outstandingPaise / 100).toLocaleString('en-IN')}`;
    const when = offsetDays >= 0 ? `is due on ${inv.dueDate.toLocaleDateString('en-IN')}` : `is overdue since ${inv.dueDate.toLocaleDateString('en-IN')}`;
    FinanceNotificationService.sendEmailSafe(owner.email, `Maintenance dues reminder — ${inv.invoiceNumber}`, `<p>Dear ${owner.name || 'Resident'},</p><p>Invoice <b>${inv.invoiceNumber}</b> of <b>${amt}</b> ${when}. Please pay via your ResiSmart resident portal.</p>`);
    inv.remindersSent.push({ sentAt: new Date(), offsetDays, channel: 'EMAIL' });
    await inv.save();
  }
}

export default startCronJobs;
