import mongoose from 'mongoose';
import webpush from 'web-push';
// Modular entry points, not the `admin.*` namespace: this version of
// firebase-admin no longer exports it, and the namespace form fails to compile
// rather than at runtime — which is the good outcome, but only if you use the
// modular form to begin with.
import { initializeApp, getApps, getApp, cert, App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';
import { GlobalSetting } from '../models/global-setting.model';
import { PushToken, IPushToken, PushPlatform } from '../models/push-token.model';

/**
 * Getting a message onto a device.
 *
 * Two transports, one contract, and a rule that runs through all of it: **this
 * file never throws and never blocks anything**. A society whose admin has not
 * set up Firebase must still be able to raise a complaint, open a gate entry
 * and pay a bill. Push is an accelerant, never a dependency — every caller has
 * already written the record before asking us to hurry it along.
 *
 * The other rule is that a dead device gets forgotten. Push tokens rot
 * constantly: an app is uninstalled, a browser clears storage, a subscription
 * expires. Both services tell us so with a specific signal, and we act on it
 * immediately rather than retrying forever against nothing.
 */

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
  kind?: string;
  /** HIGH asks the OS to wake the screen. Reserved for gate and security. */
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
}

export interface PushOutcome {
  attempted: number;
  delivered: number;
  pruned: number;
  /**
   * The same two numbers, broken down by user id.
   *
   * The totals alone are a trap, and one that shipped: `notification.service`
   * asked "was anything attempted?" across the WHOLE recipient list to decide
   * whether to fall back to email. One committee member with a subscribed
   * browser made `attempted` non-zero, so the other four — who own no device at
   * all — got no email either. The stated contract was always per-person; only
   * the arithmetic was per-batch. A per-user breakdown is the only shape that
   * cannot be read the wrong way.
   *
   * A user with no devices is absent from the map, not present with a zero, so
   * callers must treat "missing" as "no device" — see `attemptedFor`.
   */
  attemptedByUser: Record<string, number>;
  deliveredByUser: Record<string, number>;
}

/** How many devices we tried for this person. Missing means none — read it here, never inline. */
export function attemptedFor(outcome: PushOutcome, userId: string): number {
  return outcome.attemptedByUser[String(userId)] || 0;
}

// --------------------------------------------------------------------- VAPID

let vapidReady: { publicKey: string; privateKey: string } | null = null;
let vapidPending: Promise<{ publicKey: string; privateKey: string } | null> | null = null;

/**
 * The signing pair for browser push, resolved once per process.
 *
 * Order matters: environment first, so an operator can pin keys across a
 * rebuilt database; then whatever was generated earlier and stored; then a
 * fresh pair, written back before it is used. Concurrent callers share one
 * promise so a busy boot cannot generate two pairs and have the second quietly
 * invalidate the first.
 */
export async function resolveVapid(): Promise<{ publicKey: string; privateKey: string } | null> {
  if (vapidReady) return vapidReady;
  if (vapidPending) return vapidPending;

  vapidPending = (async () => {
    try {
      if (appConfig.vapidPublicKey && appConfig.vapidPrivateKey) {
        vapidReady = { publicKey: appConfig.vapidPublicKey, privateKey: appConfig.vapidPrivateKey };
      } else {
        const stored = await GlobalSetting.findOne({
          vapidPublicKey: { $exists: true, $ne: '' },
          vapidPrivateKey: { $exists: true, $ne: '' },
        }).lean();

        if (stored?.vapidPublicKey && stored?.vapidPrivateKey) {
          vapidReady = { publicKey: stored.vapidPublicKey, privateKey: stored.vapidPrivateKey };
        } else {
          const generated = webpush.generateVAPIDKeys();
          // upsert on the singleton: findOneAndUpdate with no filter takes the
          // one row that exists, and creates it on a virgin install.
          await GlobalSetting.findOneAndUpdate(
            {},
            { $set: { vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          // Read back rather than trusting the write: if two processes raced,
          // whichever landed second must adopt the winner's pair, or half the
          // subscriptions in the wild get signed with a key nobody stored.
          const settled = await GlobalSetting.findOne({}).lean();
          vapidReady = {
            publicKey: settled?.vapidPublicKey || generated.publicKey,
            privateKey: settled?.vapidPrivateKey || generated.privateKey,
          };
          logger.info('Web push: generated a VAPID key pair and stored it.');
        }
      }

      webpush.setVapidDetails(appConfig.vapidSubject, vapidReady.publicKey, vapidReady.privateKey);
      return vapidReady;
    } catch (e: any) {
      logger.error(`Web push unavailable: ${e.message}`);
      return null;
    } finally {
      vapidPending = null;
    }
  })();

  return vapidPending;
}

/** The key a browser needs to subscribe. Null when web push could not be set up at all. */
export async function publicVapidKey(): Promise<string | null> {
  const keys = await resolveVapid();
  return keys?.publicKey || null;
}

// ------------------------------------------------------------------ Firebase

let fcmApp: App | null = null;
let fcmChecked = false;

/**
 * The Firebase app, or null when no credentials are configured.
 *
 * Absence is the expected state today and is NOT logged as an error — the
 * project ships without keys by design. It is resolved once and remembered,
 * including the null, so a missing configuration costs nothing per send.
 */
function fcm(): App | null {
  if (fcmChecked) return fcmApp;
  fcmChecked = true;

  const { firebaseProjectId, firebaseClientEmail, firebasePrivateKey } = appConfig;
  if (!firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey) return null;

  try {
    fcmApp = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({
            projectId: firebaseProjectId,
            clientEmail: firebaseClientEmail,
            privateKey: firebasePrivateKey,
          }),
        });
    logger.info('Firebase messaging is configured.');
  } catch (e: any) {
    // Bad keys, not missing keys — worth saying out loud, still not fatal.
    logger.error(`Firebase credentials were rejected, mobile push is off: ${e.message}`);
    fcmApp = null;
  }
  return fcmApp;
}

/** Whether mobile push can currently go anywhere. Used by the health surface, not by senders. */
export function isFirebaseConfigured(): boolean {
  return fcm() !== null;
}

// ------------------------------------------------------------ registration

export async function registerToken(input: {
  societyId: string;
  userId: string;
  platform: PushPlatform;
  token: string;
  keys?: { p256dh: string; auth: string };
  deviceLabel?: string;
}): Promise<IPushToken> {
  // Upsert on the token alone. The same browser re-subscribing, or a phone
  // handed to a new resident, must MOVE to the current owner rather than
  // creating a second row that keeps notifying the previous one.
  const doc = await PushToken.findOneAndUpdate(
    { token: input.token },
    {
      $set: {
        societyId: new mongoose.Types.ObjectId(input.societyId),
        userId: new mongoose.Types.ObjectId(input.userId),
        platform: input.platform,
        keys: input.keys,
        deviceLabel: input.deviceLabel,
        lastSeenAt: new Date(),
        failureCount: 0,
        updatedBy: new mongoose.Types.ObjectId(input.userId),
      },
      $setOnInsert: { createdBy: new mongoose.Types.ObjectId(input.userId) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc!;
}

/**
 * Forget a device — but only your own.
 *
 * The `userId` clause is the whole point. Without it the filter was `{ token }`
 * alone, so anybody who learned another person's registration token or web-push
 * endpoint could silently unsubscribe them: a targeted, permanent way to stop
 * somebody receiving the one HIGH-priority alert this system exists for, with
 * nothing on their screen to say it had happened.
 *
 * Kept as a required argument rather than an optional one so a caller cannot
 * omit it and quietly restore the old behaviour. The internal prune path is
 * `pruneStaleTokens`, which is a different function for a different reason.
 */
export async function forgetToken(token: string, userId: string): Promise<boolean> {
  const res = await PushToken.deleteOne({
    token,
    userId: new mongoose.Types.ObjectId(String(userId)),
  });
  return res.deletedCount > 0;
}

// -------------------------------------------------------------------- send

/** A push service saying "this device is gone" — the only signal we prune on. */
function isGone(err: any): boolean {
  const status = err?.statusCode ?? err?.status;
  if (status === 404 || status === 410) return true;                       // web push
  const code = err?.errorInfo?.code || err?.code || '';
  return code === 'messaging/registration-token-not-registered'            // FCM
      || code === 'messaging/invalid-registration-token'
      || code === 'messaging/invalid-argument';
}

async function sendWeb(row: IPushToken, payload: PushPayload): Promise<boolean> {
  const keys = await resolveVapid();
  if (!keys || !row.keys) return false;

  await webpush.sendNotification(
    { endpoint: row.token, keys: { p256dh: row.keys.p256dh, auth: row.keys.auth } },
    JSON.stringify({
      title: payload.title,
      body: payload.body,
      link: payload.link,
      kind: payload.kind,
    }),
    { TTL: payload.priority === 'HIGH' ? 300 : 3600, urgency: payload.priority === 'HIGH' ? 'high' : 'normal' },
  );
  return true;
}

async function sendMobile(row: IPushToken, payload: PushPayload): Promise<boolean> {
  const app = fcm();
  if (!app) return false;

  await getMessaging(app).send({
    token: row.token,
    notification: { title: payload.title, body: payload.body },
    // Every value must be a string — FCM rejects the message otherwise, and
    // the error is thrown at send time rather than compile time.
    data: {
      link: payload.link || '',
      kind: payload.kind || '',
    },
    android: { priority: payload.priority === 'HIGH' ? 'high' : 'normal' },
    apns: { payload: { aps: { sound: payload.priority === 'HIGH' ? 'default' : undefined } } },
  });
  return true;
}

/**
 * Push one payload to every device belonging to these users.
 *
 * Never throws. Sends run concurrently because a slow or unreachable push
 * service must not hold up the ones that are healthy, and the caller is
 * usually inside a request that has already done its real work.
 */
export async function pushToUsers(
  societyId: string,
  userIds: string[],
  payload: PushPayload,
): Promise<PushOutcome> {
  const out: PushOutcome = {
    attempted: 0, delivered: 0, pruned: 0,
    attemptedByUser: {}, deliveredByUser: {},
  };
  if (!userIds.length) return out;

  let rows: IPushToken[] = [];
  try {
    rows = await PushToken.find({
      societyId: new mongoose.Types.ObjectId(societyId),
      userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
    });
  } catch (e: any) {
    logger.error(`Could not read push tokens: ${e.message}`);
    return out;
  }
  if (!rows.length) return out;

  out.attempted = rows.length;
  // Counted from the rows themselves rather than from the requested ids: a
  // person with no device must be ABSENT from this map, which is what tells the
  // caller they are unreachable by push and need the email rung.
  for (const row of rows) {
    const uid = String(row.userId);
    out.attemptedByUser[uid] = (out.attemptedByUser[uid] || 0) + 1;
  }
  const dead: string[] = [];

  await Promise.all(rows.map(async row => {
    try {
      const sent = row.platform === 'WEB' ? await sendWeb(row, payload) : await sendMobile(row, payload);
      if (sent) {
        out.delivered++;
        const uid = String(row.userId);
        out.deliveredByUser[uid] = (out.deliveredByUser[uid] || 0) + 1;
        // Not awaited: bookkeeping must not slow the fan-out, and losing a
        // lastSeenAt bump costs nothing.
        PushToken.updateOne({ _id: row._id }, { $set: { lastSeenAt: new Date(), failureCount: 0 } }).catch(() => {});
      }
    } catch (e: any) {
      if (isGone(e)) {
        dead.push(String(row._id));
      } else {
        // A transient failure. Count it, and let the nightly sweep retire
        // devices that never recover — pruning on one bad night would delete
        // working phones every time the push service has an outage.
        PushToken.updateOne({ _id: row._id }, { $inc: { failureCount: 1 } }).catch(() => {});
        logger.warn(`Push to ${row.platform} device failed: ${e.message}`);
      }
    }
  }));

  if (dead.length) {
    try {
      const res = await PushToken.deleteMany({ _id: { $in: dead } });
      out.pruned = res.deletedCount || 0;
    } catch { /* the sweep will get them */ }
  }

  return out;
}

/**
 * Retire devices that have failed repeatedly and not been heard from.
 *
 * Both conditions together, deliberately: failureCount alone would delete a
 * phone that was merely off for a fortnight, and staleness alone would delete
 * a working device belonging to somebody who reads everything in the app.
 */
export async function pruneStaleTokens(olderThanDays = 60, minFailures = 10): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await PushToken.deleteMany({
    failureCount: { $gte: minFailures },
    lastSeenAt: { $lt: cutoff },
  });
  return res.deletedCount || 0;
}
