import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { MembershipRequest } from '../models/membership-request.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { Society } from '../models/society.model';
import { User } from '../models/user.model';
import { createRegistrationRequestSchema, rejectRequestSchema } from '../validators/membership-request.validator';
import { resolveRouting, materializeMembership } from '../services/membership.service';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { TenantType, UserRole } from '../constants/roles';

const REQUEST_TTL_DAYS = 30;

/** Whether the current session may approve/reject the given request. */
const canDecide = (role: UserRole | undefined, userId: string, request: any): boolean => {
  if (request.approver.side === 'SOCIETY') {
    return role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;
  }
  if (request.approver.side === 'FLAT_OWNER') {
    return !!request.approver.userId && request.approver.userId.toString() === userId;
  }
  return false;
};

export const createRegistrationRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { flatId } = req.params;
    const data = createRegistrationRequestSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const flat = await Flat.findOne({ _id: flatId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

    // Authorization: who is allowed to initiate a registration for THIS flat.
    if (role === UserRole.RESIDENT_OWNER) {
      if (!flat.ownerUserId || flat.ownerUserId.toString() !== userId) {
        res.status(403).json({ error: 'You can only register residents for a flat you own' });
        return;
      }
    } else if (role === UserRole.RESIDENT_TENANT) {
      const tenancy = await Resident.findOne({ flatId: flat._id, userId: new mongoose.Types.ObjectId(userId), isActive: true });
      if (!tenancy) { res.status(403).json({ error: 'You can only add household members to your own flat' }); return; }
    } else if (role !== UserRole.SOCIETY_ADMIN && role !== UserRole.SOCIETY_COMMITTEE) {
      res.status(403).json({ error: 'You are not allowed to register residents' });
      return;
    }

    const email = data.email && data.email.length > 0 ? data.email : undefined;
    const phone = data.phone && data.phone.length > 0 ? data.phone : undefined;

    // Block registering someone who is already an active resident of this flat.
    if (email || phone) {
      const idOr: any[] = [];
      if (email) idOr.push({ email });
      if (phone) idOr.push({ phone });
      const existingUsers = await User.find({ $or: idOr }).select('_id').lean();
      if (existingUsers.length) {
        const already = await Resident.findOne({
          flatId: flat._id,
          userId: { $in: existingUsers.map((u) => u._id) },
          isActive: true,
        }).lean();
        if (already) { res.status(400).json({ error: 'This person is already a resident of this flat' }); return; }
      }
    }

    const society = await Society.findById(societyId).select('adminUserId name').lean();
    const routing = resolveRouting({
      initiatorRole: role as UserRole,
      relationship: data.relationship,
      flat,
      societyAdminUserId: society?.adminUserId,
    });

    const expiresAt = new Date(Date.now() + REQUEST_TTL_DAYS * 86400000);
    const baseDoc = {
      flatId: flat._id,
      societyId: new mongoose.Types.ObjectId(societyId),
      targetName: data.name,
      targetEmail: email,
      targetPhone: phone,
      relationship: data.relationship,
      requestedRole: routing.requestedRole,
      initiatedBy: { userId: new mongoose.Types.ObjectId(userId), name: userName, side: routing.initiatorSide },
      approver: { side: routing.approverSide, userId: routing.approverUserId },
      expiresAt,
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    };

    // ── Auto-approved path (household add / ownerless-flat setup): materialize immediately ──
    if (routing.autoApprove) {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        await materializeMembership({
          flatId: flat._id as mongoose.Types.ObjectId,
          societyId: new mongoose.Types.ObjectId(societyId),
          name: data.name, email, phone,
          relationship: data.relationship,
          requestedRole: routing.requestedRole,
          actorUserId: new mongoose.Types.ObjectId(userId),
          actorName: userName,
        }, session);

        const [created] = await MembershipRequest.create([{
          ...baseDoc,
          status: 'APPROVED',
          decisionByUserId: new mongoose.Types.ObjectId(userId),
          decisionByName: userName,
          decisionAt: new Date(),
        }], { session });

        await session.commitTransaction();
        session.endSession();

        if (email) EmailService.sendTenantAccessEmail(email, flat.number, 'flat', [['Society', society?.name || 'Society']]);
        AuditService.log({
          userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
          action: 'RESIDENT_REGISTER_AUTO', resource: 'MembershipRequest', resourceId: created._id.toString(),
          ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
          newValues: { flatId: flat._id, relationship: data.relationship, role: routing.requestedRole },
        });

        res.status(201).json({ message: 'Resident registered', request: created, autoApproved: true });
        return;
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
      }
    }

    // ── Approval-required path: create a PENDING request ──
    const request = await MembershipRequest.create({ ...baseDoc, status: 'PENDING' });

    AuditService.log({
      userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'RESIDENT_REGISTER_REQUEST', resource: 'MembershipRequest', resourceId: request._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { flatId: flat._id, relationship: data.relationship, approverSide: routing.approverSide },
    });

    res.status(201).json({
      message: routing.approverSide === 'SOCIETY'
        ? 'Registration submitted — awaiting society approval'
        : 'Registration submitted — awaiting flat owner approval',
      request,
      autoApproved: false,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    if (error.code === 11000) { res.status(400).json({ error: 'A pending request already exists for this person in this flat' }); return; }
    next(error);
  }
};

export const listRegistrationRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;
    if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const box = (req.query.box as string) === 'outgoing' ? 'outgoing' : 'incoming';
    const statusFilter = req.query.status as string | undefined;

    // Lazily expire stale pending requests in this society before reading.
    await MembershipRequest.updateMany(
      { societyId: new mongoose.Types.ObjectId(societyId), status: 'PENDING', expiresAt: { $lt: new Date() } },
      { $set: { status: 'EXPIRED' } }
    );

    const filter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };

    if (box === 'outgoing') {
      filter['initiatedBy.userId'] = new mongoose.Types.ObjectId(userId);
    } else {
      // Incoming = requests THIS session is the designated approver for.
      if (role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE) {
        filter['approver.side'] = 'SOCIETY';
      } else if (role === UserRole.RESIDENT_OWNER) {
        filter['approver.side'] = 'FLAT_OWNER';
        filter['approver.userId'] = new mongoose.Types.ObjectId(userId);
      } else {
        res.status(200).json({ requests: [] });
        return;
      }
    }

    if (statusFilter && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(statusFilter)) {
      filter.status = statusFilter;
    } else if (box === 'incoming') {
      filter.status = 'PENDING';
    }

    const requests = await MembershipRequest.find(filter)
      .populate('flatId', 'number blockName')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ requests });
  } catch (error) {
    next(error);
  }
};

export const approveRegistrationRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { requestId } = req.params;
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;
    if (!userId || !userName || !societyId) {
      await session.abortTransaction(); session.endSession();
      res.status(401).json({ error: 'Missing tenant or user details' }); return;
    }

    const request = await MembershipRequest.findOne({
      _id: requestId, societyId: new mongoose.Types.ObjectId(societyId),
    }).session(session);

    if (!request) { await session.abortTransaction(); session.endSession(); res.status(404).json({ error: 'Request not found' }); return; }
    if (request.status !== 'PENDING') { await session.abortTransaction(); session.endSession(); res.status(400).json({ error: `Request is already ${request.status.toLowerCase()}` }); return; }
    if (!canDecide(role, userId, request)) { await session.abortTransaction(); session.endSession(); res.status(403).json({ error: 'You are not the designated approver for this request' }); return; }

    await materializeMembership({
      flatId: request.flatId as mongoose.Types.ObjectId,
      societyId: request.societyId as mongoose.Types.ObjectId,
      name: request.targetName,
      email: request.targetEmail,
      phone: request.targetPhone,
      relationship: request.relationship,
      requestedRole: request.requestedRole,
      actorUserId: new mongoose.Types.ObjectId(userId),
      actorName: userName,
    }, session);

    request.status = 'APPROVED';
    request.decisionByUserId = new mongoose.Types.ObjectId(userId);
    request.decisionByName = userName;
    request.decisionAt = new Date();
    request.updatedBy = new mongoose.Types.ObjectId(userId);
    request.updatedByName = userName;
    await request.save({ session });

    await session.commitTransaction();
    session.endSession();

    const society = await Society.findById(societyId).select('name').lean();
    if (request.targetEmail) EmailService.sendTenantAccessEmail(request.targetEmail, 'your flat', 'flat', [['Society', society?.name || 'Society']]);

    AuditService.log({
      userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'RESIDENT_REGISTER_APPROVE', resource: 'MembershipRequest', resourceId: request._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { flatId: request.flatId, relationship: request.relationship, role: request.requestedRole },
    });

    res.status(200).json({ message: 'Request approved and resident registered', request });
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};

export const rejectRegistrationRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { requestId } = req.params;
    const { reason } = rejectRequestSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const request = await MembershipRequest.findOne({ _id: requestId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
    if (request.status !== 'PENDING') { res.status(400).json({ error: `Request is already ${request.status.toLowerCase()}` }); return; }
    if (!canDecide(role, userId, request)) { res.status(403).json({ error: 'You are not the designated approver for this request' }); return; }

    request.status = 'REJECTED';
    request.decisionByUserId = new mongoose.Types.ObjectId(userId);
    request.decisionByName = userName;
    request.decisionAt = new Date();
    request.rejectionReason = reason;
    request.updatedBy = new mongoose.Types.ObjectId(userId);
    request.updatedByName = userName;
    await request.save();

    AuditService.log({
      userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'RESIDENT_REGISTER_REJECT', resource: 'MembershipRequest', resourceId: request._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { reason: reason || null },
    });

    res.status(200).json({ message: 'Request rejected', request });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

export const cancelRegistrationRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { requestId } = req.params;
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const request = await MembershipRequest.findOne({ _id: requestId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
    if (request.status !== 'PENDING') { res.status(400).json({ error: `Request is already ${request.status.toLowerCase()}` }); return; }

    const isInitiator = request.initiatedBy.userId.toString() === userId;
    const isSocietyAdmin = role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;
    if (!isInitiator && !isSocietyAdmin) { res.status(403).json({ error: 'Only the requester or a society admin can cancel this request' }); return; }

    request.status = 'CANCELLED';
    request.decisionByUserId = new mongoose.Types.ObjectId(userId);
    request.decisionByName = userName;
    request.decisionAt = new Date();
    request.updatedBy = new mongoose.Types.ObjectId(userId);
    request.updatedByName = userName;
    await request.save();

    AuditService.log({
      userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'RESIDENT_REGISTER_CANCEL', resource: 'MembershipRequest', resourceId: request._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
      newValues: {},
    });

    res.status(200).json({ message: 'Request cancelled', request });
  } catch (error) {
    next(error);
  }
};
