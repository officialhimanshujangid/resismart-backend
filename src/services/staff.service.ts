import crypto from 'crypto';
import mongoose from 'mongoose';
import { SocietyStaff, ISocietyStaff, STAFF_DESIGNATIONS } from '../models/society-staff.model';
import { StaffAssignment, WORK_CATEGORIES } from '../models/staff-assignment.model';
import { StaffShift, IStaffShift } from '../models/staff-shift.model';
import { StaffLeave, LEAVE_KINDS, LeaveKind, LEAVE_KIND_LABEL } from '../models/staff-leave.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { AccessRole } from '../models/access-role.model';
import { EffectiveAccess, allows } from './access-role.service';
import { User } from '../models/user.model';
import { Complaint } from '../models/complaint.model';
import { PushToken } from '../models/push-token.model';
import { TenantType, UserRole } from '../constants/roles';
import { attachTenantMembership, primaryIdentityId } from './identity.service';
import { usersOfCommittee } from './notify-recipients';
import { notify } from './notification.service';
import { hashPassword } from '../utils/hash.util';
import s3Service from './s3.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * The two S3 prefixes staff files are allowed to live under.
 *
 * The check is not decoration. `documents[]` and `verification.documentKey`
 * are attached by key, so without a prefix test a caller could attach ANY
 * object in the bucket — another society's title deed, a visitor's
 * photograph — and then read it straight back through the presigned-download
 * route, which only ever asks whether the key is on this staff record. Same
 * rule flat documents already enforce; the prefixes differ so a flat's papers
 * cannot be re-pointed at a staff row either.
 */
export const STAFF_DOC_PREFIX = 'staff-documents/';
export const STAFF_PHOTO_PREFIX = 'staff-photos/';

const assertDocKey = (key?: string) => {
  if (key && !key.startsWith(STAFF_DOC_PREFIX)) {
    throw new StaffError('That file was not uploaded through the staff document uploader.');
  }
};
const assertPhotoKey = (key?: string) => {
  if (key && !key.startsWith(STAFF_PHOTO_PREFIX)) {
    throw new StaffError('That photo was not uploaded through the staff photo uploader.');
  }
};

/** Statuses that mean the work is finished. Anything else is still on somebody's plate. */
const OPEN_STATUSES = { $nin: ['RESOLVED', 'CLOSED', 'REJECTED'] };

export class StaffError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor {
  userId: string;
  userName: string;
  /** What this person may do, so they cannot hand out more than they hold. */
  access?: EffectiveAccess;
}

const LEVEL_RANK: Record<string, number> = { NONE: 0, READ: 1, FULL: 2 };

/**
 * A short per-society code. Gapless is unnecessary here — nobody audits a staff
 * number — but it must not collide, so it counts what exists and retries on the
 * unique index rather than trusting a read-then-write.
 */
async function nextStaffCode(societyId: string): Promise<string> {
  const count = await SocietyStaff.countDocuments({ societyId: oid(societyId) });
  return `SF/${String(count + 1).padStart(4, '0')}`;
}

export interface CreateStaffInput {
  name: string;
  phone: string;
  email?: string;
  photoKey?: string;
  designation: string;
  employmentType?: 'DIRECT' | 'AGENCY' | 'CONTRACT';
  vendorId?: string;
  joinedOn?: string;
  accessRoleId?: string;
  verification?: { policeVerifiedOn?: string; verifiedBy?: string; documentKey?: string; expiresOn?: string };
  emergencyContact?: { name?: string; phone?: string; relation?: string };
  notes?: string;
}

export async function createStaff(societyId: string, input: CreateStaffInput, actor: Actor): Promise<ISocietyStaff> {
  if (!STAFF_DESIGNATIONS.includes(input.designation as any)) {
    throw new StaffError('That is not a job this society recognises.');
  }

  let vendorName: string | undefined;
  if (input.employmentType === 'AGENCY') {
    if (!input.vendorId) throw new StaffError('Which agency supplies them?');
    const vendor = await Vendor.findOne({ _id: input.vendorId, societyId: oid(societyId), isActive: true })
      .select('name').lean();
    if (!vendor) throw new StaffError('That agency is unknown to this society or inactive.');
    vendorName = vendor.name;
  }

  if (input.accessRoleId) await assertRoleUsable(societyId, input.accessRoleId, actor);
  assertPhotoKey(input.photoKey);
  assertDocKey(input.verification?.documentKey);

  // Retry once on the unique index: two people added at the same moment would
  // otherwise race for the same code.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await SocietyStaff.create({
        societyId: oid(societyId),
        staffCode: await nextStaffCode(societyId),
        person: {
          name: input.name.trim(), phone: input.phone.trim(),
          email: input.email?.trim(), photoKey: input.photoKey,
        },
        designation: input.designation,
        employmentType: input.employmentType || 'DIRECT',
        vendorId: input.employmentType === 'AGENCY' ? oid(input.vendorId) : undefined,
        vendorName,
        accessRoleId: input.accessRoleId ? oid(input.accessRoleId) : undefined,
        joinedOn: input.joinedOn ? new Date(input.joinedOn) : new Date(),
        isActive: true,
        verification: {
          policeVerifiedOn: input.verification?.policeVerifiedOn ? new Date(input.verification.policeVerifiedOn) : undefined,
          verifiedBy: input.verification?.verifiedBy,
          documentKey: input.verification?.documentKey,
          expiresOn: input.verification?.expiresOn ? new Date(input.verification.expiresOn) : undefined,
        },
        emergencyContact: input.emergencyContact?.name ? input.emergencyContact : undefined,
        notes: input.notes,
        createdBy: oid(actor.userId), createdByName: actor.userName,
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      });
    } catch (e: any) {
      if (e?.code !== 11000 || attempt === 2) throw e;
    }
  }
  throw new StaffError('Could not allocate a staff code. Try again.');
}

/**
 * A role must belong to this society, be offered for staff posts, and — the
 * part that was missing — **not hand out more than the person giving it holds.**
 *
 * `ACCESS_MANAGE` is deliberately absent from every seeded role, on the
 * principle that "a role that can grant itself more is not a permission
 * system". `STAFF_MANAGE` walked straight around it: a holder of the seeded
 * "Society manager" role could create a staff record, attach *Society manager*
 * to it, call `provisionLogin`, and read the new password out of the response —
 * minting a peer with GATE_CONSOLE, OPS_SETTINGS and STAFF_MANAGE, without
 * ever touching the permission the rule was written to protect.
 *
 * So: you may only assign a role whose every grant you already hold at that
 * level or higher. An admin, and anybody genuinely given `ACCESS_MANAGE`, are
 * exempt — handing out access is exactly their job.
 */
async function assertRoleUsable(societyId: string, accessRoleId: string, actor: Actor) {
  const role = await AccessRole.findOne({ _id: accessRoleId, societyId: oid(societyId), isActive: true }).lean();
  if (!role) throw new StaffError('That role does not belong to this society.');
  if (role.appliesTo === 'COMMITTEE') throw new StaffError('That role is for committee seats, not staff.');

  const access = actor.access;
  // No resolved access means this was called from a script or a migration, not
  // from a request. Those run as the software, not as a person with a ceiling.
  if (!access) return;
  if (access.isAdmin || allows(access, 'ACCESS_MANAGE', 'FULL')) {
    // Even here, you may not hand out more than you hold — an ACCESS_MANAGE
    // holder who is not the admin still has a ceiling.
    for (const grant of role.permissions || []) {
      if (grant.level === 'NONE') continue;
      const held = access.permissions[grant.module] ?? 'NONE';
      if (!access.isAdmin && LEVEL_RANK[held] < LEVEL_RANK[grant.level]) {
        throw new StaffError(
          `"${role.name}" includes access you do not have yourself, so you cannot give it to somebody else.`,
          403,
        );
      }
    }
    return;
  }

  /**
   * Hiring is `STAFF_MANAGE`. Deciding what somebody may DO in the software is
   * `ACCESS_MANAGE`, and they are not the same job.
   *
   * "You cannot grant more than you hold" is the obvious rule and it does not
   * close this hole: a Society manager cloning *their own* role grants exactly
   * what they hold, so an equality check waves it through — and they now have a
   * second account, with a password they read out of the API response, that
   * survives their own removal. Lateral, not upward, and still a back door.
   *
   * So attaching a role is refused outright. A manager may still hire, edit and
   * end staff; the admin says what the new person may touch. That is the same
   * principle the seeded roles already follow by giving `ACCESS_MANAGE` to
   * nobody, including the Chairman.
   */
  throw new StaffError(
    'You can add staff, but only your society admin can say what they are allowed to do. '
    + 'Add them first and ask the admin to give them access.',
    403,
  );
}

export async function updateStaff(societyId: string, id: string, body: any, actor: Actor): Promise<ISocietyStaff> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);

  if (body.accessRoleId !== undefined) {
    if (body.accessRoleId) {
      await assertRoleUsable(societyId, body.accessRoleId, actor);
      staff.accessRoleId = oid(body.accessRoleId);
    } else {
      staff.accessRoleId = undefined;
    }
  }

  if (body.name) staff.person.name = String(body.name).trim();
  if (body.phone) staff.person.phone = String(body.phone).trim();
  if (body.email !== undefined) staff.person.email = body.email || undefined;
  if (body.photoKey !== undefined) {
    assertPhotoKey(body.photoKey);
    staff.person.photoKey = body.photoKey || undefined;
  }
  if (body.designation) {
    if (!STAFF_DESIGNATIONS.includes(body.designation)) throw new StaffError('That is not a job this society recognises.');
    staff.designation = body.designation;
  }
  if (body.notes !== undefined) staff.notes = body.notes;
  if (body.emergencyContact !== undefined) staff.emergencyContact = body.emergencyContact;
  if (body.verification !== undefined) {
    assertDocKey(body.verification.documentKey);
    const expiresOn = body.verification.expiresOn
      ? new Date(body.verification.expiresOn) : staff.verification.expiresOn;
    staff.verification = {
      policeVerifiedOn: body.verification.policeVerifiedOn ? new Date(body.verification.policeVerifiedOn) : staff.verification.policeVerifiedOn,
      verifiedBy: body.verification.verifiedBy ?? staff.verification.verifiedBy,
      documentKey: body.verification.documentKey ?? staff.verification.documentKey,
      expiresOn,
      /**
       * Renewing re-arms the reminder.
       *
       * The sweep skips anybody whose `warnedForExpiry` already equals the
       * expiry it is looking at. Carrying an old marker across a renewal would
       * silence the NEXT lapse for good — the exact failure the field exists
       * to prevent — so a changed date clears it.
       */
      warnedForExpiry: String(expiresOn) === String(staff.verification.expiresOn)
        ? staff.verification.warnedForExpiry
        : undefined,
    };
  }

  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();
  return staff;
}

/**
 * Give a staff member a login.
 *
 * This is the function whose absence made the whole permission system dead
 * code. `SocietyStaff.userId` was declared and never written, so `resolveAccess`
 * always found nobody, every SOCIETY_EMPLOYEE got all-NONE, and no assigned
 * technician was ever notified. The model was right; there was simply no door
 * from a staff record to a user account.
 *
 * Reuses `attachTenantMembership` — the exact machinery residents and shops are
 * provisioned through — rather than inventing a second way to make a user. The
 * generated password is returned so the office can hand it over; there is no
 * SMS gateway yet, and inventing one here would be scope this phase does not own.
 */
export async function provisionLogin(societyId: string, id: string, actor: Actor): Promise<{ staff: ISocietyStaff; password?: string }> {
  // Creating an account is access work, not staff work — and this one returns
  // the password in the response. A `STAFF_MANAGE` holder minting logins is how
  // an account nobody approved ends up outliving the person who made it.
  if (actor.access && !actor.access.isAdmin && !allows(actor.access, 'ACCESS_MANAGE', 'FULL')) {
    throw new StaffError(
      'Only your society admin can create a login for a staff member.', 403,
    );
  }

  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.isActive) throw new StaffError('They have left — a former employee cannot be given a login.');
  if (staff.userId) throw new StaffError('They already have a login.');
  if (!staff.person.phone && !staff.person.email) {
    throw new StaffError('Add a phone or email first — a login needs something to sign in with.');
  }

  const attached = await attachTenantMembership({
    name: staff.person.name,
    email: staff.person.email,
    phone: staff.person.phone,
    tenantType: TenantType.SOCIETY,
    tenantId: societyId,
    role: UserRole.SOCIETY_EMPLOYEE,
  });

  const userId = primaryIdentityId(attached);
  if (!userId) throw new StaffError('Could not create a login for them.');

  staff.userId = userId;
  staff.updatedBy = oid(actor.userId); staff.updatedByName = actor.userName;
  await staff.save();

  logger.info(`Society ${societyId}: login provisioned for ${staff.person.name}`);
  return { staff, password: attached.generatedPassword };
}

/**
 * End someone's employment.
 *
 * Deactivated, never deleted: their name is on months of complaint history and
 * gate entries, and a deleted row would leave those reading "unknown". Their
 * assignments go with them, so routing stops sending them work the same day.
 */
export async function endEmployment(
  societyId: string, id: string, leftOn: Date, actor: Actor,
  opts: { handoverToStaffId?: string } = {},
): Promise<ISocietyStaff> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.isActive) throw new StaffError('They have already left.');

  /**
   * Open work does not leave with the person.
   *
   * This used to deactivate the staff row and their assignments and stop
   * there — so every complaint still assigned to them stayed assigned to
   * somebody who no longer worked here. It was worse than a stale name:
   * `userOfStaff` filters `isActive: true`, so from that moment every
   * notification about those complaints resolved to **zero recipients** and
   * went nowhere, silently. The resident saw a ticket with a name on it and
   * heard nothing more.
   *
   * So the caller must say where the work goes. Naming a successor moves it;
   * naming nobody puts it back in the manager's unassigned queue, which is
   * visible and chaseable. Both are honest; leaving it pointing at a departed
   * employee is not.
   */
  // The successor is checked BEFORE anything is counted or written. Validating
  // it inside the "has open work" branch made the API's answer depend on
  // incidental state: the same nonsense request was refused for a busy
  // technician and quietly accepted for an idle one.
  let successor: ISocietyStaff | null = null;
  if (opts.handoverToStaffId) {
    if (String(opts.handoverToStaffId) === String(staff._id)) {
      throw new StaffError('They cannot hand their work to themselves.');
    }
    successor = await SocietyStaff.findOne({
      _id: oid(opts.handoverToStaffId), societyId: oid(societyId), isActive: true,
    });
    if (!successor) throw new StaffError('That person cannot take the work — they are unknown here or have left.');
  }

  const open = await Complaint.find({
    societyId: oid(societyId),
    assigneeStaffId: staff._id,
    status: { $nin: ['RESOLVED', 'CLOSED', 'REJECTED'] },
  }).select('_id ticketCode').lean();

  if (open.length) {
    await Complaint.updateMany(
      { _id: { $in: open.map(c => c._id) } },
      successor
        ? {
          $set: {
            assigneeStaffId: successor._id, assigneeName: successor.person.name,
            routedVia: 'HANDOVER',
            updatedBy: oid(actor.userId), updatedByName: actor.userName,
          },
        }
        : {
          // Unassigned, but NOT rewound to NEW: work that has begun stays in
          // the state it reached. It simply no longer has a name on it.
          $unset: { assigneeStaffId: 1, assigneeName: 1 },
          $set: { updatedBy: oid(actor.userId), updatedByName: actor.userName },
        },
    );

    logger.info(
      `Society ${societyId}: ${open.length} open complaint(s) moved off ${staff.person.name}`
      + (successor ? ` to ${successor.person.name}` : ' back to the unassigned queue'),
    );
  }

  staff.isActive = false;
  staff.leftOn = leftOn;
  // Close the stretch of employment that just ended, so a later `reinstate`
  // adds to a history rather than overwriting one. Without this the day they
  // first joined is lost the moment they come back.
  staff.spells.push({ joinedOn: staff.joinedOn, leftOn, endedByName: actor.userName });
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();

  const res = await StaffAssignment.updateMany(
    { societyId: oid(societyId), staffId: staff._id, isActive: true },
    { $set: { isActive: false, updatedBy: oid(actor.userId), updatedByName: actor.userName } },
  );

  // Pull their society-employee membership, so a dismissed guard cannot still
  // sign in. The identity row itself stays — they may be a resident elsewhere,
  // and their name must keep resolving on old records.
  if (staff.userId) {
    await User.updateOne(
      { _id: staff.userId },
      { $pull: { memberships: { tenantId: oid(societyId), role: UserRole.SOCIETY_EMPLOYEE } } },
    ).catch(e => logger.error(`Could not revoke login for departed staff: ${e.message}`));

    // And take their devices with them. Push tokens were never deleted on
    // exit, so a dismissed guard's phone kept receiving this society's gate
    // alerts — visitor names and flat numbers — indefinitely, long after the
    // login itself stopped working.
    await PushToken.deleteMany({ societyId: oid(societyId), userId: staff.userId })
      .catch(e => logger.error(`Could not remove departed staff's devices: ${e.message}`));
  }

  logger.info(`Society ${societyId}: ${staff.person.name} left; ${res.modifiedCount} assignment(s) ended with them`);
  return staff;
}

/**
 * Somebody comes back.
 *
 * Before this there was no way back at all: `endEmployment` refuses an inactive
 * row, `provisionLogin` refuses an inactive row, and nothing reopened one. A
 * guard who left in June and returned in September had to be entered afresh as
 * a new `SF/xxxx`. That is not a cosmetic annoyance:
 *
 *   - their old complaints, gate entries and expense lines stay under the dead
 *     code, so "what has Ramesh handled this year" answers half the question;
 *   - `agencyHeadcount` counts BOTH rows, so the roll says five guards where
 *     four stand at the gate — and that number is the entire reason this module
 *     exists without payroll;
 *   - their police verification, their papers and their photograph are on the
 *     old row, so the new one starts unverified and nobody notices.
 *
 * So the original row reopens. The staff code, the documents and the
 * verification stay exactly where they were; the closed stretch is already in
 * `spells`, and `joinedOn` becomes the day they came back.
 *
 * Their login is restored too, when they had one. `endEmployment` pulls the
 * society-employee membership but leaves `userId` in place, so a reinstated
 * person would otherwise hold an account that `provisionLogin` refuses to
 * recreate ("they already have a login") and that cannot sign in — the worst of
 * both. Assignments are NOT restored: who covers which wing will have moved on
 * in the months they were away, and silently reinstating stale cover is how
 * work starts flowing to somebody nobody expected.
 */
export async function reinstate(
  societyId: string, id: string, actor: Actor, opts: { joinedOn?: Date } = {},
): Promise<ISocietyStaff> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (staff.isActive) throw new StaffError('They are already on the roll.');

  const rejoinedOn = opts.joinedOn || new Date();
  const lastLeft = staff.leftOn;
  if (lastLeft && rejoinedOn < lastLeft) {
    throw new StaffError('They cannot rejoin before the day they left. Check the date.');
  }

  staff.isActive = true;
  staff.leftOn = null;
  staff.joinedOn = rejoinedOn;
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();

  if (staff.userId) {
    // Straight back onto the same identity, through the same door residents and
    // shops use. `attachTenantMembership` is idempotent, so a membership that
    // somehow survived is not duplicated.
    await attachTenantMembership({
      name: staff.person.name,
      email: staff.person.email,
      phone: staff.person.phone,
      tenantType: TenantType.SOCIETY,
      tenantId: societyId,
      role: UserRole.SOCIETY_EMPLOYEE,
    }).catch(e => logger.error(`Could not restore login on rehire: ${e.message}`));
  }

  logger.info(
    `Society ${societyId}: ${staff.person.name} (${staff.staffCode}) rejoined; `
    + `${staff.spells.length} earlier stretch(es) kept`,
  );
  return staff;
}

/**
 * Take a login away without ending employment.
 *
 * There was no way to do this. A guard under investigation, a manager who
 * handed their phone to a relative, somebody moved off the desk and onto the
 * garden — the only lever was to mark them as having LEFT, which is a lie on
 * the record and drops their open complaints on the floor.
 *
 * `userId` is cleared, not just the membership: `userOfStaff` resolves
 * notifications through it, and leaving it in place would keep addressing
 * messages about live complaints to an account that cannot sign in to read
 * them. Their devices go with it, for the reason the exit path already
 * documents — a push carries visitor names and flat numbers.
 *
 * Same permission as `provisionLogin`. Creating and destroying an account are
 * the same job, and it is not the hiring manager's.
 */
export async function revokeLogin(societyId: string, id: string, actor: Actor): Promise<ISocietyStaff> {
  if (actor.access && !actor.access.isAdmin && !allows(actor.access, 'ACCESS_MANAGE', 'FULL')) {
    throw new StaffError('Only your society admin can take away a staff login.', 403);
  }

  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.userId) throw new StaffError('They do not have a login to take away.');

  const userId = staff.userId;
  staff.userId = undefined;
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();

  await User.updateOne(
    { _id: userId },
    { $pull: { memberships: { tenantId: oid(societyId), role: UserRole.SOCIETY_EMPLOYEE } } },
  ).catch(e => logger.error(`Could not revoke staff login: ${e.message}`));
  await PushToken.deleteMany({ societyId: oid(societyId), userId })
    .catch(e => logger.error(`Could not remove that staff member's devices: ${e.message}`));

  logger.info(`Society ${societyId}: login revoked for ${staff.person.name}, employment continues`);
  return staff;
}

/**
 * A new one-time password, for the office to hand over again.
 *
 * The password minted by `provisionLogin` was shown once, in a toast, and never
 * again. Somebody who lost the slip of paper had exactly one route back:
 * end their employment and re-hire them. That is how a staff record gets
 * mangled to solve a forgotten password.
 *
 * Phone-only identities are passwordless on purpose — they sign in with an OTP,
 * exactly like a resident — so there is nothing to reset and saying so plainly
 * is better than minting a password that never gets used.
 */
export async function resetPassword(
  societyId: string, id: string, actor: Actor,
): Promise<{ staff: ISocietyStaff; password: string }> {
  if (actor.access && !actor.access.isAdmin && !allows(actor.access, 'ACCESS_MANAGE', 'FULL')) {
    throw new StaffError('Only your society admin can reset a staff password.', 403);
  }

  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.isActive) throw new StaffError('They have left — a former employee has no password to reset.');
  if (!staff.userId) throw new StaffError('They do not have a login yet. Give them one first.');

  const user = await User.findById(staff.userId);
  if (!user) throw new StaffError('Their account could not be found.', 404);
  if (!user.email) {
    throw new StaffError(
      'They sign in with a one-time code sent to their phone, so there is no password to reset. '
      + 'Ask them to sign in with their number.',
    );
  }

  const password = crypto.randomBytes(4).toString('hex');
  user.passwordHash = await hashPassword(password);
  await user.save();

  logger.info(`Society ${societyId}: password reset for ${staff.person.name}`);
  return { staff, password };
}

export async function listStaff(societyId: string, query: any = {}) {
  const filter: any = { societyId: oid(societyId) };
  if (query.active !== 'all') filter.isActive = query.active === 'false' ? false : true;
  if (query.designation) filter.designation = query.designation;
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'person.name': rx }, { 'person.phone': rx }, { staffCode: rx }];
  }
  return SocietyStaff.find(filter).sort({ isActive: -1, 'person.name': 1 }).lean();
}

export async function getStaff(societyId: string, id: string, at = new Date()) {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) }).lean();
  if (!staff) throw new StaffError('That staff member could not be found.', 404);

  const [assignments, shifts, leave] = await Promise.all([
    StaffAssignment.find({ societyId: oid(societyId), staffId: oid(id) })
      .sort({ isActive: -1, rank: 1 }).lean(),
    StaffShift.find({ societyId: oid(societyId), staffId: oid(id), isActive: true })
      .sort({ weekday: 1, from: 1 }).lean(),
    StaffLeave.find({ societyId: oid(societyId), staffId: oid(id), isActive: true })
      .sort({ from: -1 }).limit(50).lean(),
  ]);

  /**
   * The screen gets document NAMES and ids, never S3 keys.
   *
   * A raw key in a JSON response is a standing invitation to try fetching it
   * directly, and it is the one thing the presigned-download route exists to
   * avoid handing out. Same discipline as flat documents.
   */
  const { documents, person, verification, ...rest } = staff as any;
  return {
    staff: {
      ...rest,
      person: { ...person, photoKey: undefined, hasPhoto: !!person?.photoKey },
      verification: {
        ...verification,
        documentKey: undefined,
        hasDocument: !!verification?.documentKey,
      },
      documents: (documents || []).map((d: any) => ({
        _id: String(d._id), name: d.name,
        uploadedAt: d.uploadedAt, uploadedByName: d.uploadedByName,
      })),
    },
    assignments,
    shifts,
    leave,
    onDutyNow: await isAvailable(societyId, id, at),
  };
}

// ------------------------------------------------------------------- papers
//
// Everything below was declared on the model and written by nothing. There was
// no create path for `documents[]`, no upload endpoint, no download route and
// no UI — so `verification.policeVerifiedOn` was a bare date with no scan
// behind it. A tick with nothing to show is worse than an empty field: it reads
// as an answer, and the committee stops asking.

export interface StaffDocumentView {
  _id: string;
  name: string;
  uploadedAt: Date;
  uploadedByName: string;
}

async function ownedStaff(societyId: string, id: string) {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  // Scoped to the society on every entry point, so an id belonging to somebody
  // else's building is a 404 rather than a document leak.
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  return staff;
}

export async function listDocuments(societyId: string, id: string): Promise<StaffDocumentView[]> {
  const staff = await ownedStaff(societyId, id);
  return (staff.documents || [])
    .slice()
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map(d => ({
      _id: String((d as any)._id), name: d.name,
      uploadedAt: d.uploadedAt, uploadedByName: d.uploadedByName,
    }));
}

/**
 * Attach an already-uploaded object to a staff record.
 *
 * The bytes reach S3 through `POST /upload/staff-document`, which returns
 * `{ url, key }`; this records the reference only. Upload and attach are kept
 * apart for the same reason flat documents keep them apart — an abandoned form
 * leaves an orphaned object, never an orphaned row pointing at nothing.
 */
export async function addDocument(
  societyId: string, id: string, input: { name: string; key: string }, actor: Actor,
): Promise<StaffDocumentView> {
  const staff = await ownedStaff(societyId, id);
  assertDocKey(input.key);
  if (!input.key) throw new StaffError('Nothing was uploaded.');
  if (!input.name?.trim()) throw new StaffError('Give the document a name — "Police verification", "ID proof".');

  staff.documents.push({
    name: input.name.trim(), key: input.key,
    uploadedAt: new Date(), uploadedByName: actor.userName,
  } as any);
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();

  const d = staff.documents[staff.documents.length - 1];
  return { _id: String((d as any)._id), name: d.name, uploadedAt: d.uploadedAt, uploadedByName: d.uploadedByName };
}

/**
 * Detach a document.
 *
 * The S3 object is deliberately left alone, exactly as flat documents do: a
 * police verification removed by a mistaken click cannot be got back if the
 * bytes went with it, and storage is far cheaper than asking a guard to go
 * through the process again. The reference disappears, which is what "delete"
 * means to the person clicking it.
 */
export async function removeDocument(
  societyId: string, id: string, docId: string, actor: Actor,
): Promise<{ name: string }> {
  const staff = await ownedStaff(societyId, id);
  const doc = (staff.documents || []).find(d => String((d as any)._id) === String(docId));
  if (!doc) throw new StaffError('That document could not be found.', 404);

  staff.documents = staff.documents.filter(d => String((d as any)._id) !== String(docId)) as any;
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();
  return { name: doc.name };
}

/** A short-lived signed URL. Nothing in the bucket is publicly readable. */
export async function documentDownloadUrl(societyId: string, id: string, docId: string): Promise<string> {
  const staff = await ownedStaff(societyId, id);
  const doc = (staff.documents || []).find(d => String((d as any)._id) === String(docId));
  if (!doc) throw new StaffError('That document could not be found.', 404);
  return s3Service.getSignedDownloadUrl(doc.key, { expiresIn: 5 * 60, downloadName: doc.name });
}

/**
 * The scan behind the police verification.
 *
 * `verification.documentKey` existed on the model with nothing that could ever
 * read it back. This is the route that makes the date mean something: a
 * committee member can look at the paper the office says it holds.
 */
export async function verificationDownloadUrl(societyId: string, id: string): Promise<string> {
  const staff = await ownedStaff(societyId, id);
  if (!staff.verification?.documentKey) {
    throw new StaffError('No police verification has been filed for them yet.', 404);
  }
  return s3Service.getSignedDownloadUrl(staff.verification.documentKey, {
    expiresIn: 5 * 60,
    downloadName: `Police verification — ${staff.person.name}`,
  });
}

/**
 * Their photograph.
 *
 * `person.photoKey` was writable through create and update and readable by
 * nothing, so a guard's photo could be stored and never shown — which defeats
 * the only purpose it has, letting somebody at the gate check that the person
 * in front of them is the person on the roll.
 */
export async function photoDownloadUrl(societyId: string, id: string): Promise<string> {
  const staff = await ownedStaff(societyId, id);
  if (!staff.person?.photoKey) throw new StaffError('No photograph has been added for them.', 404);
  return s3Service.getSignedDownloadUrl(staff.person.photoKey, {
    expiresIn: 5 * 60, downloadName: staff.person.name,
  });
}

// ---------------------------------------------------------------- assignments

export interface AssignInput {
  staffId: string;
  scope: 'SOCIETY' | 'BLOCK';
  blockId?: string;
  categories: string[];
  rank?: 'PRIMARY' | 'BACKUP';
}

export async function assign(societyId: string, input: AssignInput, actor: Actor) {
  const staff = await SocietyStaff.findOne({ _id: input.staffId, societyId: oid(societyId), isActive: true })
    .select('person.name').lean();
  if (!staff) throw new StaffError('That staff member is unknown to this society or has left.');

  const categories = (input.categories || []).filter(c => (WORK_CATEGORIES as readonly string[]).includes(c));
  if (!categories.length) throw new StaffError('What kind of work should reach them?');

  let blockName: string | undefined;
  if (input.scope === 'BLOCK') {
    if (!input.blockId) throw new StaffError('Which wing?');
    const block = await Block.findOne({ _id: input.blockId, societyId: oid(societyId) }).select('name').lean();
    if (!block) throw new StaffError('That wing does not belong to this society.');
    blockName = block.name;
  }

  return StaffAssignment.create({
    societyId: oid(societyId),
    staffId: oid(input.staffId),
    staffName: staff.person.name,
    scope: input.scope,
    blockId: input.scope === 'BLOCK' ? oid(input.blockId) : undefined,
    blockName,
    categories,
    rank: input.rank || 'PRIMARY',
    isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function unassign(societyId: string, assignmentId: string, actor: Actor) {
  const row = await StaffAssignment.findOne({ _id: assignmentId, societyId: oid(societyId) });
  if (!row) throw new StaffError('That assignment could not be found.', 404);
  row.isActive = false;
  row.updatedBy = oid(actor.userId);
  row.updatedByName = actor.userName;
  await row.save();
  return row;
}

// --------------------------------------------------------------- the rota
//
// `StaffAssignment` is (staff × wing × trade × rank) and has no time dimension
// at all, which produced two failures that look small on paper and are not:
//
//   1. `findAssignee` fell through to BACKUP only when NO primary row existed —
//      never when the primary was on leave or off shift. The backup rank, whose
//      entire purpose is cover, was consulted exactly when cover was not needed.
//   2. It picked with `.sort({ createdAt: 1 })`, so of two equally qualified
//      plumbers the one assigned first got every single ticket, forever, and
//      the second appeared on the coverage grid doing nothing.
//
// Shifts and leave fix (1); least-loaded ordering fixes (2).

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Does this shift cover this instant?
 *
 * The wrap-around branch is the whole reason this is a function rather than a
 * comparison inline. A guard's shift is 22:00–06:00; the obvious test
 * `from <= now && now < to` reports him off duty for every hour of it, which
 * would have routed every night complaint to nobody.
 */
export function shiftCovers(shift: Pick<IStaffShift, 'weekday' | 'from' | 'to'>, at: Date): boolean {
  const day = at.getDay();
  const now = hhmm(at);

  if (shift.to > shift.from) return shift.weekday === day && now >= shift.from && now < shift.to;

  // Runs past midnight (or, when the two are equal, all day round). It covers
  // the late part of its OWN weekday and the small hours of the NEXT one.
  if (shift.weekday === day && now >= shift.from) return true;
  return shift.weekday === (day + 6) % 7 && now < shift.to;
}

export interface ShiftInput { staffId: string; weekday: number; from: string; to: string }

export async function setShift(societyId: string, input: ShiftInput, actor: Actor) {
  const staff = await SocietyStaff.findOne({ _id: input.staffId, societyId: oid(societyId), isActive: true })
    .select('person.name').lean();
  if (!staff) throw new StaffError('That staff member is unknown to this society or has left.');
  if (!(input.weekday >= 0 && input.weekday <= 6)) throw new StaffError('Which day of the week?');
  if (input.from === input.to) {
    throw new StaffError('A shift that starts and ends at the same minute covers nothing. Give it an end time.');
  }

  return StaffShift.create({
    societyId: oid(societyId), staffId: oid(input.staffId), staffName: staff.person.name,
    weekday: input.weekday, from: input.from, to: input.to, isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function removeShift(societyId: string, shiftId: string, actor: Actor) {
  const row = await StaffShift.findOne({ _id: shiftId, societyId: oid(societyId) });
  if (!row) throw new StaffError('That shift could not be found.', 404);
  row.isActive = false;
  row.updatedBy = oid(actor.userId);
  row.updatedByName = actor.userName;
  await row.save();
  return row;
}

export interface LeaveInput { staffId: string; from: string; to: string; kind?: LeaveKind; reason?: string }

export async function addLeave(societyId: string, input: LeaveInput, actor: Actor) {
  const staff = await SocietyStaff.findOne({ _id: input.staffId, societyId: oid(societyId), isActive: true })
    .select('person.name').lean();
  if (!staff) throw new StaffError('That staff member is unknown to this society or has left.');

  // Whole days at both ends. Somebody away "on the 5th" is away for all of the
  // 5th, and a bare `new Date('2026-07-05')` is midnight — which would put them
  // back on duty for the entire day they are absent.
  const from = new Date(input.from); from.setHours(0, 0, 0, 0);
  const to = new Date(input.to); to.setHours(23, 59, 59, 999);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new StaffError('Check those dates.');
  if (to < from) throw new StaffError('The last day cannot be before the first day.');

  const kind = (input.kind && (LEAVE_KINDS as readonly string[]).includes(input.kind)) ? input.kind : 'LEAVE';

  return StaffLeave.create({
    societyId: oid(societyId), staffId: oid(input.staffId), staffName: staff.person.name,
    from, to, kind, reason: input.reason, isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function cancelLeave(societyId: string, leaveId: string, actor: Actor) {
  const row = await StaffLeave.findOne({ _id: leaveId, societyId: oid(societyId) });
  if (!row) throw new StaffError('That absence could not be found.', 404);
  row.isActive = false;
  row.updatedBy = oid(actor.userId);
  row.updatedByName = actor.userName;
  await row.save();
  return row;
}

/** Everyone the office has recorded as away right now. One query, not one per person. */
async function awayNow(societyId: string, at: Date): Promise<Set<string>> {
  const rows = await StaffLeave.find({
    societyId: oid(societyId), isActive: true,
    from: { $lte: at }, to: { $gte: at },
  }).select('staffId').lean();
  return new Set(rows.map(r => String(r.staffId)));
}

/**
 * Who is on duty right now, out of a given set.
 *
 * **A person with no shift rows counts as available.** That is the load-bearing
 * default: most societies will never build a rota, and treating "no rota" as
 * "nobody is ever on duty" would send every complaint in those societies to the
 * unassigned queue overnight — a far bigger regression than the problem shifts
 * were added to solve.
 */
async function onDuty(societyId: string, staffIds: string[], at: Date): Promise<Set<string>> {
  if (!staffIds.length) return new Set();
  const shifts = await StaffShift.find({
    societyId: oid(societyId), isActive: true, staffId: { $in: staffIds.map(oid) },
  }).lean();

  const hasRota = new Set(shifts.map(s => String(s.staffId)));
  const covered = new Set(
    shifts.filter(s => shiftCovers(s, at)).map(s => String(s.staffId)),
  );
  return new Set(staffIds.filter(id => !hasRota.has(id) || covered.has(id)));
}

/** Is this one person both employed and here today? Used by the detail screen. */
export async function isAvailable(societyId: string, staffId: string, at = new Date()): Promise<boolean> {
  const staff = await SocietyStaff.findOne({ _id: staffId, societyId: oid(societyId), isActive: true })
    .select('_id').lean();
  if (!staff) return false;
  if ((await awayNow(societyId, at)).has(String(staffId))) return false;
  return (await onDuty(societyId, [String(staffId)], at)).has(String(staffId));
}

/**
 * How much open work each of these people is already carrying.
 *
 * One aggregate for the whole candidate set rather than a count per person —
 * routing runs on every complaint raised, and a query per candidate turns a
 * five-plumber society into five round trips for one ticket.
 */
async function openLoad(societyId: string, staffIds: string[]): Promise<Map<string, number>> {
  const load = new Map<string, number>(staffIds.map(id => [id, 0]));
  if (!staffIds.length) return load;
  const rows = await Complaint.aggregate([
    { $match: { societyId: oid(societyId), assigneeStaffId: { $in: staffIds.map(oid) }, status: OPEN_STATUSES } },
    { $group: { _id: '$assigneeStaffId', n: { $sum: 1 } } },
  ]);
  for (const r of rows) load.set(String(r._id), r.n);
  return load;
}

export type RoutingVia = 'BLOCK_PRIMARY' | 'BLOCK_BACKUP' | 'SOCIETY_WIDE' | 'LEAST_LOADED';

export interface RoutingMatch {
  staffId: string;
  staffName: string;
  rank: 'PRIMARY' | 'BACKUP';
  via: RoutingVia;
}

/**
 * Who should this piece of work go to?
 *
 * Four steps, in this order, and each one is the answer to a real failure:
 *
 *   1. **The wing's primary, if they are here.** What it always did — except it
 *      never checked "if they are here".
 *   2. **The wing's backup, if they are here.** The rank existed and was
 *      unreachable unless the primary row had been deleted outright. Cover for
 *      a fortnight's leave was the case it was invented for and the case it
 *      could not serve.
 *   3. **Society-wide cover, if they are here.** The gardener who does every
 *      wing.
 *   4. **The least-loaded eligible person, on shift or not.** Somebody whose
 *      shift ended at six is a better recipient of a seven-o'clock job than
 *      nobody at all — being off shift means "not their hour", where being on
 *      leave means genuinely absent, so leave is honoured at every step and
 *      shift is relaxed only here.
 *
 * Within EVERY step the least-loaded candidate wins, tie-broken by who was
 * assigned to the wing first so the answer is stable. That replaces
 * `.sort({ createdAt: 1 })`, under which the first plumber ever added received
 * every plumbing complaint the society would ever raise.
 *
 * Returning `null` is still a real answer, and the caller still parks the work
 * in the visible unassigned queue with a note. A complaint quietly given to the
 * wrong person is worse than one visibly given to nobody, because the second
 * gets noticed.
 */
export async function findAssignee(
  societyId: string, category: string, blockId?: string | null, at = new Date(),
): Promise<RoutingMatch | null> {
  const base = { societyId: oid(societyId), isActive: true, categories: category };

  // Every assignment that could conceivably take this work: this wing's rows,
  // plus whoever covers the whole society. Fetched once; the steps below are
  // filters over it rather than four more trips to the database.
  const candidates = await StaffAssignment.find({
    ...base,
    ...(blockId
      ? { $or: [{ scope: 'BLOCK', blockId: oid(blockId) }, { scope: 'SOCIETY' }] }
      : { scope: 'SOCIETY' }),
  }).sort({ createdAt: 1 }).lean();
  if (!candidates.length) return null;

  // An assignment can outlive the person — a stale row must never resurrect
  // somebody who has left, which is exactly what the old code guarded against
  // one document at a time.
  const employed = await SocietyStaff.find({
    _id: { $in: candidates.map(c => c.staffId) }, societyId: oid(societyId), isActive: true,
  }).select('person.name').lean();
  const nameOf = new Map(employed.map(s => [String(s._id), s.person.name]));

  const away = await awayNow(societyId, at);
  const live = candidates.filter(c => nameOf.has(String(c.staffId)) && !away.has(String(c.staffId)));
  if (!live.length) return null;

  const here = await onDuty(societyId, [...new Set(live.map(c => String(c.staffId)))], at);
  const load = await openLoad(societyId, [...new Set(live.map(c => String(c.staffId)))]);

  const pick = (rows: typeof live, via: RoutingVia): RoutingMatch | null => {
    if (!rows.length) return null;
    const best = rows.slice().sort((a, b) => {
      const d = (load.get(String(a.staffId)) ?? 0) - (load.get(String(b.staffId)) ?? 0);
      if (d !== 0) return d;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];
    return {
      staffId: String(best.staffId), staffName: nameOf.get(String(best.staffId))!,
      rank: best.rank, via,
    };
  };

  const inBlock = (r: typeof live[number]) => r.scope === 'BLOCK' && !!blockId && String(r.blockId) === String(blockId);
  const working = (r: typeof live[number]) => here.has(String(r.staffId));

  return pick(live.filter(r => inBlock(r) && r.rank === 'PRIMARY' && working(r)), 'BLOCK_PRIMARY')
    || pick(live.filter(r => inBlock(r) && r.rank === 'BACKUP' && working(r)), 'BLOCK_BACKUP')
    || pick(live.filter(r => r.scope === 'SOCIETY' && working(r)), 'SOCIETY_WIDE')
    || pick(live, 'LEAST_LOADED');
}

// ------------------------------------------------------------------ coverage

export interface CoverageCell {
  category: string;
  scopeKey: string;              // a block id, or 'SOCIETY'
  scopeLabel: string;
  primary: { staffId: string; staffName: string }[];
  backup: { staffId: string; staffName: string }[];
}

export interface CoverageMatrix {
  categories: string[];
  scopes: { key: string; label: string }[];
  cells: CoverageCell[];
  /** Category+wing pairs where a complaint would reach nobody. */
  gaps: { category: string; scopeKey: string; scopeLabel: string }[];
}

/**
 * Who covers what, laid out as a grid.
 *
 * `findAssignee` returns `null` when nothing matches and the caller parks the
 * complaint unassigned — correct behaviour, and completely silent. A committee
 * only discovers the hole when a lift complaint sits untouched for a week.
 *
 * This computes the same walk `findAssignee` does, for every category against
 * every wing, and names the empty squares. It is the answer to "why did nobody
 * get my complaint" before it is asked rather than after.
 *
 * Note the gap rule mirrors routing exactly: a wing is covered if it has its
 * own primary or backup, OR if somebody covers the whole society. Diverging
 * here would produce a grid that disagrees with what actually happens.
 */
export async function coverage(societyId: string): Promise<CoverageMatrix> {
  const [assignments, blocks, activeStaff] = await Promise.all([
    StaffAssignment.find({ societyId: oid(societyId), isActive: true }).lean(),
    Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
    SocietyStaff.find({ societyId: oid(societyId), isActive: true }).select('_id').lean(),
  ]);

  // An assignment can outlive the person. Routing skips those, so the grid must
  // too, or it shows cover that does not exist.
  const employed = new Set(activeStaff.map(s => String(s._id)));
  const live = assignments.filter(a => employed.has(String(a.staffId)));

  const scopes = [
    { key: 'SOCIETY', label: 'Whole society' },
    ...blocks.map(b => ({ key: String(b._id), label: b.name })),
  ];

  const cells: CoverageCell[] = [];
  const gaps: CoverageMatrix['gaps'] = [];

  for (const category of WORK_CATEGORIES) {
    const forCategory = live.filter(a => a.categories.includes(category));
    const societyWide = forCategory.filter(a => a.scope === 'SOCIETY');

    for (const scope of scopes) {
      const mine = scope.key === 'SOCIETY'
        ? societyWide
        : forCategory.filter(a => a.scope === 'BLOCK' && String(a.blockId) === scope.key);

      const cell: CoverageCell = {
        category, scopeKey: scope.key, scopeLabel: scope.label,
        primary: mine.filter(a => a.rank === 'PRIMARY').map(a => ({ staffId: String(a.staffId), staffName: a.staffName })),
        backup: mine.filter(a => a.rank === 'BACKUP').map(a => ({ staffId: String(a.staffId), staffName: a.staffName })),
      };
      cells.push(cell);

      const covered = cell.primary.length + cell.backup.length > 0
        || (scope.key !== 'SOCIETY' && societyWide.length > 0);
      if (!covered) gaps.push({ category, scopeKey: scope.key, scopeLabel: scope.label });
    }
  }

  return { categories: [...WORK_CATEGORIES], scopes, cells, gaps };
}

/**
 * Verifications that have lapsed or are about to.
 *
 * A police verification from three years ago reads exactly like one that never
 * happened. No competitor tracks the expiry; this is the whole reason the field
 * carries a date rather than a tick.
 */
export async function findExpiringVerifications(societyId: string, withinDays = 30, at = new Date()) {
  const horizon = new Date(at.getTime() + withinDays * 86_400_000);
  return SocietyStaff.find({
    societyId: oid(societyId),
    isActive: true,
    'verification.expiresOn': { $ne: null, $lte: horizon },
  }).select('staffCode person.name designation verification.expiresOn').sort({ 'verification.expiresOn': 1 }).lean();
}

/**
 * The caller `findExpiringVerifications` never had.
 *
 * The function shipped correct and had exactly ONE consumer: a passive banner
 * on the staff page, which somebody has to already be looking at. So the field
 * the model calls its differentiator — no competitor tracks a police
 * verification's expiry at all — did precisely nothing in production. A
 * verification that lapsed eighteen months ago sat there reading like one that
 * never happened, which is the failure the date was added to prevent.
 *
 * Deliberately the same shape as `sweepExpiringAmcs`, down to the dedupe:
 * `warnedForExpiry` holds the expiry already warned about, so the committee is
 * told ONCE per lapse instead of every night for thirty nights. A renewal
 * writes a new date, which clears the marker and re-arms the next warning.
 *
 * Lapsed verifications are included, not just upcoming ones: the AMC sweep can
 * bound itself at `at` because an expired contract is somebody else's problem
 * by then, whereas an already-lapsed police check is a guard standing at the
 * gate today with nothing behind his name.
 */
export async function sweepExpiringVerifications(societyId: string, at = new Date()): Promise<number> {
  const expiring = await SocietyStaff.find({
    societyId: oid(societyId), isActive: true,
    'verification.expiresOn': { $ne: null, $lte: new Date(at.getTime() + 30 * 86_400_000) },
    // Not already warned for THIS expiry date.
    $or: [
      { 'verification.warnedForExpiry': { $exists: false } },
      { $expr: { $ne: ['$verification.warnedForExpiry', '$verification.expiresOn'] } },
    ],
  }).lean();
  if (!expiring.length) return 0;

  const committee = await usersOfCommittee(societyId);
  for (const s of expiring) {
    const expiresOn = s.verification?.expiresOn;
    const lapsed = !!expiresOn && expiresOn < at;
    if (committee.length) {
      await notify({
        societyId, userIds: committee, kind: 'STAFF_VERIFICATION_EXPIRING',
        title: lapsed
          ? `Police verification has lapsed: ${s.person.name}`
          : `Police verification running out: ${s.person.name}`,
        body: `${s.person.name} (${s.staffCode})${s.designation ? ` — ${s.designation.replace(/_/g, ' ').toLowerCase()}` : ''}`
          + `, ${lapsed ? 'lapsed on' : 'valid until'} ${expiresOn?.toLocaleDateString('en-IN')}. `
          + 'A verification nobody renewed reads exactly like one that never happened.',
        link: '/dashboard/staff',
        entityType: 'SocietyStaff', entityId: String(s._id),
        emailIfUnreachable: true,
      }).catch(() => undefined);
    }
    await SocietyStaff.updateOne(
      { _id: s._id }, { $set: { 'verification.warnedForExpiry': expiresOn } },
    ).catch(() => undefined);
  }
  return expiring.length;
}

// ------------------------------------------------------------------ my work

export interface MyWork {
  staff: {
    _id: string; staffCode: string; name: string; designation: string;
    joinedOn: Date; hasPhoto: boolean;
  };
  /** Their open complaints, soonest promise first. */
  complaints: any[];
  assignments: { scope: string; blockName?: string; categories: string[]; rank: string }[];
  shifts: { weekday: number; from: string; to: string }[];
  /** The absence covering today, when there is one. */
  awayToday: { kind: string; kindLabel: string; from: Date; to: Date } | null;
  onDutyNow: boolean;
  verification: {
    expiresOn?: Date;
    /** 'NONE' | 'LAPSED' | 'EXPIRING' | 'VALID' — one word the page can read. */
    state: 'NONE' | 'LAPSED' | 'EXPIRING' | 'VALID';
  };
}

/**
 * Everything a staff member's own home screen needs, in one call.
 *
 * A `SOCIETY_EMPLOYEE` landing on `/dashboard` was shown the society-admin
 * dashboard, whose billing and subscription panels 403 for them and render as
 * empty boxes. So the first thing a guard saw of this product was three broken
 * cards and nothing about his own work.
 *
 * Deliberately NOT behind `STAFF_VIEW`: a guard holds no staff permission at
 * all, and this returns only their own record. It is scoped by `userId`, so
 * there is no id to tamper with.
 */
export async function myWork(societyId: string, userId: string, at = new Date()): Promise<MyWork> {
  const staff = await SocietyStaff.findOne({
    societyId: oid(societyId), userId: oid(userId), isActive: true,
  }).lean();
  if (!staff) {
    throw new StaffError(
      'You are not on this society\'s staff roll. Ask the society office to add you.', 404,
    );
  }

  const [complaints, assignments, shifts, leave] = await Promise.all([
    /**
     * Their own open work. `aboutStaffId` is excluded on principle rather than
     * because it can happen today: conduct complaints are never routed by
     * trade, so one about this person should never reach their queue — but the
     * day somebody assigns one by hand, the accused must not read it here.
     */
    Complaint.find({
      societyId: oid(societyId), assigneeStaffId: staff._id,
      status: OPEN_STATUSES,
      aboutStaffId: { $ne: staff._id },
    })
      .select('ticketCode title status priority flatLabel blockName firstResponseDueAt resolutionDueAt createdAt')
      .sort({ resolutionDueAt: 1 }).limit(100).lean(),
    StaffAssignment.find({ societyId: oid(societyId), staffId: staff._id, isActive: true })
      .select('scope blockName categories rank').lean(),
    StaffShift.find({ societyId: oid(societyId), staffId: staff._id, isActive: true })
      .select('weekday from to').sort({ weekday: 1, from: 1 }).lean(),
    StaffLeave.findOne({
      societyId: oid(societyId), staffId: staff._id, isActive: true,
      from: { $lte: at }, to: { $gte: at },
    }).lean(),
  ]);

  const expiresOn = staff.verification?.expiresOn;
  const state: MyWork['verification']['state'] = !expiresOn
    ? 'NONE'
    : expiresOn < at
      ? 'LAPSED'
      : expiresOn.getTime() - at.getTime() <= 30 * 86_400_000 ? 'EXPIRING' : 'VALID';

  return {
    staff: {
      _id: String(staff._id), staffCode: staff.staffCode, name: staff.person.name,
      designation: staff.designation, joinedOn: staff.joinedOn, hasPhoto: !!staff.person.photoKey,
    },
    complaints,
    assignments: assignments.map(a => ({
      scope: a.scope, blockName: a.blockName, categories: a.categories, rank: a.rank,
    })),
    shifts: shifts.map(s => ({ weekday: s.weekday, from: s.from, to: s.to })),
    awayToday: leave
      ? { kind: leave.kind, kindLabel: LEAVE_KIND_LABEL[leave.kind] || 'Away', from: leave.from, to: leave.to }
      : null,
    // Away beats on-shift: somebody the office has recorded as absent is not on
    // duty, whatever the rota says.
    onDutyNow: !leave && (await onDuty(societyId, [String(staff._id)], at)).has(String(staff._id)),
    verification: { expiresOn, state },
  };
}

// ------------------------------------------------------- agency bill checking

export interface AgencyHeadcount {
  vendorId: string;
  vendorName: string;
  active: number;
  leftThisMonth: number;
}

/**
 * How many people each agency actually has on site.
 *
 * This is the whole reason staff records are worth keeping without payroll:
 * when the agency bills for four guards, somebody has to be able to say the
 * roll shows three. Nothing else in the system can answer that.
 */
export async function agencyHeadcount(societyId: string, at = new Date()): Promise<AgencyHeadcount[]> {
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  const rows = await SocietyStaff.find({
    societyId: oid(societyId),
    employmentType: 'AGENCY',
    $or: [{ isActive: true }, { leftOn: { $gte: monthStart } }],
  }).select('vendorId vendorName isActive leftOn').lean();

  const byVendor = new Map<string, AgencyHeadcount>();
  for (const r of rows) {
    const key = String(r.vendorId || 'unknown');
    const row = byVendor.get(key) || {
      vendorId: key, vendorName: r.vendorName || 'Unknown agency', active: 0, leftThisMonth: 0,
    };
    if (r.isActive) row.active++;
    else if (r.leftOn && r.leftOn >= monthStart) row.leftThisMonth++;
    byVendor.set(key, row);
  }
  return [...byVendor.values()].sort((a, b) => b.active - a.active);
}
