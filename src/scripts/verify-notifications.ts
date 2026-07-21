/**
 * Phase 7 — notifications: the record, the stream, and the devices.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertions, and why each one exists:
 *
 *   1. **The record is written even when every transport is dead.** No VAPID,
 *      no Firebase, nobody connected — the notification must still be there in
 *      the morning. This is the whole reason the record comes first.
 *   2. **A complaint still succeeds when notification fails.** The thing that
 *      would make this feature dangerous is it becoming load-bearing.
 *   3. **The actor is never told about their own action**, and the whole flat
 *      is, not just the person who happened to raise it.
 *   4. **A device moves between owners on re-registration** rather than
 *      leaving a second row that keeps notifying the previous resident.
 *   5. **markRead cannot reach somebody else's rows**, even when handed their
 *      ids directly.
 *
 *   npx tsx src/scripts/verify-notifications.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Notification } from '../models/notification.model';
import { PushToken } from '../models/push-token.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { Resident } from '../models/resident.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { notify, listForUser, markRead, purgeOld } from '../services/notification.service';
import { registerToken, forgetToken, pushToUsers, pruneStaleTokens, publicVapidKey } from '../services/push.service';
import { usersOfFlat, usersOfCommittee, excluding } from '../services/notify-recipients';
import { raise, markWorkDone, close } from '../services/complaint.service';
import * as sse from '../services/sse.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const tenantId = new mongoose.Types.ObjectId();
const strangerId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Manager' };
const SID = societyId.toString();
const OTHER = otherId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const audit = (sid: mongoose.Types.ObjectId) => ({
  societyId: sid,
  createdBy: adminId, createdByName: actor.userName,
  updatedBy: adminId, updatedByName: actor.userName,
});

async function cleanup() {
  for (const s of [societyId, otherId]) {
    await Promise.all([
      Notification.deleteMany({ societyId: s }), PushToken.deleteMany({ societyId: s }),
      Complaint.deleteMany({ societyId: s }), ComplaintCategory.deleteMany({ societyId: s }),
      ComplaintEvent.deleteMany({ societyId: s }), Resident.deleteMany({ societyId: s }),
      Block.deleteMany({ societyId: s }), Flat.deleteMany({ societyId: s }),
      Committee.deleteMany({ societyId: s }), CommitteeMember.deleteMany({ societyId: s }),
    ]);
  }
}

/** Complaint notifications are fire-and-forget, so give them a beat to land. */
const settle = () => new Promise(r => setTimeout(r, 400));

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const wing = await Block.create({ ...audit(societyId), name: 'A Wing' });
    const flat = await Flat.create({
      ...audit(societyId), blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.RENTED,
    });

    // An owner and a tenant in the same flat, plus somebody unrelated.
    await Resident.create([
      { ...audit(societyId), flatId: flat._id, userId: ownerId, person: { name: 'Owner Rao' }, relationship: 'OWNER', isActive: true },
      { ...audit(societyId), flatId: flat._id, userId: tenantId, person: { name: 'Tenant Iyer' }, relationship: 'TENANT', isActive: true },
    ]);

    // =========================================================== recipients
    console.log('Working out who to tell');
    const flatUsers = await usersOfFlat(SID, String(flat._id));
    ok('everyone in the flat is reachable, owner and tenant alike',
      flatUsers.includes(String(ownerId)) && flatUsers.includes(String(tenantId)));
    eq('...and nobody else', flatUsers.length, 2);
    ok('the person who acted is dropped from their own notification',
      !excluding(flatUsers, String(ownerId)).includes(String(ownerId)));

    // The committee is TWO models — the term, then its members. Reading user
    // ids off the term returns nothing at all, silently, which is exactly the
    // bug this asserts against.
    const term = await Committee.create({ ...audit(societyId), name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    await CommitteeMember.create({
      ...audit(societyId), committeeId: term._id, userId: adminId,
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman', status: 'ACTIVE',
      startDate: new Date('2026-01-01'),
      memberSnapshot: { name: 'Manager' },
    });
    const committee = await usersOfCommittee(SID);
    ok('the serving committee resolves through its members, not the term', committee.includes(String(adminId)));

    // ============================================================ the record
    console.log('\nThe record is written first, and survives every transport failing');
    // No devices registered, nobody streaming, no Firebase configured — the
    // worst realistic case, and the one that must not lose the message.
    const res = await notify({
      societyId: SID, userIds: [String(ownerId), String(tenantId)],
      kind: 'TEST', title: 'Water tank cleaning', body: 'Thursday, 10am',
      link: '/dashboard', priority: 'NORMAL',
    });
    eq('a record exists for every recipient', res.created, 2);
    eq('nothing was pushed — there are no devices', res.pushed, 0);
    eq('nobody was streaming', res.live, 0);

    const inbox = await listForUser(SID, String(ownerId));
    eq('...and the owner can still find it', inbox.items.length, 1);
    eq('...as unread', inbox.unread, 1);
    ok('...marked as delivered in-app', inbox.items[0].deliveredVia.includes('IN_APP'));

    const dup = await notify({
      societyId: SID, userIds: [String(ownerId), String(ownerId)],
      kind: 'TEST', title: 'Twice?', body: 'Should be once',
    });
    eq('the same person listed twice is told once', dup.created, 1);

    const none = await notify({ societyId: SID, userIds: [], kind: 'TEST', title: 'x', body: 'y' });
    eq('nobody to tell is not an error', none.created, 0);

    // ============================================================== reading
    console.log('\nReading, and only your own');
    const strangerInbox = await listForUser(SID, String(strangerId));
    eq('an unrelated user has an empty inbox', strangerInbox.items.length, 0);

    // Hand markRead somebody else's ids directly — the userId in the filter is
    // the caller's, so this must change nothing.
    const stolen = await markRead(SID, String(strangerId), inbox.items.map(i => String(i._id)));
    eq('another user cannot mark my notifications read', stolen, 0);
    const stillUnread = await listForUser(SID, String(ownerId));
    ok('...and mine are genuinely untouched', stillUnread.unread > 0);

    const marked = await markRead(SID, String(ownerId));
    ok('marking all read works for the owner', marked >= 1);
    const afterRead = await listForUser(SID, String(ownerId));
    eq('...leaving nothing unread', afterRead.unread, 0);
    ok('...but the notifications themselves remain', afterRead.items.length >= 1);

    const unreadOnly = await listForUser(SID, String(tenantId), { unreadOnly: true });
    ok('the tenant still has theirs unread', unreadOnly.items.length >= 1);

    // ========================================================= cross-society
    console.log('\nNothing leaks between societies');
    await notify({ societyId: OTHER, userIds: [String(ownerId)], kind: 'TEST', title: 'Other society', body: 'x' });
    const here = await listForUser(SID, String(ownerId));
    ok('the same person in two societies keeps two separate inboxes',
      here.items.every(i => i.title !== 'Other society'));
    const there = await listForUser(OTHER, String(ownerId));
    ok('...and the other one has its own', there.items.some(i => i.title === 'Other society'));

    // =============================================================== devices
    console.log('\nDevices');
    const web = await registerToken({
      societyId: SID, userId: String(ownerId), platform: 'WEB',
      token: `https://fcm.googleapis.com/test/${new mongoose.Types.ObjectId()}`,
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
      deviceLabel: 'Owner laptop',
    });
    ok('a browser subscription is stored with its keys', !!web.keys?.p256dh);
    eq('...owned by the person who registered it', String(web.userId), String(ownerId));

    // The same physical device, re-registered by somebody else. It must MOVE,
    // not multiply: a second row would keep notifying the previous resident
    // about a flat they no longer live in.
    const moved = await registerToken({
      societyId: SID, userId: String(tenantId), platform: 'WEB',
      token: web.token, keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    });
    eq('re-registering the same device moves it to the new owner', String(moved.userId), String(tenantId));
    eq('...without leaving a second row behind', await PushToken.countDocuments({ token: web.token }), 1);

    const phone = await registerToken({
      societyId: SID, userId: String(tenantId), platform: 'ANDROID',
      token: `fcm-token-${new mongoose.Types.ObjectId()}`,
    });
    eq('a phone needs no browser keys', phone.keys, undefined);
    eq('one person can hold several devices',
      await PushToken.countDocuments({ societyId, userId: tenantId }), 2);

    // Sending with no working transport: every attempt fails, and the point is
    // that the count of failures is honest and nothing throws.
    const outcome = await pushToUsers(SID, [String(tenantId)], { title: 'Test', body: 'Test' });
    eq('both devices were attempted', outcome.attempted, 2);
    ok('...and a failure to deliver is survivable', outcome.delivered >= 0);

    ok('a device can be forgotten', await forgetToken(phone.token));
    eq('...and is genuinely gone', await PushToken.countDocuments({ token: phone.token }), 0);

    // Stale pruning needs BOTH conditions. A phone that merely went quiet must
    // survive, or a fortnight's holiday costs the resident their notifications.
    const quiet = await registerToken({
      societyId: SID, userId: String(ownerId), platform: 'ANDROID',
      token: `quiet-${new mongoose.Types.ObjectId()}`,
    });
    const long = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await PushToken.collection.updateOne({ _id: quiet._id }, { $set: { lastSeenAt: long, failureCount: 0 } });
    await pruneStaleTokens();
    eq('a long-quiet but healthy device is kept', await PushToken.countDocuments({ _id: quiet._id }), 1);

    await PushToken.collection.updateOne({ _id: quiet._id }, { $set: { failureCount: 20 } });
    await pruneStaleTokens();
    eq('...but one that is both old and repeatedly failing is retired',
      await PushToken.countDocuments({ _id: quiet._id }), 0);

    // ================================================================== VAPID
    console.log('\nWeb push signs itself');
    const key1 = await publicVapidKey();
    ok('a VAPID public key exists without anyone configuring one', !!key1 && key1.length > 40);
    const key2 = await publicVapidKey();
    eq('...and it is stable across calls', key2, key1);

    // ==================================================================== SSE
    console.log('\nThe live stream');
    eq('publishing to nobody is harmless', sse.publish(SID, [String(ownerId)], 'notification', {}), 0);
    eq('nobody is connected in a script', sse.connectionCount(), 0);

    // ========================================== the real thing: a complaint
    console.log('\nA complaint tells the right people, and never depends on it');
    const complaint = await raise(SID, {
      title: 'Tap leaking in the kitchen',
      category: 'Plumbing',
      flatId: String(flat._id),
    }, { userId: String(tenantId), userName: 'Tenant Iyer' });
    ok('the complaint itself was recorded', !!complaint._id);

    await markWorkDone(SID, String(complaint._id), "Washer replaced", [], actor, { canManage: true });
    await settle();

    const ownerNotes = await listForUser(SID, String(ownerId));
    ok('the owner is asked to confirm the fix',
      ownerNotes.items.some(i => i.kind === 'COMPLAINT_WORK_DONE'));
    const tenantNotes = await listForUser(SID, String(tenantId));
    ok('...and so is the tenant who raised it',
      tenantNotes.items.some(i => i.kind === 'COMPLAINT_WORK_DONE'));

    // The manager did the marking, so must not be told about it.
    const managerNotes = await listForUser(SID, String(adminId));
    ok('the person who reported the work done is not told about themselves',
      !managerNotes.items.some(i => i.kind === 'COMPLAINT_WORK_DONE'));

    await close(SID, String(complaint._id), actor, { canManage: true });
    await settle();
    const afterClose = await listForUser(SID, String(ownerId));
    ok('closing tells the flat', afterClose.items.some(i => i.kind === 'COMPLAINT_CLOSED'));

    const linked = afterClose.items.find(i => i.kind === 'COMPLAINT_CLOSED');
    ok('...with a link back to the complaint', !!linked?.link?.includes(String(complaint._id)));
    eq('...tagged with what it is about', linked?.entityType, 'Complaint');

    // A complaint in a society with NO residents at all — nobody to notify.
    // This is the shape that would break if notify were awaited and threw.
    const orphanBlock = await Block.create({ ...audit(otherId), name: 'Empty Wing' });
    const orphanFlat = await Flat.create({
      ...audit(otherId), blockId: orphanBlock._id, blockName: 'Empty Wing',
      number: '1', status: FlatStatus.VACANT,
    });
    const orphan = await raise(OTHER, {
      title: 'Nobody lives here', category: 'Other', flatId: String(orphanFlat._id),
    }, actor);
    await markWorkDone(OTHER, String(orphan._id), "done", [], actor, { canManage: true });
    await settle();
    const stillThere = await Complaint.findById(orphan._id);
    eq('a complaint with nobody to notify still completes', stillThere?.status, 'WORK_DONE');

    // =============================================================== retention
    console.log('\nRetention');
    const old = await Notification.create({
      societyId, userId: ownerId, kind: 'TEST', title: 'Ancient', body: 'x',
    });
    // createdAt is immutable to Mongoose — $set through the model is silently
    // dropped, so this has to go through the driver.
    await Notification.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) } },
    );
    const purged = await purgeOld(SID, 90);
    ok('old notifications are cleared out', purged >= 1);
    eq('...and the ancient one is gone', await Notification.countDocuments({ _id: old._id }), 0);
    ok('...while recent ones survive', (await listForUser(SID, String(ownerId))).items.length > 0);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
