import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as visitor from '../services/visitor.service';
import { VisitorError } from '../services/visitor.service';
import * as arrival from '../services/arrival.service';
import { SocietyStaff } from '../models/society-staff.model';
import * as opsPolicy from '../services/ops-policy.service';
import { OpsPolicyError, GATE_LEVELS, OPS_MODULE_CATALOG } from '../services/ops-policy.service';
import { GateError } from '../services/gate-crud.service';
import { resolveOpsSetup } from '../services/ops-setup.service';
import { VISITOR_CATEGORIES } from '../models/society-ops-policy.model';
import { Resident } from '../models/resident.model';
import { Flat } from '../models/flat.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { UserRole } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Guard'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof VisitorError) return res.status(e.status).json({ success: false, message: e.message });
  if (e instanceof OpsPolicyError) return res.status(400).json({ success: false, message: e.message });
  // Was missing, so every gate complaint — "that door does not record exits",
  // "that gate is unknown here" — came back as a 500 and the generic "Could not
  // record that exit". The guard was told the software broke when in fact they
  // had picked the wrong door, which is a thing they could have fixed in a
  // second had anybody told them.
  if (e instanceof GateError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

const RESIDENT_ROLES: string[] = [UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER];

/**
 * Which flats this person may see visitors for — or `undefined` for staff and
 * committee, who are not clamped.
 *
 * A resident gets their own flats and nothing else. This returns a list rather
 * than a boolean so a person living in two flats sees both, and so the empty
 * case is an empty list (meaning "nothing") rather than an absent filter
 * (meaning "everything"). That distinction is the whole safeguard.
 */
async function residentFlatIds(req: Request): Promise<string[] | undefined> {
  const role = String(req.user?.activeRole || '');
  if (!RESIDENT_ROLES.includes(role)) return undefined;

  const rows = await Resident.find({
    userId: oid(req.user!.userId),
    societyId: oid(req.user!.activeTenantId),
    isActive: true,
  }).select('flatId').lean();
  return rows.map(r => String(r.flatId));
}

/**
 * The gate console's ONE entry endpoint.
 *
 * Every arrival now goes through `arrival.arrive`, which asks the flat when the
 * policy says to and admits straight away when it does not. Before this the
 * console posted here and jumped straight to INSIDE, so approval — which the
 * society could switch on — did nothing at all.
 *
 * The guard's own staff record is stamped onto the entry, so "who was on the
 * gate at 11pm" is finally answerable.
 */
export const recordEntry = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const guardStaffId = await guardStaffIdOf(req);
    const result = await arrival.arrive(societyId, { ...req.body, guardStaffId }, actorOf(req));
    const entry = result.entry;

    auditFinance(req, 'VISITOR_ENTRY', 'VisitorEntry', String(entry._id), {
      newValues: { name: entry.visitorName, category: entry.category, flat: entry.flatLabel, outcome: result.outcome },
    });

    /**
     * The guard is told WHY, not just what.
     *
     * An admission used to read "Anil let in (V-0042)" whatever had happened
     * behind it — the reason was computed, returned by `arrive`, and thrown
     * away here. That matters most in exactly the case that prompted it: a
     * visitor for an empty flat is admitted on the GUARD's own judgement, and
     * a guard who is not told they are the one deciding cannot know they are
     * accountable for it.
     *
     * Only for a guard-made call. "No approval needed for this kind of
     * visitor" on every delivery is noise, and noise is what makes people stop
     * reading the line that matters.
     */
    const guardDecided = result.outcome === 'ADMITTED' && entry.admittedVia === 'GUARD';
    const message =
      result.outcome === 'AWAITING' ? `${entry.visitorName}: ${result.reason}`
      : result.outcome === 'LEFT_AT_GATE' ? `${entry.visitorName}: left at the gate`
      : guardDecided && /empty|nobody|no tenant/i.test(result.reason)
        ? `${entry.visitorName} let in (${entry.entryCode}) — ${result.reason}`
        : `${entry.visitorName} let in (${entry.entryCode})`;

    res.status(201).json({
      success: true,
      data: { ...entry.toObject(), _outcome: result.outcome, _reason: result.reason },
      message,
    });
  } catch (e: any) { fail(res, e, 'record that entry'); }
};

/** Scanning a pass at the gate: burn it and write the entry, atomically joined. */
export const scanEntry = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const guardStaffId = await guardStaffIdOf(req);
    const result = await arrival.arriveByPass(
      societyId, { code: req.body.code, payload: req.body.payload }, actorOf(req),
      // A pass carries no photograph, so a society that requires one could not
      // redeem a pass at all — the rule was unsatisfiable, not merely strict.
      // The guard supplies at the gate what the invitation could not carry.
      { guardStaffId, photoKey: req.body.photoKey, visitorPhone: req.body.visitorPhone },
    );
    auditFinance(req, 'VISITOR_ENTRY_PASS', 'VisitorEntry', String(result.entry._id), {
      newValues: { name: result.entry.visitorName, pass: String(result.entry.gatePassId) },
    });
    res.status(201).json({ success: true, data: result.entry, message: result.reason });
  } catch (e: any) { fail(res, e, 'check that pass'); }
};

/** The staff _id for the person on the gate, if they are on the roll. */
async function guardStaffIdOf(req: Request): Promise<string | undefined> {
  const post = await SocietyStaff.findOne({
    societyId: oid(String(req.user!.activeTenantId)),
    userId: oid(String(req.user!.userId)), isActive: true,
  }).select('_id').lean();
  return post ? String(post._id) : undefined;
}

export const recordExit = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const entry = await visitor.recordExit(societyId, req.params.id, actorOf(req), 'GUARD', req.body?.exitGateId);
    auditFinance(req, 'VISITOR_EXIT', 'VisitorEntry', String(entry._id));
    res.json({ success: true, data: entry, message: `${entry.visitorName} marked as gone` });
  } catch (e: any) { fail(res, e, 'record that exit'); }
};

/** The gate console's main list. */
export const inside = async (req: Request, res: Response) => {
  try {
    const rows = await visitor.whoIsInside(String(req.user!.activeTenantId), req.access);
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load who is inside'); }
};

export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await visitor.listEntries(societyId, req.query as any, {
      residentFlatIds: await residentFlatIds(req),
      // A clamped reader also sees the visits they were the HOST of. Without
      // this a committee member gets a push saying somebody has come to see
      // them, taps it, and lands on a log that does not contain the visit —
      // which is precisely the "alert about something you cannot see" that made
      // the vacant-flat notice read as a leak.
      hostUserId: String(req.user!.userId),
      access: req.access,
    });
    res.json({ success: true, ...data });
  } catch (e: any) { fail(res, e, 'load the gate log'); }
};

export const photo = async (req: Request, res: Response) => {
  try {
    const url = await visitor.photoUrl(
      String(req.user!.activeTenantId),
      req.params.id,
      req.query.which === 'vehicle' ? 'vehicle' : 'visitor',
      await residentFlatIds(req),
      req.access,
      String(req.user!.userId),
    );
    res.json({ success: true, data: { url } });
  } catch (e: any) { fail(res, e, 'open that photo'); }
};

/** Yesterday in one line — how much of the exit log a person actually recorded. */
export const reconciliation = async (req: Request, res: Response) => {
  try {
    const day = req.query.date ? new Date(String(req.query.date)) : new Date(Date.now() - 86_400_000);
    const data = await visitor.reconcileDay(String(req.user!.activeTenantId), day);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'build the reconciliation'); }
};

/** Flats, for the gate console's "who are they here to see" box. */
export const flatOptions = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const q = String(req.query.q || '').trim();
    const filter: any = { societyId: oid(societyId) };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ number: rx }, { blockName: rx }];
    }
    const rows = await Flat.find(filter).select('number blockName blockId').sort({ blockName: 1, number: 1 }).limit(40).lean();

    // Deliberately NOT the resident directory. A guard needs a flat to log a
    // visitor against; names and phone numbers are a different question, and
    // handing them over at the gate is how every incumbent leaks them.
    res.json({
      success: true,
      data: rows.map(f => ({
        _id: String(f._id),
        label: `${f.blockName || ''} ${f.number}`.trim(),
        blockId: f.blockId ? String(f.blockId) : undefined,
      })),
    });
  } catch (e: any) { fail(res, e, 'search flats'); }
};

/**
 * "Who are they here to see?" — flats AND people, in one box.
 *
 * The console could only ever offer a flat, which is why a visitor for the
 * secretary had nowhere to be filed and ended up notifying nobody. The guard
 * types a name; this returns the flats, the serving committee and the staff
 * roll that match, each already shaped as the host the entry will record.
 *
 * Deliberately NOT the resident directory, for the same reason `flatOptions`
 * is not: a committee seat and a staff post are public offices within the
 * society, and a household is not. No phone numbers, in either case.
 */
export const hostOptions = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const q = String(req.query.q || '').trim();
    const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    const flatFilter: any = { societyId: oid(societyId) };
    if (rx) flatFilter.$or = [{ number: rx }, { blockName: rx }];

    const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }, { _id: 1 }).lean();
    const memberFilter: any = { societyId: oid(societyId), status: 'ACTIVE', committeeId: term?._id };
    if (rx) memberFilter.$or = [{ 'memberSnapshot.name': rx }, { designationLabel: rx }];

    const staffFilter: any = { societyId: oid(societyId), isActive: true };
    if (rx) staffFilter.$or = [{ 'person.name': rx }, { designation: rx }];

    const [flats, members, staff] = await Promise.all([
      Flat.find(flatFilter).select('number blockName blockId').sort({ blockName: 1, number: 1 }).limit(25).lean(),
      term ? CommitteeMember.find(memberFilter).select('userId designationLabel memberSnapshot').limit(15).lean() : [],
      SocietyStaff.find(staffFilter).select('person.name designation').limit(15).lean(),
    ]);

    res.json({
      success: true,
      data: [
        ...flats.map(f => ({
          hostKind: 'FLAT' as const,
          flatId: String(f._id),
          blockId: f.blockId ? String(f.blockId) : undefined,
          label: `${f.blockName || ''} ${f.number}`.trim(),
        })),
        ...members.map(m => ({
          hostKind: 'COMMITTEE' as const,
          hostUserId: String(m.userId),
          label: `${m.designationLabel} — ${m.memberSnapshot?.name || 'Committee member'}`,
        })),
        ...staff.map(s => ({
          hostKind: 'STAFF' as const,
          hostStaffId: String(s._id),
          label: `${String(s.designation || 'Staff').toLowerCase().replace(/_/g, ' ')} — ${s.person?.name || 'Staff'}`,
        })),
        // Always offered, never searched for: somebody at the office window has
        // no name to type, and before this there was no way to log them at all.
        { hostKind: 'OFFICE' as const, label: 'Society office' },
      ],
    });
  } catch (e: any) { fail(res, e, 'search hosts'); }
};

// -------------------------------------------------------------------- policy

export const getPolicy = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const actor = actorOf(req);
    const [policy, modules] = await Promise.all([
      opsPolicy.getOrCreateOpsPolicy(societyId, actor.userId, actor.userName),
      opsPolicy.resolveOpsModules(societyId),
    ]);
    res.json({
      success: true,
      data: {
        policy,
        modules,
        catalog: OPS_MODULE_CATALOG,
        levels: GATE_LEVELS,
        categories: VISITOR_CATEGORIES,
      },
    });
  } catch (e: any) { fail(res, e, 'load gate settings'); }
};

/**
 * Just the list of switched-on modules — nothing else.
 *
 * The sidebar needs this for everybody, including residents and a guard who has
 * no business reading gate settings. Splitting it out means the menu can be
 * correct without handing the settings payload to people who cannot open it.
 */
export const getModules = async (req: Request, res: Response) => {
  try {
    const modules = await opsPolicy.resolveOpsModules(String(req.user!.activeTenantId));
    res.json({ success: true, data: { modules } });
  } catch (e: any) { fail(res, e, 'load modules'); }
};

/** The operations checklist — what is still unanswered before the gate is useful. */
export const setup = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await resolveOpsSetup(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'load the setup checklist'); }
};

export const updatePolicy = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const policy = await opsPolicy.updateOpsPolicy(societyId, req.body, actorOf(req));
    auditFinance(req, 'OPS_POLICY_UPDATE', 'SocietyOpsPolicy', societyId, {
      newValues: { level: policy.gate.level, modules: policy.modules },
    });
    res.json({ success: true, data: policy, message: 'Gate settings saved.' });
  } catch (e: any) { fail(res, e, 'save gate settings'); }
};

// --------------------------------------------------------------- duty roster
//
// The other half of `gate.vacantFlat.handler: 'DUTY_ROSTER'`. Kept on this
// route surface rather than a module of its own because the rota IS a gate
// setting — it exists only to answer "who is asked about that empty flat" — and
// a second settings screen for one table is how a society ends up with a
// handler selected and a rota nobody knew to fill in.

export const listDutyRoster = async (req: Request, res: Response) => {
  try {
    const rows = await opsPolicy.listDutyRoster(String(req.user!.activeTenantId), {
      blockId: req.query.blockId ? String(req.query.blockId) : undefined,
      weekday: req.query.weekday !== undefined ? Number(req.query.weekday) : undefined,
      includeRetired: req.query.all === 'true',
    });
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the duty roster'); }
};

export const addDutyRoster = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await opsPolicy.addDutyRosterEntry(societyId, req.body, actorOf(req));
    auditFinance(req, 'OPS_DUTY_ROSTER_ADDED', 'OpsDutyRoster', String(row._id), {
      newValues: { member: row.memberName, weekday: row.weekday, shift: row.shift, wing: row.blockName },
    });
    res.status(201).json({
      success: true, data: row,
      // Named out loud: the point of the rota is that somebody knows they are
      // the one who will be rung, and a bare "Saved." never conveys that.
      message: `${row.memberName} is on duty${row.blockName ? ` for ${row.blockName}` : ''} on ${WEEKDAYS[row.weekday]}.`,
    });
  } catch (e: any) { fail(res, e, 'add that duty entry'); }
};

export const updateDutyRoster = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await opsPolicy.updateDutyRosterEntry(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'OPS_DUTY_ROSTER_UPDATED', 'OpsDutyRoster', String(row._id), {
      newValues: { member: row.memberName, weekday: row.weekday, shift: row.shift, isActive: row.isActive },
    });
    res.json({ success: true, data: row, message: 'Saved.' });
  } catch (e: any) { fail(res, e, 'save that duty entry'); }
};

export const removeDutyRoster = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await opsPolicy.removeDutyRosterEntry(societyId, req.params.id, actorOf(req));
    auditFinance(req, 'OPS_DUTY_ROSTER_REMOVED', 'OpsDutyRoster', String(row._id), {
      newValues: { member: row.memberName, weekday: row.weekday, shift: row.shift },
    });
    // Said plainly, because an empty rota is not a broken one — the ladder falls
    // through to the next rung, and the admin should know what that means.
    res.json({
      success: true, data: row,
      message: `${row.memberName} is off the rota for ${WEEKDAYS[row.weekday]}. If nobody is left on duty, empty-flat callers go to whoever is next on your list.`,
    });
  } catch (e: any) { fail(res, e, 'remove that duty entry'); }
};

/** 0 = Sunday, matching `Date.prototype.getDay()` and the model. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
