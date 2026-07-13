import mongoose from 'mongoose';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { FlatTenure, TenureType } from '../models/flat-tenure.model';
import { RentalAgreement } from '../models/rental.model';
import { User } from '../models/user.model';
import { attachTenantMembership } from './identity.service';
import { logFlatEvent } from './household.service';
import EmailService from './email.service';
import { isEmail } from '../utils/phone.util';
import { TenantType, UserRole } from '../constants/roles';

const flatLabel = (flat: any) => `Flat ${flat.number}${flat.blockName ? `, ${flat.blockName}` : ''}`;

export interface Actor { userId: mongoose.Types.ObjectId; name: string; }
export interface PersonInput { name: string; email?: string; phone?: string; relationship?: string; }

const audit = (actor: Actor) => ({
  createdBy: actor.userId, createdByName: actor.name, updatedBy: actor.userId, updatedByName: actor.name,
});

/** Close active tenures of the given types (sets endDate + ENDED). */
const endActiveTenures = async (
  flatId: mongoose.Types.ObjectId, types: TenureType[], endDate: Date, actor: Actor, session: mongoose.ClientSession
) => {
  await FlatTenure.updateMany(
    { flatId, type: { $in: types }, status: 'ACTIVE' },
    { $set: { status: 'ENDED', endDate, updatedBy: actor.userId, updatedByName: actor.name } },
    { session }
  );
};

/**
 * After Resident rows change, remove any resident role from a user's society memberships
 * that is no longer backed by an active Resident row (so a former tenant/owner loses the
 * role only when they hold it nowhere else in the society). Never touches admin/staff roles.
 */
const reconcileMemberships = async (
  userIds: mongoose.Types.ObjectId[], societyId: mongoose.Types.ObjectId, session: mongoose.ClientSession
) => {
  for (const uid of userIds) {
    const rows = await Resident.find({ userId: uid, societyId, isActive: true }).session(session);
    const hasOwner = rows.some((r) => r.isOwner);
    const hasTenant = rows.some((r) => !r.isOwner && r.relationship === 'TENANT');
    const hasFamily = rows.some((r) => !r.isOwner && r.relationship !== 'TENANT');

    const user = await User.findById(uid).session(session);
    if (!user) continue;
    const before = user.memberships.length;
    user.memberships = user.memberships.filter((m) => {
      if (m.tenantType !== TenantType.SOCIETY || m.tenantId.toString() !== societyId.toString()) return true;
      if (m.role === UserRole.RESIDENT_OWNER && !hasOwner) return false;
      if (m.role === UserRole.RESIDENT_TENANT && !hasTenant) return false;
      if (m.role === UserRole.FAMILY_MEMBER && !hasFamily) return false;
      return true;
    });
    if (user.memberships.length !== before) await user.save({ session });
  }
};

/** Deactivate (move out) Resident rows matching a predicate; stamps moveOutDate. Returns affected user ids. */
const deactivateResidents = async (
  flatId: mongoose.Types.ObjectId, predicate: (r: any) => boolean, actor: Actor, session: mongoose.ClientSession,
  moveOutDate?: Date,
) => {
  const rows = await Resident.find({ flatId, isActive: true }).session(session);
  const affected: mongoose.Types.ObjectId[] = [];
  for (const r of rows) {
    if (!predicate(r)) continue;
    r.isActive = false;
    r.isHead = false;
    r.moveOutDate = r.moveOutDate || moveOutDate || new Date();
    r.updatedBy = actor.userId;
    r.updatedByName = actor.name;
    await r.save({ session });
    if (r.userId) affected.push(r.userId as mongoose.Types.ObjectId);
  }
  return affected;
};

/**
 * Register a person on the flat with a role + Resident row(s); returns identity ids.
 * With a contact, provisions login identities (email + phone). Without any contact, creates
 * a single data-only Resident (no login). `householdType` tags them as OWNER or TENANT
 * household; `isHead` marks the household head; `moveInDate` stamps occupancy start.
 */
const registerPerson = async (
  flatId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId,
  person: PersonInput, role: UserRole, isOwner: boolean, actor: Actor, session: mongoose.ClientSession,
  opts: { householdType?: 'OWNER' | 'TENANT'; isHead?: boolean; moveInDate?: Date } = {},
) => {
  const householdType = opts.householdType || 'OWNER';
  const isHead = opts.isHead ?? isOwner;
  const hasContact = !!(person.email || person.phone);

  if (!hasContact) {
    // Data-only occupant (e.g. a tenant's child with no phone) — recorded, no login.
    await Resident.create([{
      flatId, societyId,
      person: { name: person.name },
      relationship: person.relationship || (isOwner ? 'OWNER' : 'OTHER'),
      isOwner, isHead, householdType, isActive: true, moveInDate: opts.moveInDate, documents: [], ...audit(actor),
    }], { session });
    return [];
  }

  const identities = await attachTenantMembership({
    email: person.email, phone: person.phone, name: person.name,
    tenantType: TenantType.SOCIETY, tenantId: societyId, role,
  }, session);
  const ids = [identities.emailUser?._id, identities.phoneUser?._id].filter(Boolean) as mongoose.Types.ObjectId[];

  for (const uid of ids) {
    const existing = await Resident.findOne({ flatId, userId: uid }).session(session);
    if (existing) {
      existing.isActive = true;
      existing.relationship = person.relationship || existing.relationship;
      existing.isOwner = isOwner || existing.isOwner;
      existing.householdType = householdType;
      existing.isHead = isHead || existing.isHead;
      if (opts.moveInDate) existing.moveInDate = opts.moveInDate;
      existing.updatedBy = actor.userId; existing.updatedByName = actor.name;
      await existing.save({ session });
    } else {
      await Resident.create([{
        flatId, societyId, userId: uid,
        person: { name: person.name, email: person.email?.toLowerCase().trim(), phone: person.phone },
        relationship: person.relationship || (isOwner ? 'OWNER' : 'OTHER'),
        isOwner, isHead, householdType, isActive: true, moveInDate: opts.moveInDate, documents: [], ...audit(actor),
      }], { session });
    }
  }
  return ids;
};

const syncFlatResidents = async (flatId: mongoose.Types.ObjectId, session: mongoose.ClientSession) => {
  const active = await Resident.find({ flatId, isActive: true }).select('_id').session(session);
  await Flat.updateOne({ _id: flatId }, { $set: { residents: active.map((r) => r._id) } }, { session });
};

// ─────────────────────────────── Transitions ───────────────────────────────

export interface TenancyDocInput { kind?: string; label: string; key: string; url: string; }
export interface TenantMemberInput extends PersonInput { isHead?: boolean; }
export interface RentOutInput {
  tenants: TenantMemberInput[]; // co-tenants (relationship TENANT) + tenant family members
  rentAmountPaise: number; securityDepositPaise: number;
  startDate: Date; endDate: Date;
  documents?: TenancyDocInput[]; // rental agreement, tenant KYC, police verification
}

/**
 * Rent the flat out to a tenant HOUSEHOLD — one or more co-tenants (relationship TENANT,
 * e.g. a family's head or a group of friends sharing) plus any family members. The OWNER
 * household (owner's family) moves out (owner stays as owner of record); every tenant-side
 * person is registered under the TENANT household with a move-in date, and a RentalAgreement
 * + TENANCY tenure + tenancy documents are created. Flat status → RENTED.
 */
export const rentOut = async (flatId: string, societyId: string, input: RentOutInput, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });
  if (!input.tenants.length) throw Object.assign(new Error('Add at least one tenant'), { status: 400 });

  const activeTenancy = await FlatTenure.findOne({ flatId: fId, type: 'TENANCY', status: 'ACTIVE' }).session(session);
  if (activeTenancy) throw Object.assign(new Error('Flat already has an active tenancy — end it before renting again'), { status: 400 });

  // The owner household vacates: owner's family moves out (owner of record persists), and
  // owner-occupancy ends. The flat is now occupied by the tenant household.
  const movedOut = await deactivateResidents(fId, (r) => r.householdType !== 'TENANT' && !r.isOwner, actor, session, input.startDate);
  await reconcileMemberships(movedOut, sId, session);
  await endActiveTenures(fId, ['OWNER_OCCUPANCY'], input.startDate, actor, session);

  // Determine the head (primary tenant): explicit isHead, else the first person.
  const headIdx = Math.max(0, input.tenants.findIndex((t) => t.isHead));
  const head = input.tenants[headIdx];

  let headIds: mongoose.Types.ObjectId[] = [];
  const occupantsList: Array<{ userId?: mongoose.Types.ObjectId; name: string; relationship: string }> = [];
  for (let i = 0; i < input.tenants.length; i++) {
    const t = input.tenants[i];
    const isHead = i === headIdx;
    // A co-tenant/friend or the head is a TENANT (RESIDENT_TENANT); a tenant's relative is FAMILY_MEMBER.
    const relationship = isHead ? 'TENANT' : (t.relationship || 'TENANT');
    const role = relationship === 'TENANT' ? UserRole.RESIDENT_TENANT : UserRole.FAMILY_MEMBER;
    const ids = await registerPerson(fId, sId, { name: t.name, email: t.email, phone: t.phone, relationship }, role, false, actor, session, { householdType: 'TENANT', isHead, moveInDate: input.startDate });
    if (isHead) headIds = ids;
    occupantsList.push(ids[0] ? { userId: ids[0], name: t.name, relationship } : { name: t.name, relationship });
    if (t.email && isEmail(t.email)) EmailService.sendTenantAccessEmail(t.email, flatLabel(flat), 'flat', [['Role', relationship === 'TENANT' ? 'TENANT' : relationship]]);
  }

  const [agreement] = await RentalAgreement.create([{
    flatId: fId, tenantId: headIds[0], societyId: sId,
    rentAmount: Math.round(input.rentAmountPaise / 100),
    securityDeposit: Math.round(input.securityDepositPaise / 100),
    startDate: input.startDate, endDate: input.endDate, isActive: true, ...audit(actor),
  }], { session });

  const tenancyDocs = (input.documents || []).map((d) => ({ kind: d.kind || 'OTHER', label: d.label, key: d.key, url: d.url, uploadedAt: new Date(), uploadedByName: actor.name }));
  const [tenure] = await FlatTenure.create([{
    flatId: fId, societyId: sId, type: 'TENANCY',
    party: { userId: headIds[0], name: head.name },
    occupants: occupantsList,
    startDate: input.startDate, endDate: null, status: 'ACTIVE', source: 'RENT',
    rentAmountPaise: input.rentAmountPaise, securityDepositPaise: input.securityDepositPaise,
    rentalAgreementId: agreement._id, documents: tenancyDocs, ...audit(actor),
  }], { session });

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.RENTED, updatedBy: actor.userId, updatedByName: actor.name } }, { session });

  const coTenants = input.tenants.filter((t) => (t === head ? true : (t.relationship || 'TENANT') === 'TENANT')).length;
  const summary = input.tenants.length === 1
    ? `Rented to ${head.name}`
    : `Rented to ${head.name} + ${input.tenants.length - 1} more (${coTenants} co-tenant${coTenants !== 1 ? 's' : ''})`;
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'RENTED', actor, tenureId: tenure._id as any,
    summary,
    subject: { userId: headIds[0], name: head.name, relationship: 'TENANT' },
    meta: { rentAmountPaise: input.rentAmountPaise, securityDepositPaise: input.securityDepositPaise, householdSize: input.tenants.length },
  }, session);
  return { tenure, agreement };
};

/**
 * End the active tenancy: the TENANT household moves out (move-out date stamped, tenancy
 * documents preserved on the now-ENDED tenure as history), the agreement closes, and the
 * flat becomes VACANT. The owner can then move back in (Owner Move In) or re-rent.
 */
export const endTenancy = async (flatId: string, societyId: string, endDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const tenancy = await FlatTenure.findOne({ flatId: fId, type: 'TENANCY', status: 'ACTIVE' }).session(session);
  if (!tenancy) throw Object.assign(new Error('No active tenancy to end'), { status: 400 });

  // Only the tenant household moves out — the owner household (owner of record) is untouched.
  const affected = await deactivateResidents(fId, (r) => r.householdType === 'TENANT', actor, session, endDate);
  await reconcileMemberships(affected, sId, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await endActiveTenures(fId, ['TENANCY'], endDate, actor, session);

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.VACANT, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'TENANCY_ENDED', actor, tenureId: tenancy._id as any,
    summary: `Tenancy ended — ${(tenancy.party as any)?.name || 'tenant'} moved out; flat is now vacant`,
    subject: { name: (tenancy.party as any)?.name, relationship: 'TENANT' },
    meta: { endDate },
  }, session);
  return { endedTenureId: tenancy._id, nextStatus: FlatStatus.VACANT };
};

export interface SellInput { buyer: PersonInput; saleAmountPaise?: number; saleDate: Date; }

/** Transfer ownership: end current ownership (+ any tenancy), register buyer as owner, open OWNERSHIP tenure. */
export const sellFlat = async (flatId: string, societyId: string, input: SellInput, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  // End current ownership + occupancy + any sitting tenancy.
  await endActiveTenures(fId, ['OWNERSHIP', 'OWNER_OCCUPANCY', 'TENANCY'], input.saleDate, actor, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate: input.saleDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });

  // Deactivate ALL current residents (old owner + any tenants) and clear ownership.
  const affected = await deactivateResidents(fId, () => true, actor, session);
  await reconcileMemberships(affected, sId, session);
  await Flat.updateOne({ _id: fId }, { $set: { ownerUserId: null, status: FlatStatus.VACANT } }, { session });

  // Register the buyer as the new owner.
  const buyerIds = await registerPerson(fId, sId, { ...input.buyer, relationship: 'OWNER' }, UserRole.RESIDENT_OWNER, true, actor, session);

  const [tenure] = await FlatTenure.create([{
    flatId: fId, societyId: sId, type: 'OWNERSHIP',
    party: { userId: buyerIds[0], name: input.buyer.name }, occupants: [],
    startDate: input.saleDate, endDate: null, status: 'ACTIVE', source: 'SALE',
    saleAmountPaise: input.saleAmountPaise, ...audit(actor),
  }], { session });

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { ownerUserId: buyerIds[0], status: FlatStatus.OWNER_OCCUPIED, updatedBy: actor.userId, updatedByName: actor.name } }, { session });

  if (input.buyer.email && isEmail(input.buyer.email)) {
    EmailService.sendTenantAccessEmail(input.buyer.email, flatLabel(flat), 'flat', [['Role', 'OWNER']]);
  }
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'OWNER_CHANGED', actor, tenureId: tenure._id as any,
    summary: `Ownership transferred to ${input.buyer.name}`,
    subject: { userId: buyerIds[0], name: input.buyer.name, relationship: 'OWNER' },
    meta: { saleAmountPaise: input.saleAmountPaise, saleDate: input.saleDate },
  }, session);
  return { tenure, buyerUserId: buyerIds[0] };
};

/** Owner moves in: end any tenancy, open OWNER_OCCUPANCY, status OWNER_OCCUPIED. */
export const moveIn = async (flatId: string, societyId: string, startDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });
  if (!flat.ownerUserId) throw Object.assign(new Error('Assign an owner before moving in'), { status: 400 });

  const affected = await deactivateResidents(fId, (r) => r.householdType === 'TENANT' || !r.isOwner, actor, session, startDate);
  await reconcileMemberships(affected, sId, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate: startDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await endActiveTenures(fId, ['TENANCY', 'OWNER_OCCUPANCY'], startDate, actor, session);

  const owner = await User.findById(flat.ownerUserId).select('name').session(session);
  const [tenure] = await FlatTenure.create([{
    flatId: fId, societyId: sId, type: 'OWNER_OCCUPANCY',
    party: { userId: flat.ownerUserId, name: owner?.name || 'Owner' }, occupants: [],
    startDate, endDate: null, status: 'ACTIVE', source: 'INITIAL', ...audit(actor),
  }], { session });

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.OWNER_OCCUPIED, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'OWNER_MOVED_IN', actor, tenureId: tenure._id as any,
    summary: `Owner ${owner?.name || ''} moved in`.trim(),
    subject: { userId: flat.ownerUserId as any, name: owner?.name, relationship: 'OWNER' },
    meta: { startDate },
  }, session);
  return { tenure };
};

/** Mark vacant (owner move-out): end active occupancy/tenancy, move out current occupants, keep ownership, status VACANT. */
export const setVacant = async (flatId: string, societyId: string, endDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const affected = await deactivateResidents(fId, (r) => !r.isOwner, actor, session, endDate);
  await reconcileMemberships(affected, sId, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await endActiveTenures(fId, ['TENANCY', 'OWNER_OCCUPANCY'], endDate, actor, session);

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.VACANT, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await logFlatEvent({
    flatId: fId, societyId: sId, type: 'MARKED_VACANT', actor,
    summary: 'Flat marked vacant', meta: { endDate },
  }, session);
  return { ok: true };
};
