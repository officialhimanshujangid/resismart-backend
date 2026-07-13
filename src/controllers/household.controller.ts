import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { FlatEvent } from '../models/flat-event.model';
import { FlatTenure } from '../models/flat-tenure.model';
import { addMemberSchema, updateMemberSchema, addDocumentSchema } from '../validators/household.validator';
import * as household from '../services/household.service';
import { AuditService } from '../services/audit.service';
import s3Service from '../services/s3.service';
import { TenantType, UserRole } from '../constants/roles';

/** Society admins/committee manage any flat; a flat owner manages only their own flat. */
const assertManageAccess = (req: Request, flat: any): string | null => {
  const role = req.user?.activeRole;
  if (role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE) return null;
  if (role === UserRole.RESIDENT_OWNER && flat.ownerUserId && flat.ownerUserId.toString() === req.user?.userId) return null;
  return 'You are not allowed to manage this flat';
};

const actorOf = (req: Request): household.Actor => ({
  userId: new mongoose.Types.ObjectId(req.user!.userId),
  name: req.user!.userName || 'user',
});

const logAudit = (req: Request, action: string, resourceId: string, values: any) => {
  AuditService.log({
    userId: req.user!.userId, userName: req.user!.userName || 'user', tenantId: req.user!.activeTenantId!,
    tenantType: TenantType.SOCIETY, action, resource: 'Resident', resourceId,
    ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: values,
  });
};

/**
 * GET /flats/:flatId/household — active + inactive members, DEDUPED per person (a person
 * with email+phone has two Resident rows sharing one identity). Head first, then owner,
 * then by created order.
 */
export const getHousehold = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const members = await household.listHouseholdMembers(req.params.flatId, societyId);
    res.status(200).json({ members });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /flats/:flatId/tenancy — the current (active) tenancy: the TENANCY tenure with rent/
 * deposit/dates + its documents, and the tenant household (householdType TENANT members).
 * Returns `{ tenancy: null }` when the flat isn't rented.
 */
export const getTenancy = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const flatId = new mongoose.Types.ObjectId(req.params.flatId);
    const sId = new mongoose.Types.ObjectId(societyId);

    const tenure: any = await FlatTenure.findOne({ flatId, societyId: sId, type: 'TENANCY', status: 'ACTIVE' }).lean();
    if (!tenure) { res.status(200).json({ tenancy: null, tenantMembers: [] }); return; }

    const allMembers = await household.listHouseholdMembers(flatId, societyId);
    const tenantMembers = allMembers.filter((m: any) => m.householdType === 'TENANT' && m.isActive);
    res.status(200).json({
      tenancy: {
        _id: tenure._id, party: tenure.party, startDate: tenure.startDate, endDate: tenure.endDate,
        rentAmountPaise: tenure.rentAmountPaise, securityDepositPaise: tenure.securityDepositPaise,
        rentalAgreementId: tenure.rentalAgreementId,
        documents: (tenure.documents || []).map((d: any) => ({ _id: d._id, kind: d.kind, label: d.label, uploadedAt: d.uploadedAt })),
      },
      tenantMembers,
    });
  } catch (error) {
    next(error);
  }
};

/** POST /flats/:flatId/tenancy/documents — attach a document to the active tenancy tenure. */
export const addTenancyDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = addDocumentSchema.parse(req.body);
  await runManage(req, res, next, 'flatId', async ({ flat, actor, session }) => {
    const tenure = await FlatTenure.findOne({ flatId: flat._id, type: 'TENANCY', status: 'ACTIVE' }).session(session);
    if (!tenure) throw Object.assign(new Error('No active tenancy on this flat'), { status: 400 });
    tenure.documents.push({ kind: parsed.kind || 'OTHER', label: parsed.label, key: parsed.key, url: parsed.url, uploadedAt: new Date(), uploadedByName: req.user!.userName || 'user' } as any);
    tenure.updatedBy = actor.userId; tenure.updatedByName = actor.name;
    await tenure.save({ session });
    await household.logFlatEvent({
      flatId: flat._id, societyId: flat.societyId, type: 'DOCUMENT_ADDED', actor,
      summary: `Added tenancy document "${parsed.label}"`,
      subject: { name: (tenure.party as any)?.name, relationship: 'TENANT' },
      tenureId: tenure._id as any,
    }, session);
    logAudit(req, 'TENANCY_DOCUMENT_ADD', tenure._id.toString(), { label: parsed.label });
    return { message: 'Tenancy document added' };
  });
};

/** GET /flats/:flatId/tenancy/documents/:docId/download — presigned URL for a tenancy document. */
export const downloadTenancyDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const tenure: any = await FlatTenure.findOne({ flatId: req.params.flatId, societyId: new mongoose.Types.ObjectId(societyId), type: 'TENANCY' })
      .sort({ startDate: -1 }).lean();
    const doc = tenure && (tenure.documents || []).find((d: any) => d._id.toString() === req.params.docId);
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    const url = await s3Service.getSignedDownloadUrl(doc.key, { downloadName: doc.label });
    res.status(200).json({ url });
  } catch (error) {
    next(error);
  }
};

/** GET /flats/:flatId/events — the flat activity log (newest first). */
export const getFlatEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '100'), 10)));
    const events = await FlatEvent.find({
      flatId: new mongoose.Types.ObjectId(req.params.flatId),
      societyId: new mongoose.Types.ObjectId(societyId),
    }).sort({ createdAt: -1 }).limit(limit).lean();
    res.status(200).json({ events });
  } catch (error) {
    next(error);
  }
};

/** Load the flat (tenant-scoped), authorize manage access, then run `op` in a transaction. */
const runManage = async (
  req: Request, res: Response, next: NextFunction,
  flatIdParam: 'flatId' | 'fromResident',
  op: (args: { flat: any; societyId: string; actor: household.Actor; session: mongoose.ClientSession }) => Promise<any>,
) => {
  const userId = req.user?.userId;
  const societyId = req.user?.activeTenantId;
  if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

  let flat: any;
  if (flatIdParam === 'flatId') {
    flat = await Flat.findOne({ _id: req.params.flatId, societyId: new mongoose.Types.ObjectId(societyId) });
  } else {
    const resident = await Resident.findOne({ _id: req.params.residentId, societyId: new mongoose.Types.ObjectId(societyId) }).lean();
    if (!resident) { res.status(404).json({ error: 'Member not found' }); return; }
    flat = await Flat.findOne({ _id: resident.flatId, societyId: new mongoose.Types.ObjectId(societyId) });
  }
  if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

  const denied = assertManageAccess(req, flat);
  if (denied) { res.status(403).json({ error: denied }); return; }

  const session = await mongoose.startSession();
  try {
    let result: any;
    await session.withTransaction(async () => {
      result = await op({ flat, societyId, actor: actorOf(req), session });
    });
    res.status(200).json(result);
  } catch (error: any) {
    if (error?.name === 'ZodError') { res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid input' }); return; }
    if (error?.status) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  } finally {
    session.endSession();
  }
};

/** POST /flats/:flatId/household — add a family member or tenant (owner-managed = immediate). */
export const addHouseholdMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = addMemberSchema.parse(req.body);
  await runManage(req, res, next, 'flatId', async ({ flat, societyId, actor, session }) => {
    const result = await household.addMember({
      flatId: flat._id.toString(), societyId,
      person: { name: parsed.name, email: parsed.email, phone: parsed.phone },
      relationship: parsed.relationship, isHead: parsed.isHead, moveInDate: parsed.moveInDate,
      householdType: parsed.householdType,
      emailToken: parsed.emailToken, phoneToken: parsed.phoneToken,
    }, actor, session);
    logAudit(req, 'HOUSEHOLD_MEMBER_ADD', flat._id.toString(), { name: parsed.name, relationship: parsed.relationship, dataOnly: result.dataOnly });
    return { message: result.dataOnly ? 'Member added (no login — data only)' : 'Member added and access granted', ...result };
  });
};

/** PUT /household/:residentId — update a member (relationship/dates/active or add a contact). */
export const updateHouseholdMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = updateMemberSchema.parse(req.body);
  await runManage(req, res, next, 'fromResident', async ({ actor, session }) => {
    const result = await household.updateMember(req.params.residentId, parsed, actor, session);
    logAudit(req, 'HOUSEHOLD_MEMBER_UPDATE', req.params.residentId, parsed);
    return { message: 'Member updated', resident: result.resident };
  });
};

/** POST /household/:residentId/set-head — make a member the household head. */
export const setHouseholdHead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  await runManage(req, res, next, 'fromResident', async ({ actor, session }) => {
    const result = await household.setHead(req.params.residentId, actor, session);
    logAudit(req, 'HOUSEHOLD_SET_HEAD', req.params.residentId, {});
    return { message: 'Head of household updated', resident: result.resident };
  });
};

/** DELETE /household/:residentId — deactivate (soft-remove) a member. */
export const removeHouseholdMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  await runManage(req, res, next, 'fromResident', async ({ actor, session }) => {
    await household.deactivateMember(req.params.residentId, req.body?.reason, actor, session);
    logAudit(req, 'HOUSEHOLD_MEMBER_REMOVE', req.params.residentId, { reason: req.body?.reason });
    return { message: 'Member removed' };
  });
};

/** GET /household/:residentId/documents/:docId/download — short-lived presigned URL for a private doc. */
export const downloadHouseholdDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const resident = await Resident.findOne({ _id: req.params.residentId, societyId: new mongoose.Types.ObjectId(societyId) }).lean();
    if (!resident) { res.status(404).json({ error: 'Member not found' }); return; }
    const doc = (resident.documents || []).find((d: any) => d._id.toString() === req.params.docId);
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    const url = await s3Service.getSignedDownloadUrl(doc.key, { downloadName: doc.label });
    res.status(200).json({ url });
  } catch (error) {
    next(error);
  }
};

/** POST /household/:residentId/documents — attach an already-uploaded private document. */
export const addHouseholdDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = addDocumentSchema.parse(req.body);
  await runManage(req, res, next, 'fromResident', async ({ actor, session }) => {
    const result = await household.addDocument(req.params.residentId, {
      kind: parsed.kind || 'OTHER', label: parsed.label, key: parsed.key, url: parsed.url,
      uploadedAt: new Date(), uploadedByName: req.user!.userName || 'user',
    } as any, actor, session);
    logAudit(req, 'HOUSEHOLD_DOCUMENT_ADD', req.params.residentId, { label: parsed.label });
    return { message: 'Document added', resident: result.resident };
  });
};
