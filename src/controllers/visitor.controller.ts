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
      societyId, { code: req.body.code, payload: req.body.payload }, actorOf(req), { guardStaffId },
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
