import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { FlatSize } from '../models/flat-size.model';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';

export const createFlatSize = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const societyId = req.user?.activeTenantId;
    const { name, details } = req.body;

    if (!userId || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const existing = await FlatSize.findOne({ societyId: new mongoose.Types.ObjectId(societyId), name });
    if (existing) {
      res.status(400).json({ error: 'Flat size with this name already exists' });
      return;
    }

    const newFlatSize = new FlatSize({
      name,
      details,
      societyId: new mongoose.Types.ObjectId(societyId),
      createdBy: new mongoose.Types.ObjectId(userId),
      updatedBy: new mongoose.Types.ObjectId(userId),
    });

    await newFlatSize.save();

    res.status(201).json({ message: 'Flat size created successfully', flatSize: newFlatSize });
  } catch (error) {
    next(error);
  }
};

export const getFlatSizes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const flatSizes = await FlatSize.find({ societyId: new mongoose.Types.ObjectId(societyId) })
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ flatSizes });
  } catch (error) {
    next(error);
  }
};

export const updateFlatSize = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sizeId } = req.params;
    const { name, details } = req.body;
    const userId = req.user?.userId;
    const societyId = req.user?.activeTenantId;

    if (!userId || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const flatSize = await FlatSize.findOne({ _id: sizeId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!flatSize) {
      res.status(404).json({ error: 'Flat size not found' });
      return;
    }

    if (name && name !== flatSize.name) {
      const existing = await FlatSize.findOne({ societyId: new mongoose.Types.ObjectId(societyId), name });
      if (existing) {
        res.status(400).json({ error: 'Flat size with this name already exists' });
        return;
      }
      flatSize.name = name;
    }
    
    if (details !== undefined) {
      flatSize.details = details;
    }

    flatSize.updatedBy = new mongoose.Types.ObjectId(userId);
    await flatSize.save();

    res.status(200).json({ message: 'Flat size updated successfully', flatSize });
  } catch (error) {
    next(error);
  }
};

export const deleteFlatSize = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sizeId } = req.params;
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const flatSize = await FlatSize.findOne({ _id: sizeId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!flatSize) {
      res.status(404).json({ error: 'Flat size not found' });
      return;
    }

    await flatSize.deleteOne();

    res.status(200).json({ message: 'Flat size deleted successfully' });
  } catch (error) {
    next(error);
  }
};
