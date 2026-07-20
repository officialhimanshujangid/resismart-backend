import mongoose from 'mongoose';
import { AdminTransfer, IAdminTransfer, SuccessorKind } from '../models/admin-transfer.model';
import { Society } from '../models/society.model';
import { User } from '../models/user.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Resident } from '../models/resident.model';
import { UserRole, TenantType } from '../constants/roles';
import { requestOtp, verifyOtp } from './otp.service';
import { notify } from './notification.service';
import { usersOfCommittee } from './notify-recipients';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class TransferError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * Succession, and the emergency door beside it.
 *
 * Three rules shape everything here, and each one is a specific failure being
 * designed against:
 *
 * **1. A society is never left without an admin.** Every path that removes one
 * installs the next in the same transaction. There is no ordering of steps
 * that leaves `Society.adminUserId` pointing at nobody, because the moment
 * that happens the only people who could fix it are the ones who just lost
 * access.
 *
 * **2. Nothing changes until the successor accepts.** An invitation is an
 * invitation. The likeliest outcome of any handover is that the other person
 * does not reply for four days, and the society must be entirely unaffected
 * for those four days.
 *
 * **3. The outgoing admin's next role is chosen, never assumed.** A secretary
 * who hands over is usually still a resident with bills and a flat. Silently
 * stripping their membership is how a handover turns into a support ticket.
 */

const INVITE_DAYS = 7;
const OBJECTION_HOURS = 72;

// ------------------------------------------------------------------ helpers

async function currentAdminId(societyId: string): Promise<string | null> {
  const society = await Society.findById(oid(societyId)).select('adminUserId').lean();
  return society?.adminUserId ? String(society.adminUserId) : null;
}

async function assertIsAdmin(societyId: string, userId: string) {
  const admin = await currentAdminId(societyId);
  if (!admin) throw new TransferError('This society has no admin on record. Please contact support.', 409);
  if (admin !== String(userId)) throw new TransferError('Only the current admin can do that.', 403);
}

/**
 * Swap the two memberships and the society pointer, atomically.
 *
 * A transaction rather than three awaits in a row: the middle state — where
 * the society points at the new admin but the old one still holds the role, or
 * worse, where neither does — is precisely the state that cannot be allowed to
 * survive a crash.
 */
async function applyHandover(
  societyId: string,
  fromUserId: string,
  toUserId: string,
  fromBecomes: string,
  session: mongoose.ClientSession,
) {
  const sid = oid(societyId);

  // The successor becomes admin. A membership may already exist (a committee
  // member being promoted), so update-then-insert rather than blind push.
  const promoted = await User.updateOne(
    { _id: oid(toUserId), 'memberships.tenantId': sid },
    { $set: { 'memberships.$[m].role': UserRole.SOCIETY_ADMIN } },
    { session, arrayFilters: [{ 'm.tenantId': sid }] },
  );
  if (promoted.matchedCount === 0) {
    await User.updateOne(
      { _id: oid(toUserId) },
      { $push: { memberships: { tenantType: TenantType.SOCIETY, tenantId: sid, role: UserRole.SOCIETY_ADMIN } } },
      { session },
    );
  }

  if (fromBecomes === 'NONE') {
    // Explicitly asked for: an external manager whose contract ended has no
    // reason to keep a membership. Never the default.
    await User.updateOne(
      { _id: oid(fromUserId) },
      { $pull: { memberships: { tenantId: sid } } },
      { session },
    );
  } else {
    await User.updateOne(
      { _id: oid(fromUserId), 'memberships.tenantId': sid },
      { $set: { 'memberships.$[m].role': fromBecomes } },
      { session, arrayFilters: [{ 'm.tenantId': sid }] },
    );
  }

  // Last, and in the same transaction: the society's own pointer.
  await Society.updateOne({ _id: sid }, { $set: { adminUserId: oid(toUserId) } }, { session });
}

// ---------------------------------------------------------------- initiating

export interface InitiateInput {
  toUserId: string;
  successorKind: SuccessorKind;
  /** What the outgoing admin becomes. Required — see rule 3. */
  fromBecomes: 'SOCIETY_COMMITTEE' | 'RESIDENT_OWNER' | 'RESIDENT_TENANT' | 'NONE';
  reason?: string;
}

export async function initiate(societyId: string, input: InitiateInput, actor: Actor): Promise<IAdminTransfer> {
  await assertIsAdmin(societyId, actor.userId);

  if (String(input.toUserId) === String(actor.userId)) {
    throw new TransferError('You are already the admin.');
  }

  const successor = await User.findById(oid(input.toUserId)).select('name email phone').lean();
  if (!successor) throw new TransferError('That person could not be found.', 404);

  // A contact to send the code to. Without one there is no way to prove the
  // successor is who the outgoing admin thinks they are, and a handover on
  // trust alone is how a society is taken over by whoever asked loudest.
  const channel: 'EMAIL' | 'PHONE' = successor.email ? 'EMAIL' : 'PHONE';
  const contact = successor.email || successor.phone;
  if (!contact) {
    throw new TransferError('That person has no email or phone on record, so they cannot confirm the handover.');
  }

  if (input.successorKind === 'EXTERNAL') {
    // A paid manager. The whole point is that they are NOT tied to a flat, so
    // this is checked rather than assumed — an "external" admin who is quietly
    // also a resident would inherit resident visibility nobody agreed to.
    const lives = await Resident.exists({ societyId: oid(societyId), userId: oid(input.toUserId), isActive: true });
    if (lives) {
      throw new TransferError('That person lives here — hand over to them as a member, not as an outside manager.');
    }
  }

  const existing = await AdminTransfer.findOne({ societyId: oid(societyId), status: 'INITIATED' });
  if (existing) throw new TransferError('A handover is already under way. Cancel it first.', 409);

  const transfer = await AdminTransfer.create({
    societyId: oid(societyId),
    fromUserId: oid(actor.userId), fromName: actor.userName,
    fromBecomes: input.fromBecomes,
    toUserId: oid(input.toUserId), toName: successor.name,
    toContact: contact, toChannel: channel,
    successorKind: input.successorKind,
    status: 'INITIATED',
    reason: input.reason,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
    isBreakGlass: false,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });

  // Everybody who should know, told at the moment it starts rather than after
  // it completes — a handover nobody saw coming is the one that gets disputed.
  tell(societyId, [String(input.toUserId)], 'ADMIN_TRANSFER_OFFERED',
    'You have been asked to take over as admin',
    `${actor.userName} wants to hand over the administration of this society to you.`,
    `/dashboard/settings/admin-transfer`);

  usersOfCommittee(societyId).then(committee => {
    tell(societyId, committee.filter(u => u !== String(actor.userId)), 'ADMIN_TRANSFER_OFFERED',
      'A handover of the admin role has started',
      `${actor.userName} has asked ${successor.name} to take over. Nothing has changed yet.`,
      `/dashboard/settings/admin-transfer`);
  }).catch(() => {});

  return transfer;
}

function tell(societyId: string, userIds: string[], kind: string, title: string, body: string, link: string) {
  if (!userIds.length) return;
  notify({
    societyId, userIds, kind, title, body, link,
    priority: 'HIGH', emailIfUnreachable: true,
  }).catch(e => logger.error(`Admin transfer notice failed: ${e.message}`));
}

// ------------------------------------------------------------------ accepting

/** Send the successor a code on the contact recorded at initiation. */
export async function sendAcceptanceCode(societyId: string, actor: Actor): Promise<{ expiresInSec: number; devCode?: string }> {
  const transfer = await liveTransfer(societyId);
  if (String(transfer.toUserId) !== String(actor.userId)) {
    throw new TransferError('This handover was not offered to you.', 403);
  }
  // The contact frozen at initiation, NOT whatever is on the account now.
  // Otherwise somebody who could change the successor's email could redirect
  // the code and take the society.
  return requestOtp(transfer.toChannel, transfer.toContact, 'GENERIC');
}

export async function accept(societyId: string, code: string, actor: Actor): Promise<IAdminTransfer> {
  const transfer = await liveTransfer(societyId);
  if (String(transfer.toUserId) !== String(actor.userId)) {
    throw new TransferError('This handover was not offered to you.', 403);
  }
  if (transfer.expiresAt < new Date()) {
    throw new TransferError('This invitation has expired. Ask for a new one.');
  }

  const verified = await verifyOtp(transfer.toChannel, transfer.toContact, 'GENERIC', code);
  if (!verified.ok) throw new TransferError(verified.error);

  // The current admin must still be the one who offered. If the role moved in
  // the meantime — a break-glass, say — this invitation is stale, and honouring
  // it would silently undo whatever happened since.
  const admin = await currentAdminId(societyId);
  if (admin !== String(transfer.fromUserId)) {
    transfer.status = 'CANCELLED';
    transfer.closedAt = new Date();
    transfer.closedReason = 'The admin changed before this was accepted.';
    await transfer.save();
    throw new TransferError('The admin has changed since this was offered, so it can no longer be accepted.', 409);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applyHandover(societyId, String(transfer.fromUserId), String(transfer.toUserId), transfer.fromBecomes, session);
      await AdminTransfer.updateOne(
        { _id: transfer._id, status: 'INITIATED' },
        {
          $set: {
            status: 'ACCEPTED', acceptedAt: new Date(),
            updatedBy: oid(actor.userId), updatedByName: actor.userName,
          },
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  const fresh = (await AdminTransfer.findById(transfer._id))!;

  tell(societyId, [String(transfer.fromUserId)], 'ADMIN_TRANSFER_DONE',
    'The handover is complete',
    `${actor.userName} is now the admin. You are ${describeRole(transfer.fromBecomes)}.`,
    '/dashboard/settings/admin-transfer');

  usersOfCommittee(societyId).then(committee => {
    tell(societyId, committee, 'ADMIN_TRANSFER_DONE',
      'The society has a new admin',
      `${actor.userName} has taken over from ${transfer.fromName}.`,
      '/dashboard/settings/admin-transfer');
  }).catch(() => {});

  return fresh;
}

function describeRole(role: string): string {
  switch (role) {
    case 'SOCIETY_COMMITTEE': return 'now a committee member';
    case 'RESIDENT_OWNER': return 'now recorded as a resident owner';
    case 'RESIDENT_TENANT': return 'now recorded as a tenant';
    case 'NONE': return 'no longer a member of this society';
    default: return `now ${role}`;
  }
}

export async function decline(societyId: string, actor: Actor): Promise<IAdminTransfer> {
  const transfer = await liveTransfer(societyId);
  if (String(transfer.toUserId) !== String(actor.userId)) {
    throw new TransferError('This handover was not offered to you.', 403);
  }
  transfer.status = 'DECLINED';
  transfer.closedAt = new Date();
  transfer.updatedBy = oid(actor.userId); transfer.updatedByName = actor.userName;
  await transfer.save();

  tell(societyId, [String(transfer.fromUserId)], 'ADMIN_TRANSFER_DECLINED',
    'Your handover was declined',
    `${actor.userName} did not take the admin role. You are still the admin.`,
    '/dashboard/settings/admin-transfer');
  return transfer;
}

export async function cancel(societyId: string, actor: Actor): Promise<IAdminTransfer> {
  const transfer = await liveTransfer(societyId);
  await assertIsAdmin(societyId, actor.userId);
  transfer.status = 'CANCELLED';
  transfer.closedAt = new Date();
  transfer.updatedBy = oid(actor.userId); transfer.updatedByName = actor.userName;
  await transfer.save();

  tell(societyId, [String(transfer.toUserId)], 'ADMIN_TRANSFER_CANCELLED',
    'The handover was withdrawn',
    `${actor.userName} has cancelled the admin handover.`,
    '/dashboard/settings/admin-transfer');
  return transfer;
}

async function liveTransfer(societyId: string): Promise<IAdminTransfer> {
  const t = await AdminTransfer.findOne({ societyId: oid(societyId), status: 'INITIATED' });
  if (!t) throw new TransferError('There is no handover under way.', 404);
  return t;
}

// --------------------------------------------------------------- break-glass

/**
 * When the admin cannot hand over — because they have left, died, or simply
 * stopped answering.
 *
 * Deliberately hard, and deliberately possible. A society that cannot recover
 * its own administration is one phone number away from being permanently
 * stuck; MyGate's answer to this is a support ticket, which means a third
 * party decides who runs somebody else's society.
 *
 * The guard rails, all four enforced below:
 *   - the Chairman must be one of the approvers;
 *   - at least three serving committee members in total;
 *   - a written reason;
 *   - the displaced admin gets 72 hours and an immediate, loud notification.
 *
 * The role moves NOW rather than after 72 hours. An emergency in which nobody
 * can act for three days is not an emergency procedure — the objection window
 * is for reversal, not for delay.
 */
export interface BreakGlassInput {
  toUserId: string;
  reason: string;
  /** Serving committee members backing this, including the caller. */
  approverUserIds: string[];
}

export async function breakGlass(societyId: string, input: BreakGlassInput, actor: Actor): Promise<IAdminTransfer> {
  if (!input.reason?.trim()) {
    throw new TransferError('An emergency takeover has to say why. It is recorded permanently.');
  }

  const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }).lean();
  if (!term) throw new TransferError('This society has no serving committee, so this cannot be authorised.', 409);

  const approverIds = [...new Set([...(input.approverUserIds || []), actor.userId].map(String))];
  const approvers = await CommitteeMember.find({
    societyId: oid(societyId), committeeId: term._id, status: 'ACTIVE',
    userId: { $in: approverIds.map(oid) },
  }).lean();

  if (approvers.length < 3) {
    throw new TransferError(
      `An emergency takeover needs three serving committee members. ${approvers.length} of the people named ${approvers.length === 1 ? 'is' : 'are'} on the committee.`,
    );
  }
  // The Chairman specifically. Bye-law 139 gives the emergency power to that
  // office, not to any three members who happen to agree with each other.
  const hasChair = approvers.some(a => a.designationKey === 'CHAIRMAN');
  if (!hasChair) throw new TransferError('The Chairman has to be one of the three.');

  const outgoing = await currentAdminId(societyId);
  if (!outgoing) throw new TransferError('This society has no admin on record.', 409);
  if (outgoing === String(input.toUserId)) throw new TransferError('That person is already the admin.');

  const successor = await User.findById(oid(input.toUserId)).select('name email phone').lean();
  if (!successor) throw new TransferError('That person could not be found.', 404);
  const outgoingUser = await User.findById(oid(outgoing)).select('name').lean();

  const session = await mongoose.startSession();
  let created: IAdminTransfer;
  try {
    await session.withTransaction(async () => {
      // Anything already in flight is void — the role is moving by another
      // route, and an invitation accepted afterwards would silently undo this.
      await AdminTransfer.updateMany(
        { societyId: oid(societyId), status: 'INITIATED' },
        { $set: { status: 'CANCELLED', closedAt: new Date(), closedReason: 'Superseded by an emergency takeover' } },
        { session },
      );

      // The displaced admin becomes a committee member, not nobody. They may
      // be unreachable rather than untrustworthy, and the objection window
      // means nothing if they cannot sign in to object.
      await applyHandover(societyId, outgoing, String(input.toUserId), UserRole.SOCIETY_COMMITTEE, session);

      const docs = await AdminTransfer.create([{
        societyId: oid(societyId),
        fromUserId: oid(outgoing), fromName: outgoingUser?.name || 'Previous admin',
        fromBecomes: UserRole.SOCIETY_COMMITTEE,
        toUserId: oid(input.toUserId), toName: successor.name,
        toContact: successor.email || successor.phone || '—',
        toChannel: successor.email ? 'EMAIL' : 'PHONE',
        successorKind: 'COMMITTEE',
        status: 'ACCEPTED',
        reason: input.reason.trim(),
        expiresAt: new Date(),
        acceptedAt: new Date(),
        isBreakGlass: true,
        approvedByUserIds: approvers.map(a => a.userId),
        approvedByNames: approvers.map(a => (a as any).memberSnapshot?.name || a.designationLabel),
        objectionDeadline: new Date(Date.now() + OBJECTION_HOURS * 60 * 60 * 1000),
        createdBy: oid(actor.userId), createdByName: actor.userName,
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      }], { session });
      created = docs[0];
    });
  } finally {
    await session.endSession();
  }

  tell(societyId, [outgoing], 'ADMIN_BREAK_GLASS',
    'Your admin role has been taken over',
    `The committee has moved the admin role to ${successor.name}. Reason: "${input.reason.trim()}". `
    + `You have ${OBJECTION_HOURS} hours to object.`,
    '/dashboard/settings/admin-transfer');

  usersOfCommittee(societyId).then(committee => {
    tell(societyId, committee, 'ADMIN_BREAK_GLASS',
      'The admin role was taken over in an emergency',
      `${successor.name} is now the admin, authorised by ${approvers.length} committee members.`,
      '/dashboard/settings/admin-transfer');
  }).catch(() => {});

  return created!;
}

/** The displaced admin says this was wrong. Recorded, and the committee is told. */
export async function object(societyId: string, id: string, note: string, actor: Actor): Promise<IAdminTransfer> {
  const t = await AdminTransfer.findOne({ _id: oid(id), societyId: oid(societyId), isBreakGlass: true });
  if (!t) throw new TransferError('That takeover could not be found.', 404);
  if (String(t.fromUserId) !== String(actor.userId)) {
    throw new TransferError('Only the person who was displaced can object.', 403);
  }
  if (t.objectionDeadline && t.objectionDeadline < new Date()) {
    throw new TransferError('The window to object has passed. Raise it at the next committee meeting.');
  }

  t.objectedAt = new Date();
  t.objectionNote = note?.trim();
  t.updatedBy = oid(actor.userId); t.updatedByName = actor.userName;
  await t.save();

  // Recorded and escalated, NOT auto-reversed. Software cannot adjudicate a
  // dispute between a society's committee and its former admin, and pretending
  // it can would make the reversal itself the next thing fought over.
  usersOfCommittee(societyId).then(committee => {
    tell(societyId, committee, 'ADMIN_BREAK_GLASS_OBJECTED',
      'The previous admin has objected',
      `${actor.userName} disputes the emergency takeover: "${note?.trim() || 'no reason given'}". `
      + 'This has to be settled at the next committee meeting.',
      '/dashboard/settings/admin-transfer');
  }).catch(() => {});

  return t;
}

// ----------------------------------------------------------------- reading

export async function history(societyId: string) {
  return AdminTransfer.find({ societyId: oid(societyId) }).sort({ createdAt: -1 }).limit(50).lean();
}

export async function current(societyId: string) {
  return AdminTransfer.findOne({ societyId: oid(societyId), status: 'INITIATED' }).lean();
}

/** Retire invitations nobody answered. */
export async function expireOld(now = new Date()): Promise<number> {
  const res = await AdminTransfer.updateMany(
    { status: 'INITIATED', expiresAt: { $lt: now } },
    { $set: { status: 'EXPIRED', closedAt: now, closedReason: 'Nobody responded in time' } },
  );
  return res.modifiedCount || 0;
}
