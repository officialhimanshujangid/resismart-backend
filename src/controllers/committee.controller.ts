import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import * as committee from '../services/committee.service';
import {
  startCommitteeSchema, designationSchema, addCommitteeMemberSchema, updateCommitteeMemberSchema,
} from '../validators/committee.validator';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';

const actorOf = (req: Request): committee.Actor => ({
  userId: new mongoose.Types.ObjectId(req.user!.userId),
  name: req.user!.userName || 'user',
});

const logAudit = (req: Request, action: string, resourceId: string, values: any) => {
  AuditService.log({
    userId: req.user!.userId, userName: req.user!.userName || 'user', tenantId: req.user!.activeTenantId!,
    tenantType: TenantType.SOCIETY, action, resource: 'Committee', resourceId,
    ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: values,
  });
};

/** Run `op` inside a transaction and shape zod/status errors consistently. */
const runTx = async (
  req: Request, res: Response, next: NextFunction,
  op: (args: { societyId: string; actor: committee.Actor; session: mongoose.ClientSession }) => Promise<any>,
) => {
  const societyId = req.user?.activeTenantId;
  if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
  const session = await mongoose.startSession();
  try {
    let result: any;
    await session.withTransaction(async () => { result = await op({ societyId, actor: actorOf(req), session }); });
    res.status(200).json(result);
  } catch (error: any) {
    if (error?.name === 'ZodError') { res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid input' }); return; }
    if (error?.status) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  } finally {
    session.endSession();
  }
};

// ── Reads ────────────────────────────────────────────────────────────────────
export const getCommittee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const [current, designations] = await Promise.all([
      committee.getCurrentCommittee(societyId),
      committee.listDesignations(societyId),
    ]);
    res.status(200).json({ ...current, designations });
  } catch (error) { next(error); }
};

export const getDesignations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    res.status(200).json({ designations: await committee.listDesignations(societyId) });
  } catch (error) { next(error); }
};

export const getEligibleMembers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    res.status(200).json({ members: await committee.listEligibleMembers(societyId) });
  } catch (error) { next(error); }
};

export const getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    res.status(200).json({ terms: await committee.getCommitteeHistory(societyId) });
  } catch (error) { next(error); }
};

// ── Mutations (Society Admin only — enforced at the route) ───────────────────
export const startCommittee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = startCommitteeSchema.parse(req.body);
  await runTx(req, res, next, async ({ societyId, actor, session }) => {
    const c = await committee.startCommittee(societyId, parsed, actor, session);
    logAudit(req, 'COMMITTEE_START', c._id.toString(), { name: parsed.name });
    return { message: 'Committee term started', committee: c };
  });
};

export const dissolveCommittee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  await runTx(req, res, next, async ({ societyId, actor, session }) => {
    await committee.dissolveCommittee(req.params.id, societyId, actor, session);
    logAudit(req, 'COMMITTEE_DISSOLVE', req.params.id, {});
    return { message: 'Committee dissolved' };
  });
};

export const createDesignation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const parsed = designationSchema.parse(req.body);
    const d = await committee.createDesignation(societyId, parsed);
    res.status(201).json({ message: 'Designation created', designation: d });
  } catch (error: any) {
    if (error?.name === 'ZodError') { res.status(400).json({ error: error.errors?.[0]?.message }); return; }
    next(error);
  }
};

export const updateDesignation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const parsed = designationSchema.partial().parse(req.body);
    const d = await committee.updateDesignation(req.params.id, societyId, parsed);
    res.status(200).json({ message: 'Designation updated', designation: d });
  } catch (error: any) {
    if (error?.name === 'ZodError') { res.status(400).json({ error: error.errors?.[0]?.message }); return; }
    if (error?.status) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
};

export const addMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = addCommitteeMemberSchema.parse(req.body);
  await runTx(req, res, next, async ({ societyId, actor, session }) => {
    const m = await committee.addCommitteeMember(req.params.id, societyId, parsed, actor, session);
    logAudit(req, 'COMMITTEE_MEMBER_ADD', m._id.toString(), { userId: parsed.userId, designation: parsed.designationKey });
    return { message: 'Committee member added', member: m };
  });
};

export const updateMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = updateCommitteeMemberSchema.parse(req.body);
  await runTx(req, res, next, async ({ societyId, actor, session }) => {
    const m = await committee.updateCommitteeMember(req.params.memberId, societyId, parsed, actor, session);
    logAudit(req, 'COMMITTEE_MEMBER_UPDATE', req.params.memberId, parsed);
    return { message: 'Committee member updated', member: m };
  });
};

export const removeMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  await runTx(req, res, next, async ({ societyId, actor, session }) => {
    await committee.endCommitteeMember(req.params.memberId, societyId, actor, session);
    logAudit(req, 'COMMITTEE_MEMBER_END', req.params.memberId, {});
    return { message: 'Committee member removed' };
  });
};
