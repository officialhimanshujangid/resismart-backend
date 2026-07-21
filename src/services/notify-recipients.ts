import mongoose from 'mongoose';
import { Resident } from '../models/resident.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { logger } from '../utils/logger.util';

/**
 * Turning "the flat" or "whoever is handling this" into actual user ids.
 *
 * Kept in one file on purpose. The moment each caller works out its own
 * recipients, two of them disagree about whether a tenant counts, and the
 * resident who was left out never learns they were meant to be told. Every
 * resolver here returns a plain array of user id strings and **never throws** —
 * a lookup failure must degrade to "nobody was reachable", not break the
 * complaint or gate entry that was being recorded.
 *
 * Note what is missing: a user id is only produced where somebody has actually
 * signed up. A staff member recorded in the register but never given a login
 * has no `userId`, and cannot be notified — which is honest, and visible on
 * their row, rather than a message that silently goes nowhere.
 */

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/** Why a flat's audience came out the way it did. Recorded, so a gap is visible. */
export type HouseholdVia =
  | 'NO_FLAT'
  | 'VACANT_NO_HOUSEHOLD'
  | 'RENTED_TENANT_ONLY'
  | 'RENTED_NO_TENANT_REACHABLE'
  | 'OWNER_OCCUPIED';

export interface HouseholdAudience {
  userIds: string[];
  via: HouseholdVia;
}

/**
 * THE privacy boundary for anything that happens at a flat.
 *
 * There used to be two functions answering this question — `whoToAsk` in the
 * gate, which branched on `Flat.status`, and a `usersOfFlat` here, which did
 * not. Everything that ASKED was correct and everything that merely TOLD was
 * not, so a landlord who had not lived in the flat for three years was pushed
 * the name of every person who visited their tenant. Two audiences for one
 * event is the bug; the fix is that there is now only one, and `usersOfFlat`
 * is gone rather than deprecated so it cannot be reached for by habit.
 *
 * The rules, in the order they are applied:
 *
 * - **Vacant** — nobody lives there, so there is no household to tell. Returns
 *   empty rather than widening to the owner or the committee: who is
 *   *accountable* for an empty flat is a different question, answered once by
 *   `whoToAsk`, and answering it here as well is how a committee ends up
 *   notified twice about one visitor.
 * - **Rented** — the tenant household ONLY. Not the owner, not the owner's
 *   family. An owner who wants to know who visits their tenant is describing
 *   surveillance, not property management.
 * - **Owner-occupied** — the owner household.
 *
 * Never throws: a lookup failure degrades to "nobody was reachable", because a
 * visitor entry or a complaint must still be recorded when notification fails.
 */
export async function householdOfFlat(
  societyId: string, flatId: string | null | undefined,
): Promise<HouseholdAudience> {
  if (!flatId) return { userIds: [], via: 'NO_FLAT' };

  try {
    const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) })
      .select('status').lean();
    if (!flat) return { userIds: [], via: 'NO_FLAT' };

    if (flat.status === FlatStatus.VACANT) {
      return { userIds: [], via: 'VACANT_NO_HOUSEHOLD' };
    }

    // A person can only be told if they have a login. Somebody recorded in the
    // register with no contact details is not a silent failure — they are
    // simply not reachable, and that is visible on their row.
    const base = {
      societyId: oid(societyId), flatId: oid(flatId),
      isActive: true, userId: { $exists: true },
    };

    if (flat.status === FlatStatus.RENTED) {
      const tenants = await Resident.find({ ...base, householdType: 'TENANT' }, { userId: 1 }).lean();
      return tenants.length
        ? { userIds: tenants.map(t => String(t.userId)).filter(Boolean), via: 'RENTED_TENANT_ONLY' }
        // Marked rented with no reachable tenant on file. NOT a reason to fall
        // back to the owner — that would quietly re-open the hole this function
        // exists to close. The gap is recorded instead.
        : { userIds: [], via: 'RENTED_NO_TENANT_REACHABLE' };
    }

    const household = await Resident.find({ ...base, householdType: 'OWNER' }, { userId: 1 }).lean();
    return { userIds: household.map(r => String(r.userId)).filter(Boolean), via: 'OWNER_OCCUPIED' };
  } catch (e: any) {
    logger.error(`Could not resolve flat recipients: ${e.message}`);
    return { userIds: [], via: 'NO_FLAT' };
  }
}

/** The person a job is with, if they have a login. */
export async function userOfStaff(societyId: string, staffId: string): Promise<string[]> {
  try {
    const staff = await SocietyStaff.findOne(
      { _id: oid(staffId), societyId: oid(societyId), isActive: true },
      { userId: 1 },
    ).lean();
    return staff?.userId ? [String(staff.userId)] : [];
  } catch (e: any) {
    logger.error(`Could not resolve staff recipient: ${e.message}`);
    return [];
  }
}

/**
 * The serving committee — who to tell when something needs a decision rather
 * than a repair. Only currently-serving members: a former secretary should
 * stop being woken at 11pm the day their term ends.
 */
export async function usersOfCommittee(societyId: string): Promise<string[]> {
  try {
    // Two hops, and both matter. `Committee` is the TERM; `CommitteeMember` is
    // the people. Querying the term for user ids returns nothing at all — and
    // returns it silently, which is how a notification quietly reaches nobody.
    const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }, { _id: 1 }).lean();
    if (!term) return [];

    const rows = await CommitteeMember.find(
      { societyId: oid(societyId), committeeId: term._id, status: 'ACTIVE' },
      { userId: 1 },
    ).lean();
    return rows.map(r => String(r.userId)).filter(Boolean);
  } catch (e: any) {
    logger.error(`Could not resolve committee recipients: ${e.message}`);
    return [];
  }
}

/**
 * Remove one person from a list — almost always the one who just acted.
 *
 * Telling somebody about the thing they themselves did is the single most
 * common way a notification system trains people to ignore it.
 */
export function excluding(userIds: string[], exclude?: string | null): string[] {
  if (!exclude) return userIds;
  return userIds.filter(id => String(id) !== String(exclude));
}
