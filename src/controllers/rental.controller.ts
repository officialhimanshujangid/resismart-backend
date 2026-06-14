import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { RentalAgreement } from '../models/rental.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { User } from '../models/user.model';
import { createRentalSchema, updateRentalSchema } from '../validators/rental.validator';
import { AuditService } from '../services/audit.service';
import { TenantType, UserRole } from '../constants/roles';

export const createRentalAgreement = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = createRentalSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    // Verify target flat exists in the active society context
    const flat = await Flat.findOne({
      _id: validatedData.flatId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    // Verify tenant user exists
    const tenant = await User.findById(validatedData.tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant user not found' });
      return;
    }

    const newAgreement = await RentalAgreement.create({
      flatId: new mongoose.Types.ObjectId(validatedData.flatId),
      tenantId: new mongoose.Types.ObjectId(validatedData.tenantId),
      societyId: new mongoose.Types.ObjectId(societyId),
      rentAmount: validatedData.rentAmount,
      securityDeposit: validatedData.securityDeposit,
      startDate: new Date(validatedData.startDate),
      endDate: new Date(validatedData.endDate),
      isActive: true,
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    // Auto-update flat status to RENTED
    flat.status = FlatStatus.RENTED;
    flat.updatedBy = new mongoose.Types.ObjectId(userId);
    flat.updatedByName = userName;
    await flat.save();

    // Auto-assign / update tenant membership for this society to RESIDENT_TENANT
    const existingMembershipIndex = tenant.memberships.findIndex(
      (m) => m.tenantId.toString() === societyId
    );

    if (existingMembershipIndex >= 0) {
      tenant.memberships[existingMembershipIndex].role = UserRole.RESIDENT_TENANT;
    } else {
      tenant.memberships.push({
        tenantType: TenantType.SOCIETY,
        tenantId: new mongoose.Types.ObjectId(societyId),
        role: UserRole.RESIDENT_TENANT,
      });
    }
    await tenant.save();

    // Write audit log
    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'RENTAL_LEASE_CREATE',
      resource: 'RentalAgreement',
      resourceId: newAgreement._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: {
        flatId: newAgreement.flatId,
        tenantId: newAgreement.tenantId,
        rentAmount: newAgreement.rentAmount,
        startDate: newAgreement.startDate,
        endDate: newAgreement.endDate,
      },
    });

    res.status(201).json({
      message: 'Rental agreement created successfully',
      agreement: newAgreement,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const updateRentalAgreement = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { leaseId } = req.params;
    const validatedData = updateRentalSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const agreement = await RentalAgreement.findOne({
      _id: leaseId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!agreement) {
      res.status(404).json({ error: 'Rental agreement not found' });
      return;
    }

    const oldValues = {
      rentAmount: agreement.rentAmount,
      securityDeposit: agreement.securityDeposit,
      isActive: agreement.isActive,
    };

    if (validatedData.rentAmount !== undefined) {
      agreement.rentAmount = validatedData.rentAmount;
    }
    if (validatedData.securityDeposit !== undefined) {
      agreement.securityDeposit = validatedData.securityDeposit;
    }
    
    // Handle lease cancellation
    if (validatedData.isActive !== undefined) {
      agreement.isActive = validatedData.isActive;
      
      // If cancelling the lease, update flat status back to VACANT
      if (validatedData.isActive === false) {
        await Flat.updateOne(
          { _id: agreement.flatId },
          { 
            $set: { 
              status: FlatStatus.VACANT,
              updatedBy: new mongoose.Types.ObjectId(userId),
              updatedByName: userName,
            } 
          }
        );
      }
    }

    agreement.updatedBy = new mongoose.Types.ObjectId(userId);
    agreement.updatedByName = userName;
    await agreement.save();

    const newValues = {
      rentAmount: agreement.rentAmount,
      securityDeposit: agreement.securityDeposit,
      isActive: agreement.isActive,
    };

    // Write audit log
    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'RENTAL_LEASE_UPDATE',
      resource: 'RentalAgreement',
      resourceId: agreement._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues,
    });

    res.status(200).json({
      message: 'Rental agreement updated successfully',
      agreement,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const getRentalAgreements = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(403).json({ error: 'No active society context' });
      return;
    }

    // Optimize performance using lean parsing
    const agreements = await RentalAgreement.find({ societyId: new mongoose.Types.ObjectId(societyId) })
      .select('-__v')
      .populate('flatId', 'number blockName')
      .populate('tenantId', 'name email')
      .lean();

    res.status(200).json({ agreements });
  } catch (error) {
    next(error);
  }
};
