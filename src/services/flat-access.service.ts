import mongoose from 'mongoose';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { UserRole } from '../constants/roles';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class FlatAccessError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}

/**
 * May this person look at this flat's private side?
 *
 * **This exists because the answer was being decided in eleven places, and four
 * of them decided it wrong.** Household documents, tenancy papers, the resident
 * list, the ownership timeline and the flat lookup each checked "is this flat in
 * my society?" and stopped there — which let any tenant, family member, or the
 * gate guard pull every Aadhaar scan, every rent agreement and every sale price
 * in the building.
 *
 * A society check is a TENANT boundary. It is not an authorisation check, and
 * treating it as one is the single most expensive mistake in this codebase.
 *
 * The rule, in one place:
 *
 *   - **Admin** sees everything. Somebody has to be able to fix a broken flat.
 *   - **Committee** sees everything too — they run the society, collect its dues
 *     and answer to the registrar. But see `canSeeMoney` below.
 *   - **A resident** sees only flats they actually live in, and only the parts
 *     that belong to their own household. A tenant does not see the owner's
 *     purchase price; the owner's family does not see the tenant's lease terms.
 *   - **Everybody else — including SOCIETY_EMPLOYEE, which is the guard —
 *     sees nothing.** A guard needs to know a flat NUMBER to log a visitor.
 *     They do not need the residents' phone numbers, and every gate product
 *     that gave them one has leaked it.
 */
export interface FlatAccess {
  /** The flat exists in this society and the caller may see its private side at all. */
  canView: boolean;
  /** Owner-side papers: sale deed, purchase price, ownership timeline. */
  canSeeOwnerSide: boolean;
  /** Tenant-side papers: the lease, the rent, the deposit. */
  canSeeTenantSide: boolean;
  /** Rent and sale amounts. Committee yes; a tenant's family, no. */
  canSeeMoney: boolean;
  /** Which household the caller belongs to, when they are a resident of this flat. */
  household?: 'OWNER' | 'TENANT';
  isStaffSide: boolean;
}

const NONE: FlatAccess = {
  canView: false, canSeeOwnerSide: false, canSeeTenantSide: false,
  canSeeMoney: false, isStaffSide: false,
};

export interface Actor { userId: string; role: UserRole | string }

export async function flatAccess(societyId: string, flatId: string, actor: Actor): Promise<FlatAccess> {
  // The flat must belong to this society before anything else is considered.
  // A 404 rather than a 403 elsewhere: an id from another society should not
  // even confirm that it exists.
  const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) }).select('_id').lean();
  if (!flat) return NONE;

  if (actor.role === UserRole.SOCIETY_ADMIN || actor.role === UserRole.SOCIETY_COMMITTEE) {
    return {
      canView: true, canSeeOwnerSide: true, canSeeTenantSide: true,
      canSeeMoney: true, isStaffSide: true,
    };
  }

  // Deliberately NOT falling through to a resident check for staff. A
  // SOCIETY_EMPLOYEE who also happens to live here is handled below by their
  // Resident row — but their EMPLOYMENT grants them nothing on this screen.
  const resident = await Resident.findOne({
    societyId: oid(societyId), flatId: oid(flatId),
    userId: oid(actor.userId), isActive: true,
  }).select('householdType isOwner').lean();

  if (!resident) return NONE;

  const household = resident.householdType === 'TENANT' ? 'TENANT' : 'OWNER';
  return {
    canView: true,
    canSeeOwnerSide: household === 'OWNER',
    canSeeTenantSide: household === 'TENANT',
    // A tenant sees their own rent — they pay it. They do not see what the
    // owner paid for the flat, and the owner's household does not see the
    // tenant's deposit unless they are the owner themselves.
    canSeeMoney: household === 'OWNER' ? resident.isOwner === true : true,
    household,
    isStaffSide: false,
  };
}

/** Throwing form, for controllers that just need the door shut. */
export async function assertFlatAccess(
  societyId: string, flatId: string, actor: Actor,
  need: 'VIEW' | 'OWNER_SIDE' | 'TENANT_SIDE' = 'VIEW',
): Promise<FlatAccess> {
  const access = await flatAccess(societyId, flatId, actor);
  // One message for "does not exist" and "not yours" alike. Telling the two
  // apart lets somebody enumerate the building's flats.
  if (!access.canView) throw new FlatAccessError('That flat could not be found.', 404);

  if (need === 'OWNER_SIDE' && !access.canSeeOwnerSide) {
    throw new FlatAccessError('These papers belong to the owner of this flat.', 403);
  }
  if (need === 'TENANT_SIDE' && !access.canSeeTenantSide && !access.isStaffSide) {
    throw new FlatAccessError('These papers belong to the tenant of this flat.', 403);
  }
  return access;
}

/**
 * The same question for a RESIDENT record rather than a flat.
 *
 * Used by the household-document routes, which are handed a `residentId` and
 * have to work backwards to the flat before they can decide anything.
 */
export async function assertResidentAccess(
  societyId: string, residentId: string, actor: Actor,
): Promise<{ resident: any; access: FlatAccess }> {
  const resident = await Resident.findOne({
    _id: oid(residentId), societyId: oid(societyId),
  }).lean();
  if (!resident) throw new FlatAccessError('That person could not be found.', 404);

  const access = await flatAccess(societyId, String(resident.flatId), actor);
  if (!access.canView) throw new FlatAccessError('That person could not be found.', 404);

  // A person's own ID scans are theirs. Within a flat, the household boundary
  // still applies: the owner's family has no business reading the tenant's
  // Aadhaar, and vice versa.
  if (!access.isStaffSide) {
    const theirHousehold = resident.householdType === 'TENANT' ? 'TENANT' : 'OWNER';
    const isSelf = String(resident.userId || '') === String(actor.userId);
    if (!isSelf && theirHousehold !== access.household) {
      throw new FlatAccessError('These documents are not shared with you.', 403);
    }
  }

  return { resident, access };
}
