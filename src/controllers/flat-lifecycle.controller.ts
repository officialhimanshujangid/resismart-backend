import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Flat } from '../models/flat.model';
import { FlatTenure } from '../models/flat-tenure.model';
import { rentOutSchema, sellSchema, dateActionSchema, historicalTenureSchema, updateTenureSchema } from '../validators/flat-lifecycle.validator';
import * as lifecycle from '../services/flat-lifecycle.service';
import { AuditService } from '../services/audit.service';
import { TenantType, UserRole } from '../constants/roles';

const toPaise = (rupees?: number) => (rupees === undefined ? undefined : Math.round(rupees * 100));

/** Society admins/committee manage any flat; a flat owner manages only their own flat. */
const assertManageAccess = (req: Request, flat: any): string | null => {
  const role = req.user?.activeRole;
  if (role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE) return null;
  if (role === UserRole.RESIDENT_OWNER && flat.ownerUserId && flat.ownerUserId.toString() === req.user?.userId) return null;
  return 'You are not allowed to manage this flat';
};

const logLifecycle = (req: Request, action: string, flatId: string, values: any) => {
  AuditService.log({
    userId: req.user!.userId, userName: req.user!.userName || 'user', tenantId: req.user!.activeTenantId!,
    tenantType: TenantType.SOCIETY, action, resource: 'FlatTenure', resourceId: flatId,
    ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: values,
  });
};

/** Load the flat (tenant-scoped), authorize, run `op` in a transaction, and shape errors. */
const runTransition = async (
  req: Request, res: Response, next: NextFunction,
  op: (flat: any, session: mongoose.ClientSession, actor: lifecycle.Actor) => Promise<any>,
) => {
  const userId = req.user?.userId;
  const userName = req.user?.userName;
  const societyId = req.user?.activeTenantId;
  if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

  const flat = await Flat.findOne({ _id: req.params.flatId, societyId: new mongoose.Types.ObjectId(societyId) });
  if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

  const denied = assertManageAccess(req, flat);
  if (denied) { res.status(403).json({ error: denied }); return; }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const actor: lifecycle.Actor = { userId: new mongoose.Types.ObjectId(userId), name: userName };
    const result = await op(flat, session, actor);
    await session.commitTransaction();
    session.endSession();
    res.status(200).json(result);
  } catch (err: any) {
    await session.abortTransaction();
    session.endSession();
    if (err?.status) { res.status(err.status).json({ error: err.message }); return; }
    if (err?.name === 'ZodError') { res.status(400).json({ errors: err.errors }); return; }
    next(err);
  }
};

export const rentOutFlat = (req: Request, res: Response, next: NextFunction) =>
  runTransition(req, res, next, async (flat, session, actor) => {
    const d = rentOutSchema.parse(req.body);
    const out = await lifecycle.rentOut(String(flat._id), String(flat.societyId), {
      tenants: d.tenants,
      rentAmountPaise: toPaise(d.rentAmount)!,
      securityDepositPaise: toPaise(d.securityDeposit)!,
      startDate: d.startDate, endDate: d.endDate,
      documents: d.documents,
    }, actor, session);
    const headName = (d.tenants.find((t) => t.isHead) || d.tenants[0]).name;
    logLifecycle(req, 'FLAT_RENT_OUT', String(flat._id), { tenant: headName, household: d.tenants.length, rentAmount: d.rentAmount });
    return { message: 'Flat rented out', tenureId: out.tenure._id };
  });

export const sellFlat = (req: Request, res: Response, next: NextFunction) =>
  runTransition(req, res, next, async (flat, session, actor) => {
    const d = sellSchema.parse(req.body);
    const out = await lifecycle.sellFlat(String(flat._id), String(flat.societyId), {
      buyer: d.buyer, saleAmountPaise: toPaise(d.saleAmount), saleDate: d.saleDate,
    }, actor, session);
    logLifecycle(req, 'FLAT_SELL', String(flat._id), { buyer: d.buyer.name, saleAmount: d.saleAmount });
    return { message: 'Ownership transferred', tenureId: out.tenure._id };
  });

export const endTenancy = (req: Request, res: Response, next: NextFunction) =>
  runTransition(req, res, next, async (flat, session, actor) => {
    const d = dateActionSchema.parse(req.body);
    const out = await lifecycle.endTenancy(String(flat._id), String(flat.societyId), d.date, actor, session);
    logLifecycle(req, 'FLAT_END_TENANCY', String(flat._id), { endDate: d.date });
    return { message: 'Tenancy ended', status: out.nextStatus };
  });

export const moveIn = (req: Request, res: Response, next: NextFunction) =>
  runTransition(req, res, next, async (flat, session, actor) => {
    const d = dateActionSchema.parse(req.body);
    await lifecycle.moveIn(String(flat._id), String(flat.societyId), d.date, actor, session);
    logLifecycle(req, 'FLAT_MOVE_IN', String(flat._id), { date: d.date });
    return { message: 'Owner moved in' };
  });

export const setVacant = (req: Request, res: Response, next: NextFunction) =>
  runTransition(req, res, next, async (flat, session, actor) => {
    const d = dateActionSchema.parse(req.body);
    await lifecycle.setVacant(String(flat._id), String(flat.societyId), d.date, actor, session);
    logLifecycle(req, 'FLAT_SET_VACANT', String(flat._id), { date: d.date });
    return { message: 'Flat marked vacant' };
  });

/** Read the full ownership/occupancy timeline for a flat, chronological. */
export const getTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }

    const flat = await Flat.findOne({ _id: req.params.flatId, societyId: new mongoose.Types.ObjectId(societyId) })
      .select('number blockName status ownerUserId')
      .populate('ownerUserId', 'name email')
      .lean();
    if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

    const timeline = await FlatTenure.find({ flatId: new mongoose.Types.ObjectId(req.params.flatId) })
      .sort({ startDate: 1, createdAt: 1 })
      .lean();

    res.status(200).json({ flat, timeline });
  } catch (error) {
    next(error);
  }
};

/** Backfill a historical period (source MIGRATION) — records history without touching live access. */
export const addHistoricalTenure = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const flat = await Flat.findOne({ _id: req.params.flatId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }
    const denied = assertManageAccess(req, flat);
    if (denied) { res.status(403).json({ error: denied }); return; }

    const d = historicalTenureSchema.parse(req.body);
    const actor = new mongoose.Types.ObjectId(userId);
    const tenure = await FlatTenure.create({
      flatId: flat._id, societyId: new mongoose.Types.ObjectId(societyId),
      type: d.type, party: { name: d.partyName }, occupants: d.occupants,
      startDate: d.startDate, endDate: d.endDate ?? null,
      status: d.endDate ? 'ENDED' : 'ACTIVE', source: 'MIGRATION',
      saleAmountPaise: toPaise(d.saleAmount), rentAmountPaise: toPaise(d.rentAmount), securityDepositPaise: toPaise(d.securityDeposit),
      notes: d.notes,
      createdBy: actor, createdByName: userName, updatedBy: actor, updatedByName: userName,
    });
    logLifecycle(req, 'FLAT_TENURE_BACKFILL', String(flat._id), { type: d.type, party: d.partyName });
    res.status(201).json({ message: 'Historical record added', tenure });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

/** Edit a historical (MIGRATION) record only — live tenures are managed by transitions. */
export const updateTenure = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const tenure = await FlatTenure.findOne({ _id: req.params.tenureId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!tenure) { res.status(404).json({ error: 'Record not found' }); return; }
    if (tenure.source !== 'MIGRATION') { res.status(400).json({ error: 'Only historical (backfilled) records can be edited' }); return; }

    const flat = await Flat.findById(tenure.flatId);
    const denied = assertManageAccess(req, flat);
    if (denied) { res.status(403).json({ error: denied }); return; }

    const d = updateTenureSchema.parse(req.body);
    if (d.partyName !== undefined) tenure.party.name = d.partyName;
    if (d.startDate !== undefined) tenure.startDate = d.startDate;
    if (d.endDate !== undefined) { tenure.endDate = d.endDate; tenure.status = d.endDate ? 'ENDED' : 'ACTIVE'; }
    if (d.notes !== undefined) tenure.notes = d.notes;
    if (d.saleAmount !== undefined) tenure.saleAmountPaise = toPaise(d.saleAmount);
    if (d.rentAmount !== undefined) tenure.rentAmountPaise = toPaise(d.rentAmount);
    if (d.securityDeposit !== undefined) tenure.securityDepositPaise = toPaise(d.securityDeposit);
    tenure.updatedBy = new mongoose.Types.ObjectId(userId);
    tenure.updatedByName = userName;
    await tenure.save();

    res.status(200).json({ message: 'Record updated', tenure });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

/** Delete a historical (MIGRATION) record only. */
export const deleteTenure = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }

    const tenure = await FlatTenure.findOne({ _id: req.params.tenureId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!tenure) { res.status(404).json({ error: 'Record not found' }); return; }
    if (tenure.source !== 'MIGRATION') { res.status(400).json({ error: 'Only historical (backfilled) records can be deleted' }); return; }

    const flat = await Flat.findById(tenure.flatId);
    const denied = assertManageAccess(req, flat);
    if (denied) { res.status(403).json({ error: denied }); return; }

    await tenure.deleteOne();
    res.status(200).json({ message: 'Record deleted' });
  } catch (error) {
    next(error);
  }
};
