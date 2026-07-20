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
    const row = await staff.endEmployment(societyId, req.params.id, leftOn, actorOf(req));
    auditFinance(req, 'STAFF_END', 'SocietyStaff', String(row._id), { newValues: { leftOn } });
    res.json({ success: true, data: row, message: `${row.person.name} marked as left` });
  } catch (e: any) { fail(res, e, 'end that employment'); }
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
