import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as visitor from '../services/visitor.service';
import { VisitorError } from '../services/visitor.service';
import * as opsPolicy from '../services/ops-policy.service';
import { OpsPolicyError, GATE_LEVELS, OPS_MODULE_CATALOG } from '../services/ops-policy.service';
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

export const recordEntry = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const entry = await visitor.recordEntry(societyId, req.body, actorOf(req));
    auditFinance(req, 'VISITOR_ENTRY', 'VisitorEntry', String(entry._id), {
      newValues: { name: entry.visitorName, category: entry.category, flat: entry.flatLabel },
    });
    res.status(201).json({ success: true, data: entry, message: `${entry.visitorName} logged in as ${entry.entryCode}` });
  } catch (e: any) { fail(res, e, 'record that entry'); }
};

export const recordExit = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const entry = await visitor.recordExit(societyId, req.params.id, actorOf(req));
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
