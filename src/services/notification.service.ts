import mongoose from 'mongoose';
import { logger } from '../utils/logger.util';
import { Notification, INotification, NotificationChannel } from '../models/notification.model';
import { User } from '../models/user.model';
import EmailService from './email.service';
import { appConfig } from '../config/appConfig';
import * as push from './push.service';
import * as sse from './sse.service';

/**
 * The one door every notification goes through.
 *
 * The ladder, in order, and the reasoning for that order:
 *
 *   1. **Write the record.** Always, first, before any delivery is attempted.
 *      Everything below can fail; this cannot be allowed to. A notification
 *      that was never written is a notification nobody can find tomorrow.
 *   2. **SSE**, for whoever has a screen open right now. Instant and free.
 *   3. **Push**, to their devices. Fire-and-forget — see push.service.
 *   4. **Email**, and ONLY when the person has no device registered at all.
 *      Emailing somebody who already got a push is how a product teaches its
 *      users to filter it, and once they have, the one message that mattered
 *      is filtered too.
 *
 * `notify` never throws. A complaint must be raiseable when the mail relay is
 * down, and a gate entry must record when Firebase is misconfigured.
 */

export interface NotifyInput {
  societyId: string;
  userIds: string[];
  kind: string;
  title: string;
  body: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
  /**
   * Send an email to anyone with no registered device.
   *
   * Off by default, deliberately. Most notifications are worth a badge and not
   * an inbox; the caller opts in for the ones that genuinely are — a bill
   * raised, an approval waiting, a complaint breaching its promise.
   */
  emailIfUnreachable?: boolean;
}

export interface NotifyResult {
  created: number;
  live: number;
  pushed: number;
  emailed: number;
}

const NOOP: NotifyResult = { created: 0, live: 0, pushed: 0, emailed: 0 };

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  try {
    // De-duplicate: the same person can easily be both "the flat" and "the
    // committee member on duty", and telling them twice reads as a bug.
    const userIds = [...new Set(input.userIds.map(String))].filter(Boolean);
    if (!userIds.length) return { ...NOOP };

    const priority = input.priority || 'NORMAL';
    const societyOid = new mongoose.Types.ObjectId(input.societyId);

    // ---------------------------------------------------------- 1. record
    const docs = await Notification.insertMany(
      userIds.map(uid => ({
        societyId: societyOid,
        userId: new mongoose.Types.ObjectId(uid),
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link,
        entityType: input.entityType,
        entityId: input.entityId ? new mongoose.Types.ObjectId(input.entityId) : undefined,
        priority,
        deliveredVia: ['IN_APP'] as NotificationChannel[],
      })),
      { ordered: false },
    );

    const result: NotifyResult = { created: docs.length, live: 0, pushed: 0, emailed: 0 };

    // ------------------------------------------------------------- 2. SSE
    // One frame per recipient, because each carries that person's own row id —
    // the client marks it read by id, and a shared frame could not.
    for (const doc of docs) {
      result.live += sse.publish(input.societyId, [String(doc.userId)], 'notification', {
        _id: String(doc._id),
        kind: doc.kind,
        title: doc.title,
        body: doc.body,
        link: doc.link,
        priority: doc.priority,
        createdAt: doc.createdAt,
      });
    }

    // ------------------------------------------------------------ 3. push
    const outcome = await push.pushToUsers(input.societyId, userIds, {
      title: input.title,
      body: input.body,
      link: input.link,
      kind: input.kind,
      priority,
    });
    result.pushed = outcome.delivered;

    // ----------------------------------------------------------- 4. email
    if (input.emailIfUnreachable && outcome.attempted === 0) {
      result.emailed = await emailFallback(userIds, input);
    }

    if (result.pushed || result.emailed) {
      // Record what actually happened, so "why didn't I get it?" is answerable
      // from the row rather than from log archaeology.
      const via: NotificationChannel[] = ['IN_APP'];
      if (result.pushed) via.push('PUSH');
      if (result.emailed) via.push('EMAIL');
      await Notification.updateMany(
        { _id: { $in: docs.map(d => d._id) } },
        { $set: { deliveredVia: via } },
      );
    }

    return result;
  } catch (e: any) {
    // The caller's real work is already done and committed. Losing the
    // notification is bad; undoing their complaint or gate entry is worse.
    logger.error(`notify(${input.kind}) failed: ${e.message}`);
    return { ...NOOP };
  }
}

async function emailFallback(userIds: string[], input: NotifyInput): Promise<number> {
  try {
    const users = await User.find(
      { _id: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) }, email: { $exists: true, $ne: '' } },
      { name: 1, email: 1 },
    ).lean();

    const link = input.link ? `${appConfig.frontendUrl}${input.link}` : appConfig.frontendUrl;
    for (const u of users) {
      if (!u.email) continue;
      EmailService.sendEmail({
        to: u.email,
        subject: input.title,
        html: `
          <p>Dear ${u.name || 'Resident'},</p>
          <p>${input.body}</p>
          <p><a href="${link}">Open in ResiSmart</a></p>
          <br><p>Regards,<br>ResiSmart Team</p>
        `,
      });
    }
    return users.length;
  } catch (e: any) {
    logger.error(`Notification email fallback failed: ${e.message}`);
    return 0;
  }
}

// ------------------------------------------------------------ the centre

export async function listForUser(
  societyId: string,
  userId: string,
  opts: { limit?: number; before?: Date; unreadOnly?: boolean } = {},
): Promise<{ items: INotification[]; unread: number }> {
  const filter: Record<string, unknown> = {
    societyId: new mongoose.Types.ObjectId(societyId),
    userId: new mongoose.Types.ObjectId(userId),
  };
  if (opts.unreadOnly) filter.readAt = { $exists: false };
  if (opts.before) filter.createdAt = { $lt: opts.before };

  const limit = Math.min(Math.max(opts.limit || 30, 1), 100);
  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean() as any,
    Notification.countDocuments({
      societyId: new mongoose.Types.ObjectId(societyId),
      userId: new mongoose.Types.ObjectId(userId),
      readAt: { $exists: false },
    }),
  ]);
  return { items, unread };
}

/**
 * Mark some or all as read.
 *
 * Scoped to the caller's own rows by construction — userId is part of the
 * filter, never taken from the body — so a crafted list of ids cannot mark
 * somebody else's notifications read.
 */
export async function markRead(societyId: string, userId: string, ids?: string[]): Promise<number> {
  const filter: Record<string, unknown> = {
    societyId: new mongoose.Types.ObjectId(societyId),
    userId: new mongoose.Types.ObjectId(userId),
    readAt: { $exists: false },
  };
  if (ids?.length) {
    filter._id = { $in: ids.filter(mongoose.isValidObjectId).map(id => new mongoose.Types.ObjectId(id)) };
  }
  const res = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return res.modifiedCount || 0;
}

/**
 * Retention. A notification is a nudge, not a record of account — the complaint,
 * the entry and the voucher are all kept elsewhere and are the real history.
 */
export async function purgeOld(societyId: string, olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await Notification.deleteMany({
    societyId: new mongoose.Types.ObjectId(societyId),
    createdAt: { $lt: cutoff },
  });
  return res.deletedCount || 0;
}
