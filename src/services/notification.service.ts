import mongoose from 'mongoose';
import { logger } from '../utils/logger.util';
import { Notification, INotification, NotificationChannel } from '../models/notification.model';
import { NotificationPreference, INotificationPreference } from '../models/notification-preference.model';
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
 *   0. **Ask the person what they want.** Resolved here, once, for the whole
 *      audience — never at a call site. A mute that each caller has to remember
 *      to honour is a mute that the next module forgets, and the resident finds
 *      out by being woken up. `notify` is the only place that knows who is
 *      being told, so it is the only place that can decide who is not.
 *   1. **Write the record.** Always, first, before any delivery is attempted.
 *      Everything below can fail; this cannot be allowed to. A notification
 *      that was never written is a notification nobody can find tomorrow.
 *   2. **SSE**, for whoever has a screen open right now. Instant and free.
 *   3. **Push**, to their devices. Fire-and-forget — see push.service.
 *   4. **Email**, and ONLY when THAT PERSON has no device registered at all.
 *      Emailing somebody who already got a push is how a product teaches its
 *      users to filter it, and once they have, the one message that mattered
 *      is filtered too.
 *
 * Rung 4 is per-person and the emphasis is the fix. It used to ask whether the
 * BATCH had attempted any push at all, so one committee member with a
 * subscribed browser suppressed the email for the other four, who owned no
 * device and therefore got nothing anywhere.
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
  /**
   * A stable name for the EVENT, so the same event told twice is told once.
   *
   * Shape it after the thing that happened, not after this call:
   * `complaint:<id>:closed`, not `complaint-closed-<timestamp>`. A key that
   * changes every call dedupes nothing. Scoped per recipient by the index, so
   * one key is correct for a whole audience.
   *
   * Leave it unset when there is no natural event identity — a broadcast
   * notice must still be sendable twice.
   */
  dedupeKey?: string;
}

export interface NotifyResult {
  created: number;
  live: number;
  pushed: number;
  emailed: number;
  /** Recipients who wanted nothing: a muted kind, or in-app switched off. */
  suppressed: number;
  /** Recipients inside their quiet hours — the record exists, the noise waits. */
  held: number;
  /** Recipients already told about this exact event under the same dedupeKey. */
  duplicates: number;
}

const NOOP: NotifyResult = {
  created: 0, live: 0, pushed: 0, emailed: 0, suppressed: 0, held: 0, duplicates: 0,
};

// ------------------------------------------------------------- preferences

/** What somebody who has never opened the preferences screen gets: everything. */
const DEFAULT_PREFERENCE = {
  mutedKinds: [] as string[],
  channels: { inApp: true, push: true, email: true },
  quietHours: undefined as { fromMinute: number; toMinute: number } | undefined,
  timezone: 'Asia/Kolkata',
};

export type EffectivePreference = typeof DEFAULT_PREFERENCE;

const shape = (row: INotificationPreference | null | undefined): EffectivePreference => ({
  mutedKinds: row?.mutedKinds || [],
  channels: {
    // `?? true` and not `||`: a stored `false` is the whole point of the row,
    // and `||` would quietly turn every opt-out back on.
    inApp: row?.channels?.inApp ?? true,
    push: row?.channels?.push ?? true,
    email: row?.channels?.email ?? true,
  },
  quietHours: row?.quietHours
    ? { fromMinute: row.quietHours.fromMinute, toMinute: row.quietHours.toMinute }
    : undefined,
  timezone: row?.timezone || DEFAULT_PREFERENCE.timezone,
});

/**
 * One person's effective preference, defaults filled in.
 *
 * Read by the preferences screen. `notify` uses the bulk form below — one
 * query for the whole audience, because a committee fan-out with a lookup per
 * recipient turns a 30-person notice into 30 round trips on the request path.
 */
export async function getPreference(societyId: string, userId: string): Promise<EffectivePreference> {
  const row = await NotificationPreference.findOne({
    societyId: new mongoose.Types.ObjectId(societyId),
    userId: new mongoose.Types.ObjectId(userId),
  });
  return shape(row);
}

async function preferencesFor(
  societyId: string, userIds: string[],
): Promise<Map<string, EffectivePreference>> {
  const map = new Map<string, EffectivePreference>();
  try {
    const rows = await NotificationPreference.find({
      societyId: new mongoose.Types.ObjectId(societyId),
      userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
    });
    for (const row of rows) map.set(String(row.userId), shape(row));
  } catch (e: any) {
    // Fail OPEN, and only here. A preference we could not read must not silence
    // somebody — the failure mode of a lost gate approval is far worse than the
    // failure mode of one unwanted notification. (`attachAccess` fails open too
    // and it is a bug there, because there the open direction WIDENS access.
    // Here the open direction only makes us noisier.)
    logger.error(`Notification preferences unreadable, sending to everyone: ${e.message}`);
  }
  // Everyone not in the map keeps the defaults.
  for (const id of userIds) if (!map.has(id)) map.set(id, { ...DEFAULT_PREFERENCE });
  return map;
}

export interface SavePreferenceInput {
  mutedKinds?: string[];
  channels?: Partial<{ inApp: boolean; push: boolean; email: boolean }>;
  /** Explicit null clears the window — distinct from "not mentioned". */
  quietHours?: { fromMinute: number; toMinute: number } | null;
  timezone?: string;
}

export async function savePreference(
  societyId: string, userId: string, input: SavePreferenceInput,
): Promise<EffectivePreference> {
  const sid = new mongoose.Types.ObjectId(societyId);
  const uid = new mongoose.Types.ObjectId(userId);

  const set: Record<string, unknown> = { updatedBy: uid };
  const unset: Record<string, unknown> = {};

  if (input.mutedKinds) {
    // De-duplicated and trimmed here rather than trusting the client: the list
    // is matched with `includes`, and ' GATE_ENTRY' would match nothing while
    // looking, on the screen, exactly like a working mute.
    set.mutedKinds = [...new Set(input.mutedKinds.map(k => String(k).trim()).filter(Boolean))];
  }
  if (input.channels) {
    for (const key of ['inApp', 'push', 'email'] as const) {
      if (typeof input.channels[key] === 'boolean') set[`channels.${key}`] = input.channels[key];
    }
  }
  if (input.quietHours === null) unset.quietHours = '';
  else if (input.quietHours) set.quietHours = input.quietHours;
  if (input.timezone) set.timezone = input.timezone;

  const row = await NotificationPreference.findOneAndUpdate(
    { societyId: sid, userId: uid },
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $setOnInsert: { societyId: sid, userId: uid, createdBy: uid },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return shape(row);
}

// ------------------------------------------------------------ quiet hours

/**
 * Wall-clock minutes past midnight, in the person's own zone.
 *
 * Via `Intl` rather than `getHours()` deliberately. `getHours()` reads the
 * PROCESS timezone, which is a deployment fact — the same resident's 22:00
 * would mean one thing on the Mumbai box and another in a UTC container, and
 * nothing would look broken until somebody was woken at half past three.
 */
export function localMinutes(at: Date, timezone: string): number {
  let zone = timezone || DEFAULT_PREFERENCE.timezone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    // A zone name that Node does not know (a typo, an old tzdata) must not
    // throw inside notify and lose the message. Fall back rather than fail.
    zone = DEFAULT_PREFERENCE.timezone;
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  }
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

/**
 * When the quiet window this moment falls inside ends — or null if it does not.
 *
 * `from > to` wraps midnight (22:00 → 07:00) and that is the ordinary case,
 * which is why this cannot be `m >= from && m < to`. `from === to` is treated
 * as no window at all: a zero-width range read as "always quiet" would silence
 * a resident permanently on one mis-tap.
 */
export function quietUntil(
  at: Date,
  quietHours: { fromMinute: number; toMinute: number } | undefined,
  timezone: string,
): Date | null {
  if (!quietHours) return null;
  const { fromMinute: from, toMinute: to } = quietHours;
  if (from === to) return null;

  const now = localMinutes(at, timezone);
  const inside = from < to ? (now >= from && now < to) : (now >= from || now < to);
  if (!inside) return null;

  // Minutes left until the window closes, walking forwards through midnight.
  const remaining = ((to - now) + 1440) % 1440 || 1440;
  return new Date(at.getTime() + remaining * 60_000);
}

// ---------------------------------------------------------------- sending

/** What one recipient is owed, after their own preferences have had their say. */
interface Plan {
  userId: string;
  push: boolean;
  email: boolean;
  heldUntil?: Date;
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  try {
    // De-duplicate: the same person can easily be both "the flat" and "the
    // committee member on duty", and telling them twice reads as a bug.
    const userIds = [...new Set(input.userIds.map(String))].filter(Boolean);
    if (!userIds.length) return { ...NOOP };

    const priority = input.priority || 'NORMAL';
    const societyOid = new mongoose.Types.ObjectId(input.societyId);
    const now = new Date();
    const result: NotifyResult = { ...NOOP };

    // ------------------------------------------------ 0a. already told them?
    let candidates = userIds;
    if (input.dedupeKey) {
      const already = await Notification.find(
        { societyId: societyOid, userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) }, dedupeKey: input.dedupeKey },
        { userId: 1 },
      ).lean();
      const told = new Set(already.map(d => String(d.userId)));
      candidates = userIds.filter(id => !told.has(id));
      result.duplicates = userIds.length - candidates.length;
      if (!candidates.length) return result;
    }

    // -------------------------------------------------- 0b. what they want
    const prefs = await preferencesFor(input.societyId, candidates);
    const plans: Plan[] = [];

    for (const userId of candidates) {
      const pref = prefs.get(userId)!;

      // HIGH is the override, and it is the reason `priority` exists at all.
      // Somebody is at the gate; a security event is live. A resident may make
      // the product quieter, never make themselves unreachable for this.
      const ringsThrough = priority === 'HIGH';

      if (!ringsThrough && pref.mutedKinds.includes(input.kind)) { result.suppressed++; continue; }
      // In-app off means no row. Writing one anyway and still calling the
      // switch "in-app" is the dead-policy shape §I-E exists to stamp out.
      if (!ringsThrough && !pref.channels.inApp) { result.suppressed++; continue; }

      // Quiet hours HOLD the noisy transports; they never drop the record, so
      // eight hours of sleep never costs somebody a bill they had to see.
      const held = ringsThrough ? null : quietUntil(now, pref.quietHours, pref.timezone);
      if (held) result.held++;

      plans.push({
        userId,
        // A channel opt-out is honoured even for HIGH. It is not a wish to be
        // quieter, it is "this transport does not work for me" — pushing to a
        // browser the resident deliberately unsubscribed reaches nobody anyway,
        // and the in-app record plus SSE still carry the urgent message.
        push: pref.channels.push,
        email: pref.channels.email,
        heldUntil: held || undefined,
      });
    }

    if (!plans.length) return result;

    // ---------------------------------------------------------- 1. record
    const docs = await insertRecords(societyOid, plans, input, priority);
    result.created = docs.length;
    if (!docs.length) return result;

    const planOf = new Map(plans.map(p => [p.userId, p]));

    // ------------------------------------------------------------- 2. SSE
    // One frame per recipient, because each carries that person's own row id —
    // the client marks it read by id, and a shared frame could not.
    //
    // Sent during quiet hours too: SSE only reaches a screen that is already
    // open and being looked at, so it disturbs nobody who is asleep.
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
    const pushable = docs
      .map(d => String(d.userId))
      .filter(uid => planOf.get(uid)?.push && !planOf.get(uid)?.heldUntil);

    const outcome = pushable.length
      ? await push.pushToUsers(input.societyId, pushable, {
          title: input.title, body: input.body, link: input.link, kind: input.kind, priority,
        })
      : { attempted: 0, delivered: 0, pruned: 0, attemptedByUser: {}, deliveredByUser: {} };
    result.pushed = outcome.delivered;

    // ----------------------------------------------------------- 4. email
    // PER PERSON. Somebody with no device of their own is unreachable by push
    // no matter how many devices their neighbours on the same notice own.
    const emailTo = input.emailIfUnreachable
      ? docs.map(d => String(d.userId)).filter(uid => {
          const plan = planOf.get(uid);
          return plan?.email && !plan.heldUntil && push.attemptedFor(outcome, uid) === 0;
        })
      : [];
    if (emailTo.length) result.emailed = await emailFallback(emailTo, input);

    // --------------------------------------------- 5. record what happened
    await recordDelivery(docs, planOf, outcome, new Set(emailTo));

    return result;
  } catch (e: any) {
    // The caller's real work is already done and committed. Losing the
    // notification is bad; undoing their complaint or gate entry is worse.
    logger.error(`notify(${input.kind}) failed: ${e.message}`);
    return { ...NOOP };
  }
}

/**
 * Write the rows.
 *
 * `ordered: false` plus a swallow of the duplicate-key error is the second
 * half of the dedupe guarantee: the read above catches the ordinary case, and
 * the unique partial index catches the race between two processes reacting to
 * one event. Mongo still inserts every non-clashing document in that batch, so
 * the survivors are read back rather than taken from the throw.
 */
async function insertRecords(
  societyOid: mongoose.Types.ObjectId,
  plans: Plan[],
  input: NotifyInput,
  priority: 'LOW' | 'NORMAL' | 'HIGH',
): Promise<INotification[]> {
  const payload = plans.map(p => ({
    societyId: societyOid,
    userId: new mongoose.Types.ObjectId(p.userId),
    kind: input.kind,
    title: input.title,
    body: input.body,
    link: input.link,
    entityType: input.entityType,
    entityId: input.entityId ? new mongoose.Types.ObjectId(input.entityId) : undefined,
    priority,
    deliveredVia: ['IN_APP'] as NotificationChannel[],
    dedupeKey: input.dedupeKey,
    heldUntil: p.heldUntil,
    // Only meaningful on a held row, and only when the caller wanted an email
    // and this person accepts them. Remembered here so the release sweep can
    // finish the job — otherwise quiet hours would silently downgrade the
    // message instead of delaying it.
    emailOnRelease: p.heldUntil && input.emailIfUnreachable && p.email ? true : undefined,
  }));

  try {
    return await Notification.insertMany(payload, { ordered: false }) as unknown as INotification[];
  } catch (e: any) {
    if (e?.code !== 11000 && !e?.writeErrors) throw e;
    // `insertedDocs` is what actually landed. Anything missing lost the race to
    // another process writing the same event — which is the correct outcome.
    const landed = (e.insertedDocs || []) as INotification[];
    logger.warn(`notify(${input.kind}): ${payload.length - landed.length} duplicate row(s) skipped`);
    return landed;
  }
}

/**
 * Stamp each row with the transports that actually took it.
 *
 * Per row, not per batch: two people on the same notice genuinely have
 * different answers, and one shared `deliveredVia` is how "why didn't I get
 * it?" became unanswerable. `pushFailedAt` is set only where a device existed
 * and refused — that, and only that, is worth another attempt.
 */
async function recordDelivery(
  docs: INotification[],
  planOf: Map<string, Plan>,
  outcome: push.PushOutcome,
  emailed: Set<string>,
): Promise<void> {
  const ops = docs.map(doc => {
    const uid = String(doc.userId);
    const via: NotificationChannel[] = ['IN_APP'];
    const attempted = push.attemptedFor(outcome, uid);
    const delivered = outcome.deliveredByUser[uid] || 0;
    if (delivered) via.push('PUSH');
    if (emailed.has(uid)) via.push('EMAIL');

    const set: Record<string, unknown> = { deliveredVia: via };
    if (planOf.get(uid)?.push && attempted > 0 && delivered === 0) {
      set.pushFailedAt = new Date();
    }
    return { updateOne: { filter: { _id: doc._id }, update: { $set: set } } };
  });
  if (ops.length) await Notification.bulkWrite(ops, { ordered: false }).catch(() => undefined);
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

// -------------------------------------------------------------- the sweeps

/** Give up after this many tries. Beyond it the device is not flaky, it is gone. */
const MAX_PUSH_ATTEMPTS = 3;
/** Nothing older than this is worth ringing about; the person has moved on. */
const RETRY_WINDOW_HOURS = 6;

/**
 * Deliver what quiet hours held back.
 *
 * Run from the cron. Push and email only — the record and the SSE frame went
 * out at write time, so there is nothing to un-hold in the notification centre.
 * The email is sent here rather than at write time so a night's silence delays
 * it instead of cancelling it.
 * Rows are cleared as they are handled whether or not the send worked, because
 * a held message that keeps failing should fall through to the retry sweep
 * rather than sitting in the hold queue forever.
 */
export async function releaseHeld(now = new Date(), limit = 500): Promise<number> {
  const due = await Notification.find({ heldUntil: { $lte: now } })
    .sort({ heldUntil: 1 }).limit(limit);
  if (!due.length) return 0;

  for (const doc of due) {
    try {
      const uid = String(doc.userId);
      const outcome = await push.pushToUsers(String(doc.societyId), [uid], {
        title: doc.title, body: doc.body, link: doc.link, kind: doc.kind, priority: doc.priority,
      });
      const via = new Set<NotificationChannel>(doc.deliveredVia || ['IN_APP']);
      if (outcome.deliveredByUser[uid]) via.add('PUSH');

      // Same per-person rule as rung 4 in `notify`: an email only where THIS
      // person owns no device, never as a second copy of a push they just got.
      if (doc.emailOnRelease && push.attemptedFor(outcome, uid) === 0) {
        const sent = await emailFallback([uid], {
          societyId: String(doc.societyId), userIds: [uid],
          kind: doc.kind, title: doc.title, body: doc.body, link: doc.link,
        });
        if (sent) via.add('EMAIL');
      }

      await Notification.updateOne(
        { _id: doc._id },
        {
          $set: { deliveredVia: [...via] },
          $unset: { heldUntil: '', emailOnRelease: '' },
          ...(push.attemptedFor(outcome, uid) > 0 && !outcome.deliveredByUser[uid]
            ? { $currentDate: { pushFailedAt: true } } : {}),
        },
      );
    } catch (e: any) {
      logger.error(`Releasing a held notification failed: ${e.message}`);
      // Clear the hold regardless. Leaving it set means the same row is picked
      // up on every tick forever and the queue never drains.
      await Notification.updateOne({ _id: doc._id }, { $unset: { heldUntil: '' } }).catch(() => undefined);
    }
  }
  return due.length;
}

/**
 * Try the failed pushes again.
 *
 * The gap this closes: a push that failed for a transient reason was simply
 * lost. `pushToUsers` bumped a counter on the DEVICE and moved on, so one bad
 * minute at the push service meant the gate approval was never re-offered and
 * nothing anywhere said so.
 *
 * A marker field and a sweep, exactly like `Asset.amcWarnedForExpiry` and
 * `VisitorEntry.overstayNotifiedAt` — not a queue. A queue would be a second
 * source of truth about what has been sent, and the two would drift.
 */
export async function retryFailedPushes(now = new Date(), limit = 200): Promise<number> {
  const floor = new Date(now.getTime() - RETRY_WINDOW_HOURS * 60 * 60 * 1000);
  const due = await Notification.find({
    pushFailedAt: { $exists: true, $lte: now },
    pushAttempts: { $lt: MAX_PUSH_ATTEMPTS },
    createdAt: { $gte: floor },
    // Somebody who has already read it in the app does not need their phone to
    // buzz about it now.
    readAt: { $exists: false },
  }).sort({ pushFailedAt: 1 }).limit(limit);

  let recovered = 0;
  for (const doc of due) {
    try {
      const uid = String(doc.userId);
      const outcome = await push.pushToUsers(String(doc.societyId), [uid], {
        title: doc.title, body: doc.body, link: doc.link, kind: doc.kind, priority: doc.priority,
      });
      if (outcome.deliveredByUser[uid]) {
        recovered++;
        const via = new Set<NotificationChannel>(doc.deliveredVia || ['IN_APP']);
        via.add('PUSH');
        await Notification.updateOne(
          { _id: doc._id },
          { $set: { deliveredVia: [...via] }, $unset: { pushFailedAt: '' }, $inc: { pushAttempts: 1 } },
        );
      } else {
        await Notification.updateOne(
          { _id: doc._id },
          { $inc: { pushAttempts: 1 }, $currentDate: { pushFailedAt: true } },
        );
      }
    } catch (e: any) {
      logger.error(`Push retry failed: ${e.message}`);
      await Notification.updateOne({ _id: doc._id }, { $inc: { pushAttempts: 1 } }).catch(() => undefined);
    }
  }
  return recovered;
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
 * The kinds this person has actually been sent, so the preferences screen can
 * offer real switches instead of a hardcoded list that drifts out of date as
 * modules are added.
 *
 * Muted kinds are unioned in: once a kind is silenced it stops appearing in
 * the history, and a switch that disappears the moment you use it cannot be
 * turned back on.
 */
export async function kindsForUser(societyId: string, userId: string): Promise<string[]> {
  const sid = new mongoose.Types.ObjectId(societyId);
  const uid = new mongoose.Types.ObjectId(userId);
  const [seen, pref] = await Promise.all([
    Notification.distinct('kind', { societyId: sid, userId: uid }),
    NotificationPreference.findOne({ societyId: sid, userId: uid }, { mutedKinds: 1 }).lean(),
  ]);
  return [...new Set([...(seen as string[]), ...(pref?.mutedKinds || [])])].sort();
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
