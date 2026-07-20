import mongoose from 'mongoose';
import { Resident } from '../models/resident.model';
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

/** Everyone living in a flat — owner, tenant and family alike. */
export async function usersOfFlat(societyId: string, flatId: string): Promise<string[]> {
  try {
    const rows = await Resident.find(
      { societyId: oid(societyId), flatId: oid(flatId), isActive: true, userId: { $exists: true } },
      { userId: 1 },
    ).lean();
    return rows.map(r => String(r.userId)).filter(Boolean);
  } catch (e: any) {
    logger.error(`Could not resolve flat recipients: ${e.message}`);
    return [];
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
