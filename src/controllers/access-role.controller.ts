import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as svc from '../services/access-role.service';
import { AccessError, MODULE_CATALOG } from '../services/access-role.service';
import { Block } from '../models/block.model';
import { CommitteeMember } from '../models/committee-member.model';
import { UserRole } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Admin'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof AccessError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

/** Roles, the module catalogue, and this society's wings — one call for the editor. */
export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const actor = actorOf(req);
    const [roles, blocks] = await Promise.all([
      svc.listRoles(societyId, actor.userId, actor.userName),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.json({ success: true, data: { roles, catalog: MODULE_CATALOG, blocks } });
  } catch (e: any) { fail(res, e, 'load roles'); }
};

export const create = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const role = await svc.createRole(societyId, req.body, actorOf(req));
    auditFinance(req, 'ACCESS_ROLE_CREATE', 'AccessRole', String(role._id), {
      newValues: { name: role.name, appliesTo: role.appliesTo },
    });
    res.status(201).json({ success: true, data: role });
  } catch (e: any) { fail(res, e, 'create that role'); }
};

export const update = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const role = await svc.updateRole(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'ACCESS_ROLE_UPDATE', 'AccessRole', String(role._id), {
      newValues: { name: role.name, permissions: role.permissions, scope: role.scope },
    });
    res.json({ success: true, data: role });
  } catch (e: any) { fail(res, e, 'update that role'); }
};

export const remove = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    await svc.deleteRole(societyId, req.params.id);
    auditFinance(req, 'ACCESS_ROLE_DELETE', 'AccessRole', req.params.id);
    res.json({ success: true, message: 'Role deleted.' });
  } catch (e: any) { fail(res, e, 'delete that role'); }
};

/** Give a committee member a role — or take it away. */
export const assignToMember = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const member = await svc.setCommitteeMemberRole(
      societyId, req.params.memberId, req.body.accessRoleId || null, actorOf(req),
    );
    auditFinance(req, 'ACCESS_ROLE_ASSIGN', 'CommitteeMember', String(member._id), {
      newValues: { accessRoleId: req.body.accessRoleId || null, member: member.memberSnapshot?.name },
    });
    res.json({ success: true, data: member });
  } catch (e: any) { fail(res, e, 'assign that role'); }
};

/**
 * What the signed-in person may do. Read by the sidebar and by screens that
 * grey out a button rather than hide it.
 *
 * This is a convenience for the UI, NOT the boundary — every route enforces its
 * own permission. Filtering a menu is not security.
 */
export const mine = async (req: Request, res: Response) => {
  try {
    const access = await svc.resolveAccess(
      String(req.user!.activeTenantId),
      String(req.user!.userId),
      req.user!.activeRole as UserRole,
    );
    res.json({ success: true, data: access });
  } catch (e: any) { fail(res, e, 'load your permissions'); }
};

/** Committee members with their current role, for the assignment screen. */
export const members = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const rows = await CommitteeMember.find({ societyId: oid(societyId), status: 'ACTIVE' })
      .populate('accessRoleId', 'name appliesTo isActive')
      .select('memberSnapshot designationLabel isOfficeBearer accessRoleId')
      .sort({ isOfficeBearer: -1 })
      .lean();
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load committee members'); }
};
