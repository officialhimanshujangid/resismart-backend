import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as complaints from '../services/complaint.service';
import { ComplaintError, ESCALATION_LADDER } from '../services/complaint.service';
import * as assets from '../services/asset.service';
import { AssetError } from '../services/asset.service';
import { PAUSE_REASONS } from '../models/complaint.model';
import { ASSET_CATEGORIES } from '../models/asset.model';
import { Resident } from '../models/resident.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { UserRole } from '../constants/roles';
import { allows } from '../services/access-role.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof ComplaintError || e instanceof AssetError) {
    return res.status(e.status).json({ success: false, message: e.message });
  }
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

const RESIDENT_ROLES: string[] = [UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER];

async function residentFlatIds(req: Request): Promise<string[] | undefined> {
  if (!RESIDENT_ROLES.includes(String(req.user?.activeRole || ''))) return undefined;
  const rows = await Resident.find({
    userId: oid(req.user!.userId), societyId: oid(req.user!.activeTenantId), isActive: true,
  }).select('flatId').lean();
  return rows.map(r => String(r.flatId));
}

/**
 * How much of the complaint list this reader gets.
 *
 * Three separate questions, resolved in one place so no handler answers one of
 * them differently: which flats, which wings, and whether conduct complaints
 * exist for them at all.
 */
async function readerOpts(req: Request): Promise<complaints.ListOpts> {
  const societyId = String(req.user!.activeTenantId);
  const access = req.access;
  const flats = await residentFlatIds(req);

  // Staff with only COMPLAINTS_OWN see their own queue and nothing else.
  let ownStaffId: string | undefined;
  let viewerStaffId: string | undefined;
  if (!flats) {
    const post = await SocietyStaff.findOne({
      societyId: oid(societyId), userId: oid(req.user!.userId), isActive: true,
    }).select('_id').lean();
    viewerStaffId = post ? String(post._id) : undefined;
    const canManage = access ? allows(access, 'COMPLAINTS_MANAGE', 'READ') : false;
    if (!canManage && post) ownStaffId = String(post._id);
  }

  return {
    residentFlatIds: flats,
    access,
    ownStaffId,
    viewerStaffId,
    canSeeConduct: access ? allows(access, 'COMPLAINTS_CONDUCT', 'READ') : false,
    // The three below turn this from a READ scope into an ACT scope. The same
    // object now answers both "what may I see?" and "what may I touch?", so
    // the two can never drift apart — which is exactly how a resident came to
    // be able to resolve a neighbour's complaint.
    userId: String(req.user!.userId),
    canManage: access ? allows(access, 'COMPLAINTS_MANAGE', 'FULL') : false,
    blockIds: access && !access.isAdmin && access.scope && !access.scope.allBlocks
      ? access.scope.blockIds
      : undefined,
  };
}

// ---------------------------------------------------------------- complaints

export const raise = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const c = await complaints.raise(societyId, req.body, actorOf(req));
    auditFinance(req, 'COMPLAINT_RAISE', 'Complaint', String(c._id), {
      newValues: { kind: c.kind, category: c.category, flat: c.flatLabel },
    });
    res.status(201).json({
      success: true, data: c,
      message: c.assigneeName
        ? `${c.ticketCode} raised and sent to ${c.assigneeName}`
        : `${c.ticketCode} raised — waiting to be assigned`,
    });
  } catch (e: any) { fail(res, e, 'raise that complaint'); }
};

export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await complaints.list(societyId, req.query, await readerOpts(req));
    res.json({ success: true, ...data });
  } catch (e: any) { fail(res, e, 'load complaints'); }
};

export const detail = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await complaints.detail(societyId, req.params.id, await readerOpts(req));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load that complaint'); }
};

/** Everything the "raise" form and the board need — categories, staff, wings. */
export const options = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const actor = actorOf(req);
    const [categories, staff, blocks, assetRows, stats] = await Promise.all([
      complaints.listCategories(societyId, actor.userId, actor.userName),
      SocietyStaff.find({ societyId: oid(societyId), isActive: true }).select('person.name designation').sort({ 'person.name': 1 }).lean(),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
      assets.listAssets(societyId),
      complaints.stats(societyId).catch(() => null),
    ]);
    res.json({
      success: true,
      data: {
        categories, staff, blocks, assets: assetRows, stats,
        pauseReasons: PAUSE_REASONS,
        escalation: ESCALATION_LADDER,
      },
    });
  } catch (e: any) { fail(res, e, 'load the form'); }
};

/**
 * Every action on one complaint goes through here, and every one of them now
 * receives the caller's scope.
 *
 * That scope is resolved ONCE, in `readerOpts`, and handed down — rather than
 * each action deciding for itself who is allowed to touch what. Eleven actions
 * deciding separately is how four of them ended up checking only the society.
 */
const act = (
  fn: (societyId: string, id: string, req: Request, opts: complaints.ListOpts) => Promise<any>,
  auditAction: string,
  what: string,
) => async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const c = await fn(societyId, req.params.id, req, await readerOpts(req));
    auditFinance(req, auditAction, 'Complaint', String(c._id));
    res.json({ success: true, data: c });
  } catch (e: any) { fail(res, e, what); }
};

export const assign = act(
  (s, id, req) => complaints.assignTo(s, id, req.body.staffId || null, actorOf(req)),
  'COMPLAINT_ASSIGN', 'assign that complaint');

export const respond = act(
  (s, id, req, o) => complaints.respond(s, id, req.body.note, actorOf(req), o),
  'COMPLAINT_RESPOND', 'record that reply');

export const pause = act(
  (s, id, req, o) => complaints.pause(s, id, req.body.reason, actorOf(req), o),
  'COMPLAINT_PAUSE', 'put that on hold');

export const resume = act(
  (s, id, req, o) => complaints.resume(s, id, actorOf(req), o),
  'COMPLAINT_RESUME', 'take that off hold');

export const workDone = act(
  (s, id, req, o) => complaints.markWorkDone(s, id, req.body.note, req.body.photoKeys || [], actorOf(req), o),
  'COMPLAINT_WORK_DONE', 'mark that as done');

export const resolve = act(
  (s, id, req, o) => complaints.resolve(s, id, actorOf(req), o),
  'COMPLAINT_RESOLVE', 'confirm that');

export const close = act(
  (s, id, req, o) => complaints.close(s, id, actorOf(req), o),
  'COMPLAINT_CLOSE', 'close that');

export const reopen = act(
  (s, id, req, o) => complaints.reopen(s, id, req.body.reason, actorOf(req), o),
  'COMPLAINT_REOPEN', 'reopen that');

export const meToo = act(
  (s, id, req, o) => complaints.meToo(s, id, actorOf(req), o),
  'COMPLAINT_ME_TOO', 'join that complaint');

export const rate = act(
  (s, id, req, o) => complaints.rate(s, id, Number(req.body.rating), req.body.feedback, actorOf(req), o),
  'COMPLAINT_RATE', 'record that rating');

export const escalations = async (req: Request, res: Response) => {
  try {
    const data = await complaints.findEscalations(String(req.user!.activeTenantId));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load escalations'); }
};

/** Manually escalate one complaint — a manager pushing it up before the sweep would. */
export const escalate = act(
  (s, id, req) => complaints.applyEscalation(s, id, Number(req.body.level), actorOf(req)),
  'COMPLAINT_ESCALATE', 'escalate that complaint');

// ------------------------------------------------------------- categories

export const listCategories = async (req: Request, res: Response) => {
  try {
    const data = await complaints.listAllCategories(String(req.user!.activeTenantId));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load categories'); }
};

export const saveCategory = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const cat = await complaints.saveCategory(societyId, req.body, actorOf(req), req.params.id);
    auditFinance(req, req.params.id ? 'COMPLAINT_CATEGORY_UPDATE' : 'COMPLAINT_CATEGORY_CREATE',
      'ComplaintCategory', String(cat._id), { newValues: { category: cat.category, sla: cat.resolutionMinutes } });
    res.json({ success: true, data: cat, message: 'Saved' });
  } catch (e: any) { fail(res, e, 'save that category'); }
};

// -------------------------------------------------------------------- assets

export const listAssets = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [rows, blocks, vendors, expiring] = await Promise.all([
      assets.listAssets(societyId, req.query),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
      Vendor.find({ societyId: oid(societyId), isActive: true }).select('name').sort({ name: 1 }).lean(),
      assets.findExpiringAmcs(societyId),
    ]);
    res.json({ success: true, data: { assets: rows, blocks, vendors, expiring, categories: ASSET_CATEGORIES } });
  } catch (e: any) { fail(res, e, 'load equipment'); }
};

export const createAsset = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const a = await assets.createAsset(societyId, req.body, actorOf(req));
    auditFinance(req, 'ASSET_CREATE', 'Asset', String(a._id), { newValues: { name: a.name, category: a.category } });
    res.status(201).json({ success: true, data: a });
  } catch (e: any) { fail(res, e, 'add that equipment'); }
};

export const updateAsset = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const a = await assets.updateAsset(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'ASSET_UPDATE', 'Asset', String(a._id));
    res.json({ success: true, data: a });
  } catch (e: any) { fail(res, e, 'update that equipment'); }
};

export const assetHistory = async (req: Request, res: Response) => {
  try {
    const data = await complaints.assetHistory(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load its history'); }
};

/**
 * Resolve a scanned sticker.
 *
 * Signed in, but NOT tied to one society by the token — the token itself names
 * the society, and the middleware then checks the caller belongs to it. A
 * resident of one society scanning another's lift gets nothing.
 */
export const scan = async (req: Request, res: Response) => {
  try {
    const result = await assets.resolveScan(String(req.params.token));
    if (result.societyId !== String(req.user!.activeTenantId)) {
      // Same wording as "not found": telling them it exists elsewhere is itself
      // a small leak of another society's equipment list.
      return res.status(404).json({ success: false, message: 'That sticker does not match any equipment.' });
    }
    res.json({ success: true, data: result });
  } catch (e: any) { fail(res, e, 'read that sticker'); }
};
