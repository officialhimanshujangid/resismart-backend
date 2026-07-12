import mongoose from 'mongoose';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { FlatTenure, TenureType } from '../models/flat-tenure.model';
import { RentalAgreement } from '../models/rental.model';
import { User } from '../models/user.model';
import { attachTenantMembership } from './identity.service';
import { TenantType, UserRole } from '../constants/roles';

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

/** Deactivate Resident rows on a flat matching a predicate; returns affected user ids. */
const deactivateResidents = async (
  flatId: mongoose.Types.ObjectId, predicate: (r: any) => boolean, actor: Actor, session: mongoose.ClientSession
) => {
  const rows = await Resident.find({ flatId, isActive: true }).session(session);
  const affected: mongoose.Types.ObjectId[] = [];
  for (const r of rows) {
    if (!predicate(r)) continue;
    r.isActive = false;
    r.updatedBy = actor.userId;
    r.updatedByName = actor.name;
    await r.save({ session });
    affected.push(r.userId as mongoose.Types.ObjectId);
  }
  return affected;
};

/** Register a person on the flat (both identities) with a role + Resident row; returns identity ids. */
const registerPerson = async (
  flatId: mongoose.Types.ObjectId, societyId: mongoose.Types.ObjectId,
  person: PersonInput, role: UserRole, isOwner: boolean, actor: Actor, session: mongoose.ClientSession
) => {
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
      existing.updatedBy = actor.userId; existing.updatedByName = actor.name;
      await existing.save({ session });
    } else {
      await Resident.create([{
        flatId, societyId, userId: uid,
        relationship: person.relationship || (isOwner ? 'OWNER' : 'OTHER'),
        isOwner, isActive: true, ...audit(actor),
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

export interface RentOutInput {
  tenant: PersonInput; occupants: PersonInput[];
  rentAmountPaise: number; securityDepositPaise: number;
  startDate: Date; endDate: Date;
}

/** Rent the flat out: create a RentalAgreement + TENANCY tenure, register tenant + household, status RENTED. */
export const rentOut = async (flatId: string, societyId: string, input: RentOutInput, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const activeTenancy = await FlatTenure.findOne({ flatId: fId, type: 'TENANCY', status: 'ACTIVE' }).session(session);
  if (activeTenancy) throw Object.assign(new Error('Flat already has an active tenancy — end it before renting again'), { status: 400 });

  // Owner vacates occupancy when renting out.
  await endActiveTenures(fId, ['OWNER_OCCUPANCY'], input.startDate, actor, session);

  const tenantIds = await registerPerson(fId, sId, { ...input.tenant, relationship: 'TENANT' }, UserRole.RESIDENT_TENANT, false, actor, session);
  for (const occ of input.occupants) {
    await registerPerson(fId, sId, { ...occ, relationship: occ.relationship || 'OTHER' }, UserRole.FAMILY_MEMBER, false, actor, session);
  }

  const [agreement] = await RentalAgreement.create([{
    flatId: fId, tenantId: tenantIds[0], societyId: sId,
    rentAmount: Math.round(input.rentAmountPaise / 100),
    securityDeposit: Math.round(input.securityDepositPaise / 100),
    startDate: input.startDate, endDate: input.endDate, isActive: true, ...audit(actor),
  }], { session });

  const occupantsList = [
    { userId: tenantIds[0], name: input.tenant.name, relationship: 'TENANT' },
    ...input.occupants.map((o) => ({ name: o.name, relationship: o.relationship || 'OTHER' })),
  ];
  const [tenure] = await FlatTenure.create([{
    flatId: fId, societyId: sId, type: 'TENANCY',
    party: { userId: tenantIds[0], name: input.tenant.name },
    occupants: occupantsList,
    startDate: input.startDate, endDate: null, status: 'ACTIVE', source: 'RENT',
    rentAmountPaise: input.rentAmountPaise, securityDepositPaise: input.securityDepositPaise,
    rentalAgreementId: agreement._id, ...audit(actor),
  }], { session });

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.RENTED, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  return { tenure, agreement };
};

/** End the active tenancy: close tenure + agreement, deactivate tenant/household, status OWNER_OCCUPIED/VACANT. */
export const endTenancy = async (flatId: string, societyId: string, endDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const tenancy = await FlatTenure.findOne({ flatId: fId, type: 'TENANCY', status: 'ACTIVE' }).session(session);
  if (!tenancy) throw Object.assign(new Error('No active tenancy to end'), { status: 400 });

  const affected = await deactivateResidents(fId, (r) => !r.isOwner, actor, session);
  await reconcileMemberships(affected, sId, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await endActiveTenures(fId, ['TENANCY'], endDate, actor, session);

  await syncFlatResidents(fId, session);
  const nextStatus = flat.ownerUserId ? FlatStatus.OWNER_OCCUPIED : FlatStatus.VACANT;
  await Flat.updateOne({ _id: fId }, { $set: { status: nextStatus, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  return { endedTenureId: tenancy._id, nextStatus };
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
  return { tenure, buyerUserId: buyerIds[0] };
};

/** Owner moves in: end any tenancy, open OWNER_OCCUPANCY, status OWNER_OCCUPIED. */
export const moveIn = async (flatId: string, societyId: string, startDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });
  if (!flat.ownerUserId) throw Object.assign(new Error('Assign an owner before moving in'), { status: 400 });

  const affected = await deactivateResidents(fId, (r) => !r.isOwner, actor, session);
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
  return { tenure };
};

/** Mark vacant: end active occupancy/tenancy, keep ownership, status VACANT. */
export const setVacant = async (flatId: string, societyId: string, endDate: Date, actor: Actor, session: mongoose.ClientSession) => {
  const fId = new mongoose.Types.ObjectId(flatId);
  const sId = new mongoose.Types.ObjectId(societyId);
  const flat = await Flat.findOne({ _id: fId, societyId: sId }).session(session);
  if (!flat) throw Object.assign(new Error('Flat not found'), { status: 404 });

  const affected = await deactivateResidents(fId, (r) => !r.isOwner, actor, session);
  await reconcileMemberships(affected, sId, session);
  await RentalAgreement.updateMany({ flatId: fId, isActive: true }, { $set: { isActive: false, endDate, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  await endActiveTenures(fId, ['TENANCY', 'OWNER_OCCUPANCY'], endDate, actor, session);

  await syncFlatResidents(fId, session);
  await Flat.updateOne({ _id: fId }, { $set: { status: FlatStatus.VACANT, updatedBy: actor.userId, updatedByName: actor.name } }, { session });
  return { ok: true };
};
