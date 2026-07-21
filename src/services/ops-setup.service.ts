import mongoose from 'mongoose';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Gate } from '../models/gate.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyStaff } from '../models/society-staff.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { Asset } from '../models/asset.model';
import { resolveOpsModules } from './ops-policy.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * Is this society's operations side actually set up?
 *
 * The finance module learned this the hard way: a society that starts recording
 * before it has said where it stands produces figures that are wrong from the
 * first day, and nobody notices for a year. Operations has the same shape — a
 * gate console with no gates records every visitor against nothing, a complaints
 * desk with no categories cannot route anything, and a staff roll with no logins
 * means every permission a committee sets is inert.
 *
 * **Deliberately gentler than the finance gate.** Finance refuses writes
 * outright, because a wrong opening balance is unfixable later. Here the worst
 * case is a slightly thinner record, and a society that has ALREADY been
 * logging visitors must never be locked out of its own gate by a checklist
 * shipped after the fact. So:
 *
 *   - `ready` says whether every relevant question is answered;
 *   - `blocking` is true ONLY for a society that has never recorded an entry.
 *
 * A society mid-use sees the checklist as advice. A brand-new one is stopped
 * before it can produce a register that means nothing.
 */

export interface SetupStep {
  key: string;
  /** The module this belongs to, or undefined for the gate itself. */
  module?: string;
  title: string;
  why: string;
  done: boolean;
  /** Where to go and answer it. */
  href: string;
  /** A step that is advice rather than a requirement. */
  optional?: boolean;
}

export interface OpsSetupState {
  ready: boolean;
  blocking: boolean;
  steps: SetupStep[];
  /** How many entries have ever been recorded — why `blocking` is what it is. */
  entriesEverRecorded: number;
}

export async function resolveOpsSetup(societyId: string): Promise<OpsSetupState> {
  const sid = oid(societyId);
  const modules = await resolveOpsModules(societyId);

  const [policy, gateCount, entryCount, staffCount, staffWithLogin, categoryCount, assetCount] =
    await Promise.all([
      SocietyOpsPolicy.findOne({ societyId: sid }).select('gate.exit').lean(),
      Gate.countDocuments({ societyId: sid, isActive: true }),
      VisitorEntry.countDocuments({ societyId: sid }),
      SocietyStaff.countDocuments({ societyId: sid, isActive: true }),
      SocietyStaff.countDocuments({ societyId: sid, isActive: true, userId: { $exists: true, $ne: null } }),
      ComplaintCategory.countDocuments({ societyId: sid, isActive: true }),
      Asset.countDocuments({ societyId: sid, isActive: true }),
    ]);

  const steps: SetupStep[] = [];

  if (modules.includes('GATE')) {
    steps.push({
      key: 'GATES', module: 'GATE',
      title: 'Name your gates',
      why: 'Until a gate exists, the register cannot say which door anybody came through — and a society with two entrances has no way to tell them apart afterwards.',
      done: gateCount > 0,
      href: '/dashboard/gate/gates',
    });
    steps.push({
      key: 'EXIT', module: 'GATE',
      title: 'Decide: arrivals only, or arrivals and departures',
      why: 'This shapes everything else — overstay alerts, "who is inside", the end-of-day close-off. A small society genuinely wants arrivals only, and that is a fine answer.',
      // The stamp, not the value: `trackExit` defaults to true, so its value
      // alone cannot tell a decision from a default.
      done: !!policy?.gate?.exit?.answeredAt,
      href: '/dashboard/gate/settings',
    });
    steps.push({
      key: 'GUARD_LOGIN', module: 'GATE',
      title: 'Give a guard a login',
      why: 'A staff member without a login holds no permissions at all, so the console stays shut to the very person it was built for.',
      done: staffWithLogin > 0,
      href: '/dashboard/staff',
      optional: !modules.includes('STAFF'),
    });
  }

  if (modules.includes('STAFF')) {
    steps.push({
      key: 'STAFF', module: 'STAFF',
      title: 'Add who works here',
      why: 'The roll is what lets you say the agency billed for four guards and three are on the list. Complaints also route to these people.',
      done: staffCount > 0,
      href: '/dashboard/staff',
    });
  }

  if (modules.includes('COMPLAINTS')) {
    steps.push({
      key: 'CATEGORIES', module: 'COMPLAINTS',
      title: 'Check the kinds of complaint and their promised times',
      why: 'Each category carries how fast you promise to reply and to fix. Without them nothing can be measured, and every complaint is late by no standard at all.',
      done: categoryCount > 0,
      href: '/dashboard/complaints/categories',
    });
    steps.push({
      key: 'COVERAGE', module: 'COMPLAINTS',
      title: 'Make sure somebody covers every kind of work',
      why: 'A complaint with nobody assigned waits in a queue nobody watches. This is the one gap that is completely silent.',
      done: staffCount > 0,
      href: '/dashboard/staff/coverage',
      optional: true,
    });
  }

  if (modules.includes('ASSETS')) {
    steps.push({
      key: 'ASSETS', module: 'ASSETS',
      title: 'List your lifts, pumps and tanks',
      why: 'A sticker on the machine turns "the lift is broken" into a complaint that already knows which lift, in which wing, and who maintains it.',
      done: assetCount > 0,
      href: '/dashboard/assets',
      optional: true,
    });
  }

  const required = steps.filter(s => !s.optional);
  const ready = required.every(s => s.done);

  return {
    ready,
    // Never lock out a society that is already using the gate. A checklist
    // shipped after the fact must not take away a register somebody depends on.
    blocking: !ready && entryCount === 0,
    steps,
    entriesEverRecorded: entryCount,
  };
}

/** Cheap form of the same question, for the middleware. */
export async function isOpsBlocked(societyId: string): Promise<boolean> {
  const sid = oid(societyId);
  const [entries, gates] = await Promise.all([
    VisitorEntry.countDocuments({ societyId: sid }),
    Gate.countDocuments({ societyId: sid, isActive: true }),
  ]);
  // Only the gate step is enforced, and only before the first entry ever. The
  // rest of the checklist is advice — refusing a complaint because nobody set
  // SLA times would punish the resident, not the committee.
  return entries === 0 && gates === 0;
}
