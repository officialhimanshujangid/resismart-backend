import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Society } from '../models/society.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { User } from '../models/user.model';
import { createSocietySchema, createFlatSchema, updateFlatSchema } from '../validators/society.validator';
import { AuditService } from '../services/audit.service';
import { TenantType, UserRole } from '../constants/roles';

export const createSociety = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = createSocietySchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;

    if (!userId || !userName) {
      res.status(401).json({ error: 'Unauthorized credentials' });
      return;
    }

    const newSociety = await Society.create({
      name: validatedData.name,
      address: validatedData.address,
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    // Write audit log
    AuditService.log({
      userId,
      userName,
      tenantId: newSociety._id.toString(),
      tenantType: TenantType.SOCIETY,
      action: 'SOCIETY_CREATE',
      resource: 'Society',
      resourceId: newSociety._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { name: newSociety.name, address: newSociety.address },
    });

    res.status(201).json({
      message: 'Society created successfully',
      society: newSociety,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const createFlat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = createFlatSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    // Check if flat already exists in the same block for this society
    const existingFlat = await Flat.findOne({
      societyId: new mongoose.Types.ObjectId(societyId),
      blockName: validatedData.blockName,
      number: validatedData.number,
    }).lean();

    if (existingFlat) {
      res.status(400).json({ error: 'Flat already exists in this block' });
      return;
    }

    const newFlat = await Flat.create({
      number: validatedData.number,
      blockName: validatedData.blockName,
      societyId: new mongoose.Types.ObjectId(societyId),
      status: FlatStatus.VACANT,
      owners: [],
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    // Audit log
    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_CREATE',
      resource: 'Flat',
      resourceId: newFlat._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: {
        number: newFlat.number,
        blockName: newFlat.blockName,
        status: newFlat.status,
      },
    });

    res.status(201).json({
      message: 'Flat created successfully',
      flat: newFlat,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const updateFlat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { flatId } = req.params;
    const validatedData = updateFlatSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const flat = await Flat.findOne({
      _id: flatId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    const oldValues = {
      status: flat.status,
      owners: flat.owners.map(o => o.toString()),
    };

    // Update fields
    if (validatedData.status) {
      flat.status = validatedData.status as FlatStatus;
    }
    if (validatedData.owners) {
      flat.owners = validatedData.owners.map(id => new mongoose.Types.ObjectId(id));
      
      // Auto-update users memberships as flat owners
      for (const ownerId of validatedData.owners) {
        await User.updateOne(
          { _id: ownerId, 'memberships.tenantId': new mongoose.Types.ObjectId(societyId) },
          { $set: { 'memberships.$.role': UserRole.RESIDENT_OWNER } }
        );
      }
    }

    flat.updatedBy = new mongoose.Types.ObjectId(userId);
    flat.updatedByName = userName;
    await flat.save();

    const newValues = {
      status: flat.status,
      owners: flat.owners.map(o => o.toString()),
    };

    // Audit log
    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_UPDATE',
      resource: 'Flat',
      resourceId: flat._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues,
    });

    res.status(200).json({
      message: 'Flat updated successfully',
      flat,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const getFlats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    // Performance Optimization: .lean() for fast reads & selective projection
    const flats = await Flat.find({ societyId: new mongoose.Types.ObjectId(societyId) })
      .select('-__v')
      .populate('owners', 'name email')
      .lean();

    res.status(200).json({ flats });
  } catch (error) {
    next(error);
  }
};
