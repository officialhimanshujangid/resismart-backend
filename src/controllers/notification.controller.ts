import { Request, Response } from 'express';
import * as notifications from '../services/notification.service';
import * as push from '../services/push.service';
import * as sse from '../services/sse.service';
import { logger } from '../utils/logger.util';

const fail = (res: Response, e: any, what: string) => {
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

const ctx = (req: Request) => ({
  societyId: String(req.user!.activeTenantId),
  userId: String(req.user!.userId),
});

export const list = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;
    const data = await notifications.listForUser(societyId, userId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      // An unparseable date must not silently become "everything since 1970".
      before: before && !isNaN(before.getTime()) ? before : undefined,
      unreadOnly: req.query.unread === 'true',
    });
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load notifications'); }
};

/**
 * What this person wants to be told about, plus the kinds they have actually
 * been sent so the screen can offer real switches.
 *
 * Both in one response deliberately: a preferences page that has to make two
 * calls renders once with an empty list of topics and again with a full one,
 * and the switches jump under the reader's finger.
 */
export const preferences = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    const [preference, kinds] = await Promise.all([
      notifications.getPreference(societyId, userId),
      notifications.kindsForUser(societyId, userId),
    ]);
    res.json({ success: true, data: { preference, kinds } });
  } catch (e: any) { fail(res, e, 'load your notification settings'); }
};

/**
 * Save them. Scoped to `req.user` like everything else in this file — the body
 * carries the wishes, never whose wishes they are.
 */
export const savePreferences = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    const preference = await notifications.savePreference(societyId, userId, req.body);
    res.json({ success: true, data: { preference }, message: 'Your notification settings are saved.' });
  } catch (e: any) { fail(res, e, 'save your notification settings'); }
};

export const markRead = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    // No ids means "all of mine". The service scopes by userId either way, so
    // a caller cannot reach anybody else's rows by sending their ids.
    const count = await notifications.markRead(societyId, userId, req.body?.ids);
    res.json({ success: true, data: { marked: count } });
  } catch (e: any) { fail(res, e, 'mark notifications read'); }
};

/**
 * What a browser needs before it can subscribe, plus whether mobile push is
 * live. Both are non-secret by definition — the VAPID public key is handed to
 * every browser, and the boolean says nothing about the credentials.
 */
export const config = async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: {
        vapidPublicKey: await push.publicVapidKey(),
        mobilePushConfigured: push.isFirebaseConfigured(),
      },
    });
  } catch (e: any) { fail(res, e, 'load push configuration'); }
};

export const registerDevice = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    const { platform, token, keys, deviceLabel } = req.body;
    const doc = await push.registerToken({ societyId, userId, platform, token, keys, deviceLabel });
    res.json({ success: true, data: { _id: doc._id, platform: doc.platform } });
  } catch (e: any) { fail(res, e, 'register this device'); }
};

export const unregisterDevice = async (req: Request, res: Response) => {
  try {
    const { userId } = ctx(req);
    const removed = await push.forgetToken(String(req.body.token), userId);
    res.json({ success: true, data: { removed } });
  } catch (e: any) { fail(res, e, 'unregister this device'); }
};

/**
 * The live stream.
 *
 * Deliberately holds the response open; every other handler here returns
 * immediately. Teardown is registered on 'close' so a client that walks away —
 * closed tab, dead wifi, killed app — is forgotten rather than written to
 * forever.
 */
export const stream = async (req: Request, res: Response) => {
  try {
    const { societyId, userId } = ctx(req);
    // Compression buffers the stream and nothing arrives until the buffer
    // fills, which looks exactly like a broken feature.
    res.setHeader('Content-Encoding', 'identity');
    const teardown = sse.subscribe(res, userId, societyId);
    req.on('close', teardown);
  } catch (e: any) {
    logger.error(`SSE subscribe failed: ${e.message}`);
    try { res.end(); } catch { /* nothing to do */ }
  }
};
