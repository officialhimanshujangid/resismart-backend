import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Resident } from '../models/resident.model';
import { Flat } from '../models/flat.model';
import { User } from '../models/user.model';
import { Society } from '../models/society.model';
import { createResidentSchema, updateResidentSchema } from '../validators/society.validator';
import EmailService from '../services/email.service';
import { hashPassword } from '../utils/hash.util';
import { TenantType, UserRole } from '../constants/roles';

export const getResidentsByFlat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { flatId } = req.params;
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(401).json({ error: 'Missing tenant details' });
      return;
    }

    const residents = await Resident.find({
      flatId: new mongoose.Types.ObjectId(flatId),
      societyId: new mongoose.Types.ObjectId(societyId),
    }).populate('userId', 'name email phone profileImage').sort({ isOwner: -1, createdAt: 1 });

    res.status(200).json({ residents });
  } catch (error) {
    next(error);
  }
};

export const addResident = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { flatId } = req.params;
    const validatedData = createResidentSchema.parse(req.body);
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
    }).session(session);

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    const email = validatedData.email.toLowerCase();
    let user = await User.findOne({ email }).session(session);
    let isNewUser = false;
    let passwordStr = '';

    if (!user) {
      isNewUser = true;
      passwordStr = crypto.randomBytes(6).toString('hex');
      const passwordHash = await hashPassword(passwordStr);
      
      user = new User({
        name: validatedData.name,
        email,
        passwordHash,
        memberships: [],
      });
    }

    const role = validatedData.relationship === 'TENANT' ? UserRole.RESIDENT_TENANT : UserRole.FAMILY_MEMBER;

    const hasMembership = user.memberships.some(
      (m) => m.tenantId.toString() === societyId && m.tenantType === TenantType.SOCIETY
    );

    if (!hasMembership) {
      user.memberships.push({
        tenantType: TenantType.SOCIETY,
        tenantId: new mongoose.Types.ObjectId(societyId),
        role,
      });
    } else {
      // Check if they are already in this flat
      const existingResident = await Resident.findOne({
        flatId: flat._id,
        userId: user._id,
      }).session(session);
      
      if (existingResident) {
        res.status(400).json({ error: 'User is already a resident of this flat' });
        return;
      }
    }

    await user.save({ session });

    const newResident = new Resident({
      flatId: flat._id,
      societyId: new mongoose.Types.ObjectId(societyId),
      userId: user._id,
      relationship: validatedData.relationship,
      isOwner: false,
      isActive: true,
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });
    
    await newResident.save({ session });
    
    flat.residents.push(newResident._id as any);
    await flat.save({ session });

    if (isNewUser) {
      const society = await Society.findById(societyId).select('name').session(session);
      EmailService.sendResidentCreatedEmail(
        email,
        validatedData.name,
        flat.number,
        society?.name || 'Society',
        passwordStr
      );
    }

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({ message: 'Resident added successfully', resident: newResident });
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const updateResident = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { residentId } = req.params;
    const validatedData = updateResidentSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const resident = await Resident.findOne({
      _id: residentId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!resident) {
      res.status(404).json({ error: 'Resident not found' });
      return;
    }

    if (validatedData.relationship) resident.relationship = validatedData.relationship;
    if (validatedData.isActive !== undefined) resident.isActive = validatedData.isActive;

    resident.updatedBy = new mongoose.Types.ObjectId(userId);
    resident.updatedByName = userName;
    await resident.save();

    res.status(200).json({ message: 'Resident updated successfully', resident });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const removeResident = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { residentId } = req.params;
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(401).json({ error: 'Missing tenant details' });
      return;
    }

    const resident = await Resident.findOne({
      _id: residentId,
      societyId: new mongoose.Types.ObjectId(societyId),
    }).session(session);

    if (!resident) {
      res.status(404).json({ error: 'Resident not found' });
      return;
    }

    if (resident.isOwner) {
      res.status(400).json({ error: 'Cannot remove the primary owner of the flat' });
      return;
    }

    const flat = await Flat.findById(resident.flatId).session(session);
    if (flat) {
      flat.residents = flat.residents.filter(r => r.toString() !== resident._id.toString());
      await flat.save({ session });
    }

    await resident.deleteOne({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({ message: 'Resident removed successfully' });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};
