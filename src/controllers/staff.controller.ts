import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as staff from '../services/staff.service';
import { StaffError } from '../services/staff.service';
import { STAFF_DESIGNATIONS } from '../models/society-staff.model';
import { WORK_CATEGORIES } from '../models/staff-assignment.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { AccessRole } from '../models/access-role.model';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Admin'),
  // Carried so the service can refuse to hand out access the caller does not
  // hold. `requirePermission` on every route in this file has already resolved
  // it, so this is a read, not a second lookup.
  access: req.access,
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof StaffError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

/** The list, plus everything the form needs — one request for the whole screen. */
export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [rows, blocks, vendors, roles] = await Promise.all([
      staff.listStaff(societyId, req.query),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
      Vendor.find({ societyId: oid(societyId), isActive: true }).select('name').sort({ name: 1 }).lean(),
      AccessRole.find({ societyId: oid(societyId), isActive: true, appliesTo: { $ne: 'COMMITTEE' } })
        .select('name').sort({ name: 1 }).lean(),
    ]);
    res.json({
      success: true,
      data: {
        staff: rows, blocks, vendors, roles,
        designations: STAFF_DESIGNATIONS,
        categories: WORK_CATEGORIES,
      },
    });
  } catch (e: any) { fail(res, e, 'load staff'); }
};

export const detail = async (req: Request, res: Response) => {
  try {
    const data = await staff.getStaff(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load that staff member'); }
};

export const create = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.createStaff(societyId, req.body, actorOf(req));
    auditFinance(req, 'STAFF_CREATE', 'SocietyStaff', String(row._id), {
      newValues: { name: row.person.name, designation: row.designation, type: row.employmentType },
    });
    res.status(201).json({ success: true, data: row, message: `${row.person.name} added as ${row.staffCode}` });
  } catch (e: any) { fail(res, e, 'add that staff member'); }
};

export const update = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.updateStaff(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'STAFF_UPDATE', 'SocietyStaff', String(row._id), { newValues: req.body });
    res.json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'update that staff member'); }
};

export const endEmployment = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const leftOn = req.body.leftOn ? new Date(req.body.leftOn) : new Date();
    const row = await staff.endEmployment(societyId, req.params.id, leftOn, actorOf(req), {
      handoverToStaffId: req.body.handoverToStaffId,
    });
    auditFinance(req, 'STAFF_END', 'SocietyStaff', String(row._id), { newValues: { leftOn } });
    res.json({ success: true, data: row, message: `${row.person.name} marked as left` });
  } catch (e: any) { fail(res, e, 'end that employment'); }
};

/**
 * Give a staff member a login.
 *
 * The generated password comes back in the response, because there is no SMS
 * gateway to send it through — the office reads it out. It is shown once and
 * never stored in plain text anywhere.
 */
export const provisionLogin = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const { staff: row, password } = await staff.provisionLogin(societyId, req.params.id, actorOf(req));
    auditFinance(req, 'STAFF_LOGIN_PROVISIONED', 'SocietyStaff', String(row._id), {
      newValues: { name: row.person.name },
    });
    res.json({
      success: true,
      data: { staff: row, password },
      message: password
        ? `Login created for ${row.person.name}. Password: ${password}`
        : `${row.person.name} can now sign in with their existing account.`,
    });
  } catch (e: any) { fail(res, e, 'create that login'); }
};

/**
 * Bring somebody back.
 *
 * Separate verb from create on purpose: the office is telling us this is the
 * SAME person, so their staff code, their papers and their police verification
 * come back with them instead of a second record starting from nothing.
 */
export const reinstate = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.reinstate(societyId, req.params.id, actorOf(req), {
      joinedOn: req.body.joinedOn ? new Date(req.body.joinedOn) : undefined,
    });
    auditFinance(req, 'STAFF_REINSTATE', 'SocietyStaff', String(row._id), {
      newValues: { name: row.person.name, joinedOn: row.joinedOn, earlierSpells: row.spells.length },
    });
    res.json({
      success: true, data: row,
      message: `${row.person.name} is back on the roll as ${row.staffCode}`,
    });
  } catch (e: any) { fail(res, e, 'bring them back onto the roll'); }
};

/** Take a login away from somebody who still works here. */
export const revokeLogin = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.revokeLogin(societyId, req.params.id, actorOf(req));
    auditFinance(req, 'STAFF_LOGIN_REVOKED', 'SocietyStaff', String(row._id), {
      newValues: { name: row.person.name },
    });
    res.json({
      success: true, data: row,
      message: `${row.person.name} can no longer sign in. They are still on the roll.`,
    });
  } catch (e: any) { fail(res, e, 'take that login away'); }
};

/** A fresh one-time password, shown once, for the office to hand over. */
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const { staff: row, password } = await staff.resetPassword(societyId, req.params.id, actorOf(req));
    // The password itself is never written to the audit trail — it is handed
    // over once and hashed everywhere it is stored.
    auditFinance(req, 'STAFF_PASSWORD_RESET', 'SocietyStaff', String(row._id), {
      newValues: { name: row.person.name },
    });
    res.json({
      success: true, data: { staff: row },
      message: `New password for ${row.person.name}: ${password}`,
    });
  } catch (e: any) { fail(res, e, 'reset that password'); }
};

// ------------------------------------------------------------------ papers

export const addDocument = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const doc = await staff.addDocument(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'STAFF_DOCUMENT_ADD', 'SocietyStaff', req.params.id, {
      newValues: { document: doc.name },
    });
    res.status(201).json({ success: true, data: doc, message: `${doc.name} filed` });
  } catch (e: any) { fail(res, e, 'file that document'); }
};

export const listDocuments = async (req: Request, res: Response) => {
  try {
    const data = await staff.listDocuments(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load their documents'); }
};

export const removeDocument = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const { name } = await staff.removeDocument(societyId, req.params.id, req.params.docId, actorOf(req));
    auditFinance(req, 'STAFF_DOCUMENT_REMOVE', 'SocietyStaff', req.params.id, { newValues: { document: name } });
    res.json({ success: true, message: `${name} removed` });
  } catch (e: any) { fail(res, e, 'remove that document'); }
};

/**
 * The three download routes.
 *
 * Each returns a short-lived signed URL rather than the bytes: the object stays
 * private in the bucket, the key never leaves the server, and the link stops
 * working five minutes later if it is forwarded.
 */
export const documentDownload = async (req: Request, res: Response) => {
  try {
    const url = await staff.documentDownloadUrl(String(req.user!.activeTenantId), req.params.id, req.params.docId);
    res.json({ success: true, data: { url } });
  } catch (e: any) { fail(res, e, 'open that document'); }
};

export const verificationDownload = async (req: Request, res: Response) => {
  try {
    const url = await staff.verificationDownloadUrl(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data: { url } });
  } catch (e: any) { fail(res, e, 'open that police verification'); }
};

export const photoDownload = async (req: Request, res: Response) => {
  try {
    const url = await staff.photoDownloadUrl(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data: { url } });
  } catch (e: any) { fail(res, e, 'open that photograph'); }
};

// -------------------------------------------------------------- rota, leave

export const setShift = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.setShift(societyId, { ...req.body, staffId: req.params.id }, actorOf(req));
    auditFinance(req, 'STAFF_SHIFT_SET', 'StaffShift', String(row._id), {
      newValues: { staff: row.staffName, weekday: row.weekday, from: row.from, to: row.to },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'save that shift'); }
};

export const removeShift = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.removeShift(societyId, req.params.shiftId, actorOf(req));
    auditFinance(req, 'STAFF_SHIFT_REMOVE', 'StaffShift', String(row._id));
    res.json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'remove that shift'); }
};

export const addLeave = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.addLeave(societyId, { ...req.body, staffId: req.params.id }, actorOf(req));
    auditFinance(req, 'STAFF_LEAVE_ADD', 'StaffLeave', String(row._id), {
      newValues: { staff: row.staffName, from: row.from, to: row.to, kind: row.kind },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'record that absence'); }
};

export const cancelLeave = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.cancelLeave(societyId, req.params.leaveId, actorOf(req));
    auditFinance(req, 'STAFF_LEAVE_CANCEL', 'StaffLeave', String(row._id));
    res.json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'cancel that absence'); }
};

/**
 * A staff member's own screen.
 *
 * No `STAFF_VIEW` on this route, and that is correct rather than an oversight:
 * a guard holds no staff permission at all, and requiring one would leave them
 * exactly where they were — on a society-admin dashboard whose panels 403.
 * The service scopes everything by the caller's own `userId`, so there is no id
 * to tamper with and nothing of anybody else's to reach.
 */
export const myWork = async (req: Request, res: Response) => {
  try {
    const data = await staff.myWork(String(req.user!.activeTenantId), String(req.user!.userId));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load your work'); }
};

export const assign = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.assign(societyId, req.body, actorOf(req));
    auditFinance(req, 'STAFF_ASSIGN', 'StaffAssignment', String(row._id), {
      newValues: { staff: row.staffName, wing: row.blockName || 'whole society', categories: row.categories },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'save that assignment'); }
};

export const unassign = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await staff.unassign(societyId, req.params.id, actorOf(req));
    auditFinance(req, 'STAFF_UNASSIGN', 'StaffAssignment', String(row._id));
    res.json({ success: true, data: row });
  } catch (e: any) { fail(res, e, 'remove that assignment'); }
};

/** Verifications lapsing soon, and what each agency actually has on site. */
/** Who covers what — and, more usefully, what nobody covers. */
export const coverage = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await staff.coverage(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'work out who covers what'); }
};

export const alerts = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [expiring, headcount] = await Promise.all([
      staff.findExpiringVerifications(societyId, Number(req.query.withinDays) || 30),
      staff.agencyHeadcount(societyId),
    ]);
    res.json({ success: true, data: { expiring, headcount } });
  } catch (e: any) { fail(res, e, 'load staff alerts'); }
};
