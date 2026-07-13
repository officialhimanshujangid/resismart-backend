/**
 * Household engine: owner/admin-driven management of the people in a flat — family
 * members and tenants — with automatic timeline events, correct credential provisioning
 * (including data-only members and provision-on-contact-update), documents, and
 * active/inactive control. Builds on Resident (source of truth), identity.service
 * (passwordless provisioning), and FlatEvent (activity log).
 */
import mongoose from 'mongoose';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident, IResidentDocument } from '../models/resident.model';
import { FlatEvent, FlatEventType } from '../models/flat-event.model';
import { User } from '../models/user.model';
import { attachTenantMembership } from './identity.service';
import { assertVerified, consumeVerification } from './otp.service';
import EmailService from './email.service';
import { normalizePhone, isEmail } from '../utils/phone.util';
import { TenantType, UserRole } from '../constants/roles';

export interface Actor { userId: mongoose.Types.ObjectId; name: string; }

export interface PersonContact { name: string; email?: string; phone?: string; }

const audit = (actor: Actor) => ({
  createdBy: actor.userId, createdByName: actor.name, updatedBy: actor.userId, updatedByName: actor.name,
});

/** Append a flat activity-log entry. Shared by the household + lifecycle services. */
export const logFlatEvent = async (
  args: {
    flatId: mongoose.Types.ObjectId; societyId: mongoose.Types.ObjectId;
    type: FlatEventType; actor: Actor; summary: string;
    subject?: { userId?: mongoose.Types.ObjectId; residentId?: mongoose.Types.ObjectId; name?: string; relationship?: string };
    meta?: Record<string, any>; tenureId?: mongoose.Types.ObjectId;
  },
  session?: mongoose.ClientSession,
): Promise<void> => {
  await FlatEvent.create([{
    flatId: args.flatId, societyId: args.societyId, type: args.type,
    actor: { userId: args.actor.userId, name: args.actor.name },
    subject: args.subject || {}, summary: args.summary, meta: args.meta, tenureId: args.tenureId,
  }], session ? { session } : {});
};

const flatLabel = (flat: any) => `Flat ${flat.number}${flat.blockName ? `, ${flat.blockName}` : ''}`;

/**
 * Merged household roster for a flat — collapses the per-identity fan-out (email + phone
 * rows of one person) into a single member by exact name, unioning contacts/documents/flags.
 * Shared by the admin flat-detail endpoint and the resident "My Flat" portal.
 */
export const listHouseholdMembers = async (
  flatId: mongoose.Types.ObjectId | string,
  societyId: mongoose.Types.ObjectId | string,
): Promise<any[]> => {
  const rows = await Resident.find({
    flatId: new mongoose.Types.ObjectId(flatId.toString()),
    societyId: new mongoose.Types.ObjectId(societyId.toString()),
  }).populate('userId', 'name email phone').sort({ isHead: -1, isOwner: -1, createdAt: 1 }).lean();

  const byPerson = new Map<string, any>();
  for (const r of rows as any[]) {
    const u: any = r.userId && typeof r.userId === 'object' ? r.userId : null;
    const name = r.person?.name || u?.name || 'Resident';
    const key = name.trim().toLowerCase();
    const docs = (r.documents || []).map((d: any) => ({ _id: d._id, residentId: r._id, kind: d.kind, label: d.label, uploadedAt: d.uploadedAt }));
    const existing = byPerson.get(key);
    if (!existing) {
      byPerson.set(key, {
        _id: r._id, residentIds: [r._id], userId: u?._id || r.userId || null, name,
        email: r.person?.email || u?.email || null, phone: r.person?.phone || u?.phone || null,
        relationship: r.relationship, householdType: r.householdType || 'OWNER',
        isOwner: r.isOwner, isHead: r.isHead, isActive: r.isActive,
        loginStatus: r.userId ? 'LOGIN' : 'DATA_ONLY',
        moveInDate: r.moveInDate || null, moveOutDate: r.moveOutDate || null,
        documents: docs,
        emailVerifiedAt: r.person?.emailVerifiedAt || null, phoneVerifiedAt: r.person?.phoneVerifiedAt || null,
      });
    } else {
      existing.residentIds.push(r._id);
      existing.email = existing.email || r.person?.email || u?.email || null;
      existing.phone = existing.phone || r.person?.phone || u?.phone || null;
      existing.isOwner = existing.isOwner || r.isOwner;
      existing.isHead = existing.isHead || r.isHead;
      existing.isActive = existing.isActive || r.isActive;
      if (r.userId) { existing.loginStatus = 'LOGIN'; existing.userId = existing.userId || u?._id || null; existing._id = r._id; }
      existing.documents.push(...docs);
    }
  }
  return Array.from(byPerson.values());
};

/** Keep flat.residents in sync with the active Resident rows. */
const syncFlatResidents = async (flatId: mongoose.Types.ObjectId, session: mongoose.ClientSession) => {
  const active = await Resident.find({ flatId, isActive: true }).select('_id').session(session);
  await Flat.updateOne({ _id: flatId }, { $set: { residents: active.map((r) => r._id) } }, { session });
};

/** Map a household relationship to the society role granted on provisioning. */
const roleForRelationship = (relationship: string): UserRole =>
  relationship === 'TENANT' ? UserRole.RESIDENT_TENANT : UserRole.FAMILY_MEMBER;

/**
 * Verify OTP tokens for whichever contacts are present (decision: each person with a
 * contact must be OTP-verified). Throws 400 if a contact is present but not verified.
 * Returns which contacts were verified so callers can consume + stamp them.
 */
const verifyContacts = async (
  person: PersonContact,
  tokens: { emailToken?: string; phoneToken?: string },
) => {
  const out: { emailVerified?: boolean; phoneVerified?: boolean } = {};
  if (person.email && isEmail(person.email)) {
    const ok = tokens.emailToken && await assertVerified(tokens.emailToken, 'EMAIL', person.email, 'FLAT_REGISTRATION');
    if (!ok) throw Object.assign(new Error('Email must be verified with an OTP before adding this person'), { status: 400 });
    out.emailVerified = true;
  }
  if (person.phone && normalizePhone(person.phone)) {
    const ok = tokens.phoneToken && await assertVerified(tokens.phoneToken, 'PHONE', person.phone, 'FLAT_REGISTRATION');
    if (!ok) throw Object.assign(new Error('Phone must be verified with an OTP before adding this person'), { status: 400 });
    out.phoneVerified = true;
  }
  return out;
};

const consumeContacts = async (person: PersonContact, verified: { emailVerified?: boolean; phoneVerified?: boolean }) => {
  if (verified.emailVerified && person.email) await consumeVerification('EMAIL', person.email, 'FLAT_REGISTRATION');
  if (verified.phoneVerified && person.phone) await consumeVerification('PHONE', person.phone, 'FLAT_REGISTRATION');
};

/** Unset isHead on every active resident of the flat NOT in `keepUserIds` / `keepResidentIds`. */
const clearOtherHeads = async (
  flatId: mongoose.Types.ObjectId,
  keep: { userIds?: mongoose.Types.ObjectId[]; residentId?: mongoose.Types.ObjectId },
  actor: Actor, session: mongoose.ClientSession,
) => {
  const keepUserSet = new Set((keep.userIds || []).map((u) => u.toString()));
  const rows = await Resident.find({ flatId, isActive: true, isHead: true }).session(session);
  for (const r of rows) {
    const isKept = (keep.residentId && r._id.toString() === keep.residentId.toString())
      || (r.userId && keepUserSet.has(r.userId.toString()));
    if (isKept) continue;
    r.isHead = false; r.updatedBy = actor.userId; r.updatedByName = actor.name;
    await r.save({ session });
  }
};

/**
 * All Resident rows for the SAME person in a flat. A person with email+phone has two
 * identity-backed rows (one per login identity) sharing an identical `person` snapshot, so
 * they're grouped by exact person.name within the flat. Mutations apply to the whole group
 * so "the person" behaves as one entity despite the dual-login fan-out.
 */
const personRows = (resident: any, session: mongoose.ClientSession) =>
  Resident.find({ flatId: resident.flatId, 'person.name': resident.person?.name }).session(session);

export interface AddMemberInput {
  flatId: string;
  societyId: string;
  person: PersonContact;
  relationship: string;
  isHead?: boolean;
  moveInDate?: Date;
  householdType?: 'OWNER' | 'TENANT';
  emailToken?: string;
  phoneToken?: string;
}

/**
 * Add a family member or tenant to a flat. With a contact: OTP-verified → passwordless
 * identity provisioned + access email + MEMBER_ADDED/ACCESS_GRANTED events. Without a
 * contact: a data-only Resident (no userId) is created (MEMBER_ADDED only). Owner-initiated
 * adds are immediate (no approval loop) — the caller controls authorization.
 */
export const addMember = async (input: AddMemberInput, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(input.flatId);
  const sId = new mongoose.Types.ObjectId(input.societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const relationship = input.relationship;
  const isTenant = relationship === 'TENANT';
  const role = roleForRelationship(relationship);
  const householdType = input.householdType || (isTenant ? 'TENANT' : 'OWNER');
  const hasContact = !!(input.person.email || input.person.phone);

  const verified = hasContact ? await verifyContacts(input.person, input) : {};
  const now = new Date();
  const personSnap = {
    name: input.person.name,
    email: input.person.email?.toLowerCase().trim(),
    phone: input.person.phone,
    emailVerifiedAt: verified.emailVerified ? now : undefined,
    phoneVerifiedAt: verified.phoneVerified ? now : undefined,
  };

  const createdResidentIds: mongoose.Types.ObjectId[] = [];
  const identityIds: mongoose.Types.ObjectId[] = [];

  if (hasContact) {
    const identities = await attachTenantMembership({
      email: input.person.email, phone: input.person.phone, name: input.person.name,
      tenantType: TenantType.SOCIETY, tenantId: sId, role,
    }, session);
    const ids = [identities.emailUser?._id, identities.phoneUser?._id].filter(Boolean) as mongoose.Types.ObjectId[];
    identityIds.push(...ids);

    for (const uid of ids) {
      const existing = await Resident.findOne({ flatId: fId, userId: uid }).session(session);
      if (existing) {
        existing.isActive = true; existing.relationship = relationship;
        existing.householdType = householdType; existing.person = personSnap as any; existing.moveInDate = input.moveInDate || existing.moveInDate;
        existing.updatedBy = actor.userId; existing.updatedByName = actor.name;
        await existing.save({ session });
        createdResidentIds.push(existing._id as mongoose.Types.ObjectId);
      } else {
        const [r] = await Resident.create([{
          flatId: fId, societyId: sId, userId: uid, person: personSnap,
          relationship, householdType, isOwner: false, isHead: false, isActive: true,
          moveInDate: input.moveInDate, documents: [], ...audit(actor),
        }], { session });
        createdResidentIds.push(r._id as mongoose.Types.ObjectId);
      }
    }
  } else {
    // Data-only member — no login, no identity, no access email.
    const [r] = await Resident.create([{
      flatId: fId, societyId: sId, person: personSnap,
      relationship, householdType, isOwner: false, isHead: false, isActive: true,
      moveInDate: input.moveInDate, documents: [], ...audit(actor),
    }], { session });
    createdResidentIds.push(r._id as mongoose.Types.ObjectId);
  }

  // Head handling (single active head per flat).
  if (input.isHead) {
    await clearOtherHeads(fId, { userIds: identityIds, residentId: createdResidentIds[0] }, actor, session);
    await Resident.updateMany(
      { _id: { $in: createdResidentIds } },
      { $set: { isHead: true, updatedBy: actor.userId, updatedByName: actor.name } },
      { session },
    );
    if (identityIds[0]) await Flat.updateOne({ _id: fId }, { $set: { headOfFamily: identityIds[0] } }, { session });
  }

  // Renting via household add flips a vacant flat to rented; family adds don't change status.
  if (isTenant && flat.status === FlatStatus.VACANT) {
    await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.RENTED } }, { session });
  }

  await syncFlatResidents(fId, session);

  // Timeline events.
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'MEMBER_ADDED', actor,
    summary: `Added ${input.person.name} (${relationship.toLowerCase()})${input.isHead ? ' as head of household' : ''}`,
    subject: { userId: identityIds[0], residentId: createdResidentIds[0], name: input.person.name, relationship },
    meta: { dataOnly: !hasContact },
  }, session);

  if (hasContact) {
    // Access notification (passwordless) — reuse the existing branded email.
    if (input.person.email && isEmail(input.person.email)) {
      EmailService.sendTenantAccessEmail(input.person.email, flatLabel(flat), 'flat', [['Role', relationship]]);
    }
    await logFlatEvent({
      flatId: fId, societyId: sId, type: 'ACCESS_GRANTED', actor,
      summary: `Login access granted to ${input.person.name}`,
      subject: { userId: identityIds[0], residentId: createdResidentIds[0], name: input.person.name, relationship },
    }, session);
    await consumeContacts(input.person, verified);
  }

  return { residentIds: createdResidentIds, identityIds, dataOnly: !hasContact };
};

export interface UpdateMemberInput {
  relationship?: string;
  isActive?: boolean;
  moveInDate?: Date;
  moveOutDate?: Date;
  deactivatedReason?: string;
  // Adding a contact to a previously data-only member (each requires OTP).
  addEmail?: string;
  addPhone?: string;
  emailToken?: string;
  phoneToken?: string;
}

/**
 * Update a household member. Editing relationship/dates/active is straightforward. If a
 * contact is newly supplied for a data-only member, it must be OTP-verified, an identity is
 * provisioned (reconciling with any existing User for that identifier), the member gains a
 * login, and an access email is sent — logged as CONTACT_UPDATED + ACCESS_GRANTED.
 */
export const updateMember = async (residentId: string, input: UpdateMemberInput, actor: Actor, session: mongoose.ClientSession) => {
  const resident = await Resident.findById(residentId).session(session);
  if (!resident) throw Object.assign(new Error('Resident not found'), { status: 404 });
  const fId = resident.flatId as mongoose.Types.ObjectId;
  const sId = resident.societyId as mongoose.Types.ObjectId;
  const flat = await Flat.findById(fId).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const rows = await personRows(resident, session);
  const addingContact = !rows.some((r) => r.userId) && (!!input.addEmail || !!input.addPhone);
  const newRelationship = input.relationship || resident.relationship;
  const changes: string[] = [];

  // Apply simple field changes to every identity row for this person.
  for (const r of rows) {
    if (input.relationship) r.relationship = input.relationship;
    if (input.moveInDate !== undefined) r.moveInDate = input.moveInDate;
    if (input.moveOutDate !== undefined) r.moveOutDate = input.moveOutDate;
    if (input.isActive !== undefined) {
      r.isActive = input.isActive;
      if (!input.isActive) { r.isHead = false; r.deactivatedReason = input.deactivatedReason; r.moveOutDate = r.moveOutDate || new Date(); }
    }
    r.updatedBy = actor.userId; r.updatedByName = actor.name;
    await r.save({ session });
  }
  if (input.relationship) changes.push('relationship');
  if (input.moveInDate !== undefined) changes.push('move-in date');
  if (input.isActive !== undefined) changes.push(input.isActive ? 'reactivated' : 'deactivated');
  if (input.isActive === false) {
    for (const uid of rows.map((r) => r.userId).filter(Boolean) as mongoose.Types.ObjectId[]) await reconcileSocietyRole(uid, sId, session);
  }

  let grantedAccess = false;
  if (addingContact) {
    const person: PersonContact = { name: resident.person.name, email: input.addEmail, phone: input.addPhone };
    const verified = await verifyContacts(person, input);
    const role = roleForRelationship(newRelationship);
    const identities = await attachTenantMembership({
      email: input.addEmail, phone: input.addPhone, name: resident.person.name,
      tenantType: TenantType.SOCIETY, tenantId: sId, role,
    }, session);
    const ids = [identities.emailUser?._id, identities.phoneUser?._id].filter(Boolean) as mongoose.Types.ObjectId[];
    const personSnap = {
      name: resident.person.name,
      email: input.addEmail?.toLowerCase().trim(),
      phone: input.addPhone,
      emailVerifiedAt: verified.emailVerified ? new Date() : undefined,
      phoneVerifiedAt: verified.phoneVerified ? new Date() : undefined,
    };
    // Upgrade the existing data-only row for the first identity; create rows for any others
    // so BOTH logins (email + phone) resolve the flat.
    const dataOnlyRow = rows.find((r) => !r.userId) || resident;
    let idx = 0;
    for (const uid of ids) {
      let target = idx === 0 ? dataOnlyRow : await Resident.findOne({ flatId: fId, userId: uid }).session(session);
      if (!target) {
        target = new Resident({
          flatId: fId, societyId: sId, relationship: newRelationship, isOwner: false,
          isHead: resident.isHead, isActive: true, moveInDate: resident.moveInDate, documents: [], ...audit(actor),
        }) as any;
      }
      target!.userId = uid; target!.person = personSnap as any; target!.relationship = newRelationship;
      target!.isActive = true; target!.updatedBy = actor.userId; target!.updatedByName = actor.name;
      await target!.save({ session });
      idx++;
    }
    grantedAccess = true;
    if (input.addEmail && isEmail(input.addEmail)) {
      EmailService.sendTenantAccessEmail(input.addEmail, flatLabel(flat), 'flat', [['Role', newRelationship]]);
    }
    await consumeContacts(person, verified);
  }

  await syncFlatResidents(fId, session);

  await logFlatEvent({
    flatId: fId, societyId: sId, type: grantedAccess ? 'CONTACT_UPDATED' : 'MEMBER_UPDATED', actor,
    summary: grantedAccess
      ? `Added contact + login access for ${resident.person.name}`
      : `Updated ${resident.person.name}${changes.length ? ` (${changes.join(', ')})` : ''}`,
    subject: { userId: resident.userId as any, residentId: resident._id as any, name: resident.person.name, relationship: resident.relationship },
  }, session);
  if (grantedAccess) {
    await logFlatEvent({
      flatId: fId, societyId: sId, type: 'ACCESS_GRANTED', actor,
      summary: `Login access granted to ${resident.person.name}`,
      subject: { userId: resident.userId as any, residentId: resident._id as any, name: resident.person.name },
    }, session);
  }

  return { resident };
};

/** Make a resident the household head (single active head per flat). */
export const setHead = async (residentId: string, actor: Actor, session: mongoose.ClientSession) => {
  const resident = await Resident.findById(residentId).session(session);
  if (!resident) throw Object.assign(new Error('Resident not found'), { status: 404 });
  if (!resident.isActive) throw Object.assign(new Error('Cannot set an inactive member as head'), { status: 400 });
  const fId = resident.flatId as mongoose.Types.ObjectId;
  const sId = resident.societyId as mongoose.Types.ObjectId;

  // All Resident rows for the same person (email + phone identities) share head status.
  const rows = await personRows(resident, session);
  const keepIds = rows.map((r) => r._id as mongoose.Types.ObjectId);
  const keepUserIds = rows.map((r) => r.userId).filter(Boolean) as mongoose.Types.ObjectId[];

  await clearOtherHeads(fId, { userIds: keepUserIds, residentId: resident._id as any }, actor, session);
  await Resident.updateMany({ _id: { $in: keepIds } }, { $set: { isHead: true, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  if (keepUserIds[0]) await Flat.updateOne({ _id: fId }, { $set: { headOfFamily: keepUserIds[0] } }, { session });

  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'HEAD_CHANGED', actor,
    summary: `${resident.person.name} is now head of household`,
    subject: { userId: resident.userId as any, residentId: resident._id as any, name: resident.person.name, relationship: resident.relationship },
  }, session);

  return { resident };
};

/** Deactivate (soft-remove) a household member and reconcile their society role. */
export const deactivateMember = async (residentId: string, reason: string | undefined, actor: Actor, session: mongoose.ClientSession) => {
  const resident = await Resident.findById(residentId).session(session);
  if (!resident) throw Object.assign(new Error('Resident not found'), { status: 404 });
  if (resident.isOwner) throw Object.assign(new Error('Cannot remove the owner — use Sell/Transfer instead'), { status: 400 });
  const fId = resident.flatId as mongoose.Types.ObjectId;
  const sId = resident.societyId as mongoose.Types.ObjectId;

  // Deactivate every identity row for this person so both logins lose access.
  const rows = await personRows(resident, session);
  const affectedUsers: mongoose.Types.ObjectId[] = [];
  for (const r of rows) {
    r.isActive = false; r.isHead = false;
    r.deactivatedReason = reason; r.moveOutDate = r.moveOutDate || new Date();
    r.updatedBy = actor.userId; r.updatedByName = actor.name;
    await r.save({ session });
    if (r.userId) affectedUsers.push(r.userId as mongoose.Types.ObjectId);
  }
  for (const uid of affectedUsers) await reconcileSocietyRole(uid, sId, session);
  await syncFlatResidents(fId, session);

  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'MEMBER_REMOVED', actor,
    summary: `Removed ${resident.person.name} (${resident.relationship.toLowerCase()})`,
    subject: { userId: resident.userId as any, residentId: resident._id as any, name: resident.person.name, relationship: resident.relationship },
    meta: { reason },
  }, session);

  return { ok: true };
};

/** Attach a document to a resident (private S3 ref already uploaded by the caller). */
export const addDocument = async (residentId: string, doc: IResidentDocument, actor: Actor, session: mongoose.ClientSession) => {
  const resident = await Resident.findById(residentId).session(session);
  if (!resident) throw Object.assign(new Error('Resident not found'), { status: 404 });
  resident.documents.push(doc);
  resident.updatedBy = actor.userId; resident.updatedByName = actor.name;
  await resident.save({ session });

  await logFlatEvent({
    flatId: resident.flatId as any, societyId: resident.societyId as any, type: 'DOCUMENT_ADDED', actor,
    summary: `Added document "${doc.label}" for ${resident.person.name}`,
    subject: { userId: resident.userId as any, residentId: resident._id as any, name: resident.person.name },
  }, session);

  return { resident };
};

/**
 * Strip a stale resident society role (RESIDENT_OWNER/RESIDENT_TENANT/FAMILY_MEMBER) from a
 * user's memberships when no active Resident row in the society still backs it. Mirrors the
 * lifecycle service's reconcileMemberships but exported for the household paths.
 */
export const reconcileSocietyRole = async (
  userId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId, session: mongoose.ClientSession,
) => {
  const rows = await Resident.find({ userId, societyId, isActive: true }).session(session);
  const hasOwner = rows.some((r) => r.isOwner);
  const hasTenant = rows.some((r) => !r.isOwner && r.relationship === 'TENANT');
  const hasFamily = rows.some((r) => !r.isOwner && r.relationship !== 'TENANT');

  const user = await User.findById(userId).session(session);
  if (!user) return;
  const before = user.memberships.length;
  user.memberships = user.memberships.filter((m) => {
    if (m.tenantType !== TenantType.SOCIETY || m.tenantId.toString() !== societyId.toString()) return true;
    if (m.role === UserRole.RESIDENT_OWNER && !hasOwner) return false;
    if (m.role === UserRole.RESIDENT_TENANT && !hasTenant) return false;
    if (m.role === UserRole.FAMILY_MEMBER && !hasFamily) return false;
    return true;
  });
  if (user.memberships.length !== before) await user.save({ session });
};
