/**
 * Society managing-committee engine (Indian CHS model). A society has at most one ACTIVE
 * committee term; members hold configurable office designations and, while ACTIVE, carry the
 * SOCIETY_COMMITTEE role (admin-lite). Members/terms are never hard-deleted — they go
 * INACTIVE/DISSOLVED with an end date, preserving committee history.
 */
import mongoose from 'mongoose';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { CommitteeDesignation, DEFAULT_DESIGNATIONS } from '../models/committee-designation.model';
import { Resident } from '../models/resident.model';
import { Flat } from '../models/flat.model';
import { User } from '../models/user.model';
import { TenantType, UserRole } from '../constants/roles';

export interface Actor { userId: mongoose.Types.ObjectId; name: string; }
const audit = (actor: Actor) => ({ createdBy: actor.userId, createdByName: actor.name, updatedBy: actor.userId, updatedByName: actor.name });
const oid = (v: string | mongoose.Types.ObjectId) => new mongoose.Types.ObjectId(v.toString());

// ── Role grant / reconcile ─────────────────────────────────────────────────
const grantCommitteeRole = async (userId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId, session: mongoose.ClientSession) => {
  const user = await User.findById(userId).session(session);
  if (!user) return;
  const exists = user.memberships.some((m) => m.tenantType === TenantType.SOCIETY && m.tenantId.toString() === societyId.toString() && m.role === UserRole.SOCIETY_COMMITTEE);
  if (!exists) { user.memberships.push({ tenantType: TenantType.SOCIETY, tenantId: societyId, role: UserRole.SOCIETY_COMMITTEE } as any); await user.save({ session }); }
};

/** Remove the SOCIETY_COMMITTEE role iff no ACTIVE committee seat still backs it. */
const reconcileCommitteeRole = async (userId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId, session: mongoose.ClientSession) => {
  // Read within the transaction so the just-saved INACTIVE status is visible.
  const stillSeated = await CommitteeMember.exists({ userId, societyId, status: 'ACTIVE' }).session(session);
  if (stillSeated) return;
  const user = await User.findById(userId).session(session);
  if (!user) return;
  const before = user.memberships.length;
  user.memberships = user.memberships.filter((m) => !(m.tenantType === TenantType.SOCIETY && m.tenantId.toString() === societyId.toString() && m.role === UserRole.SOCIETY_COMMITTEE));
  if (user.memberships.length !== before) await user.save({ session });
};

// ── Designations ────────────────────────────────────────────────────────────
export const seedDesignations = async (societyId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) => {
  const count = await CommitteeDesignation.countDocuments({ societyId }).session(session || null);
  if (count > 0) return;
  await CommitteeDesignation.insertMany(
    DEFAULT_DESIGNATIONS.map((d) => ({ societyId, ...d, isSystem: true, active: true })),
    session ? { session } : {},
  );
};

export const listDesignations = (societyId: string) =>
  CommitteeDesignation.find({ societyId: oid(societyId), active: true }).sort({ rank: 1 }).lean();

export const createDesignation = async (societyId: string, input: { label: string; rank?: number; isOfficeBearer?: boolean }) => {
  const key = input.label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'DESIGNATION';
  const existing = await CommitteeDesignation.findOne({ societyId: oid(societyId), key });
  if (existing) { existing.active = true; existing.label = input.label; if (input.rank !== undefined) existing.rank = input.rank; await existing.save(); return existing; }
  return CommitteeDesignation.create({ societyId: oid(societyId), key, label: input.label, rank: input.rank ?? 100, isOfficeBearer: !!input.isOfficeBearer, isSystem: false, active: true });
};

export const updateDesignation = async (id: string, societyId: string, input: { label?: string; rank?: number; isOfficeBearer?: boolean; active?: boolean }) => {
  const d = await CommitteeDesignation.findOne({ _id: id, societyId: oid(societyId) });
  if (!d) throw Object.assign(new Error('Designation not found'), { status: 404 });
  if (input.label !== undefined) d.label = input.label;
  if (input.rank !== undefined) d.rank = input.rank;
  if (input.isOfficeBearer !== undefined) d.isOfficeBearer = input.isOfficeBearer;
  if (input.active !== undefined) d.active = input.active;
  await d.save();
  return d;
};

// ── Committee term ────────────────────────────────────────────────────────────
export const getCurrentCommittee = async (societyId: string) => {
  const committee = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }).lean();
  if (!committee) return { committee: null, members: [] };
  const members = await CommitteeMember.find({ committeeId: committee._id, status: 'ACTIVE' })
    .sort({ isOfficeBearer: -1, createdAt: 1 }).lean();
  return { committee, members };
};

/** Start a new committee term. Any existing ACTIVE term is dissolved first (members ended + roles reconciled). */
export const startCommittee = async (
  societyId: string,
  input: { name: string; termStartDate: Date; termEndDate?: Date | null; electionDate?: Date | null; notes?: string },
  actor: Actor, session: mongoose.ClientSession,
) => {
  const sId = oid(societyId);
  await seedDesignations(sId, session);

  const currentActive = await Committee.findOne({ societyId: sId, status: 'ACTIVE' }).session(session);
  if (currentActive) await dissolveCommitteeDoc(currentActive._id as mongoose.Types.ObjectId, sId, actor, session);

  const [committee] = await Committee.create([{
    societyId: sId, name: input.name, termStartDate: input.termStartDate,
    termEndDate: input.termEndDate || null, electionDate: input.electionDate || null,
    status: 'ACTIVE', notes: input.notes, ...audit(actor),
  }], { session });
  return committee;
};

const dissolveCommitteeDoc = async (committeeId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId, actor: Actor, session: mongoose.ClientSession) => {
  const now = new Date();
  const members = await CommitteeMember.find({ committeeId, status: 'ACTIVE' }).session(session);
  for (const m of members) {
    m.status = 'INACTIVE'; m.endDate = now; m.updatedBy = actor.userId; m.updatedByName = actor.name;
    await m.save({ session });
  }
  await Committee.updateOne({ _id: committeeId }, { $set: { status: 'DISSOLVED', termEndDate: now, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  // Reconcile roles for everyone who was on it.
  for (const uid of Array.from(new Set(members.map((m) => m.userId.toString())))) {
    await reconcileCommitteeRole(oid(uid), societyId, session);
  }
};

export const dissolveCommittee = async (committeeId: string, societyId: string, actor: Actor, session: mongoose.ClientSession) => {
  const committee = await Committee.findOne({ _id: committeeId, societyId: oid(societyId) }).session(session);
  if (!committee) throw Object.assign(new Error('Committee not found'), { status: 404 });
  await dissolveCommitteeDoc(committee._id as mongoose.Types.ObjectId, oid(societyId), actor, session);
  return { ok: true };
};

// ── Members ────────────────────────────────────────────────────────────────
export const addCommitteeMember = async (
  committeeId: string, societyId: string,
  input: { userId: string; designationKey: string; appointment?: string; startDate?: Date; notes?: string },
  actor: Actor, session: mongoose.ClientSession,
) => {
  const sId = oid(societyId);
  const committee = await Committee.findOne({ _id: committeeId, societyId: sId, status: 'ACTIVE' }).session(session);
  if (!committee) throw Object.assign(new Error('No active committee — start a term first'), { status: 400 });

  // Eligibility: must be an active resident/owner of the society.
  const resident = await Resident.findOne({ userId: oid(input.userId), societyId: sId, isActive: true }).session(session);
  if (!resident) throw Object.assign(new Error('This person is not an active resident of the society'), { status: 400 });

  const already = await CommitteeMember.findOne({ committeeId: committee._id, userId: oid(input.userId), status: 'ACTIVE' }).session(session);
  if (already) throw Object.assign(new Error('This person is already on the committee'), { status: 400 });

  const designation = await CommitteeDesignation.findOne({ societyId: sId, key: input.designationKey, active: true }).session(session);
  if (!designation) throw Object.assign(new Error('Unknown designation'), { status: 400 });

  const flat = await Flat.findById(resident.flatId).select('number blockName').session(session).lean();
  const flatLabel = flat ? `${flat.number}${flat.blockName ? ` · ${flat.blockName}` : ''}` : undefined;

  const [member] = await CommitteeMember.create([{
    committeeId: committee._id, societyId: sId, userId: oid(input.userId), residentId: resident._id,
    memberSnapshot: { name: resident.person?.name || 'Member', flatLabel },
    designationKey: designation.key, designationLabel: designation.label, isOfficeBearer: designation.isOfficeBearer,
    appointment: (input.appointment as any) || 'ELECTED', startDate: input.startDate || new Date(),
    status: 'ACTIVE', notes: input.notes, ...audit(actor),
  }], { session });

  await grantCommitteeRole(oid(input.userId), sId, session);
  return member;
};

export const updateCommitteeMember = async (
  memberId: string, societyId: string,
  input: { designationKey?: string; appointment?: string; notes?: string; status?: 'ACTIVE' | 'INACTIVE' },
  actor: Actor, session: mongoose.ClientSession,
) => {
  const sId = oid(societyId);
  const member = await CommitteeMember.findOne({ _id: memberId, societyId: sId }).session(session);
  if (!member) throw Object.assign(new Error('Committee member not found'), { status: 404 });

  if (input.designationKey && input.designationKey !== member.designationKey) {
    const designation = await CommitteeDesignation.findOne({ societyId: sId, key: input.designationKey, active: true }).session(session);
    if (!designation) throw Object.assign(new Error('Unknown designation'), { status: 400 });
    member.designationKey = designation.key; member.designationLabel = designation.label; member.isOfficeBearer = designation.isOfficeBearer;
  }
  if (input.appointment) member.appointment = input.appointment as any;
  if (input.notes !== undefined) member.notes = input.notes;
  if (input.status && input.status !== member.status) {
    member.status = input.status;
    if (input.status === 'INACTIVE') member.endDate = new Date();
    else member.endDate = null;
  }
  member.updatedBy = actor.userId; member.updatedByName = actor.name;
  await member.save({ session });

  if (input.status === 'INACTIVE') await reconcileCommitteeRole(member.userId as mongoose.Types.ObjectId, sId, session);
  else if (input.status === 'ACTIVE') await grantCommitteeRole(member.userId as mongoose.Types.ObjectId, sId, session);
  return member;
};

export const endCommitteeMember = async (memberId: string, societyId: string, actor: Actor, session: mongoose.ClientSession) => {
  return updateCommitteeMember(memberId, societyId, { status: 'INACTIVE' }, actor, session);
};

export const getCommitteeHistory = async (societyId: string) => {
  const sId = oid(societyId);
  const committees = await Committee.find({ societyId: sId }).sort({ termStartDate: -1 }).lean();
  const members = await CommitteeMember.find({ societyId: sId }).sort({ createdAt: -1 }).lean();
  return committees.map((c) => ({ ...c, members: members.filter((m) => m.committeeId.toString() === c._id.toString()) }));
};

/** Active residents/owners eligible to be committee members (deduped per person by name). */
export const listEligibleMembers = async (societyId: string) => {
  const rows = await Resident.find({ societyId: oid(societyId), isActive: true, userId: { $ne: null } })
    .populate('userId', 'name').lean();
  const flatIds = Array.from(new Set(rows.map((r) => r.flatId?.toString()).filter(Boolean)));
  const flats = await Flat.find({ _id: { $in: flatIds } }).select('number blockName').lean();
  const flatMap = new Map(flats.map((f) => [f._id.toString(), `${f.number}${f.blockName ? ` · ${f.blockName}` : ''}`]));
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows as any[]) {
    const uid = r.userId?._id?.toString() || r.userId?.toString();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ userId: uid, name: r.person?.name || r.userId?.name || 'Resident', flatLabel: flatMap.get(r.flatId?.toString()) || '', relationship: r.relationship, isOwner: r.isOwner });
  }
  return out;
};
