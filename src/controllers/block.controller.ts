import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Block } from '../models/block.model';
import { Flat } from '../models/flat.model';
import { createBlockSchema, updateBlockSchema } from '../validators/society.validator';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';

export const getBlocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(401).json({ error: 'Missing tenant details' });
      return;
    }

    const blocks = await Block.find({ societyId: new mongoose.Types.ObjectId(societyId) }).sort({ name: 1 });
    res.status(200).json({ blocks });
  } catch (error) {
    next(error);
  }
};

export const createBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const validatedData = createBlockSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const existingBlock = await Block.findOne({
      societyId: new mongoose.Types.ObjectId(societyId),
      name: validatedData.name,
    });

    if (existingBlock) {
      res.status(400).json({ error: 'Block with this name already exists' });
      return;
    }

    const newBlock = await Block.create({
      ...validatedData,
      societyId: new mongoose.Types.ObjectId(societyId),
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'BLOCK_CREATE',
      resource: 'Block',
      resourceId: newBlock._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { name: newBlock.name },
    });

    res.status(201).json({ message: 'Block created successfully', block: newBlock });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const updateBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { blockId } = req.params;
    const validatedData = updateBlockSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const block = await Block.findOne({
      _id: blockId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    if (validatedData.name && validatedData.name !== block.name) {
      const existingBlock = await Block.findOne({
        societyId: new mongoose.Types.ObjectId(societyId),
        name: validatedData.name,
      });

      if (existingBlock) {
        res.status(400).json({ error: 'Block with this name already exists' });
        return;
      }
    }

    const oldValues = {
      name: block.name,
      totalFloors: block.totalFloors,
      blockType: block.blockType,
    };

    if (validatedData.name) block.name = validatedData.name;
    if (validatedData.totalFloors !== undefined) block.totalFloors = validatedData.totalFloors;
    if (validatedData.blockType !== undefined) block.blockType = validatedData.blockType;
    
    block.updatedBy = new mongoose.Types.ObjectId(userId);
    block.updatedByName = userName;

    await block.save();

    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'BLOCK_UPDATE',
      resource: 'Block',
      resourceId: block._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues: {
        name: block.name,
        totalFloors: block.totalFloors,
        blockType: block.blockType,
      },
    });

    res.status(200).json({ message: 'Block updated successfully', block });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const deleteBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { blockId } = req.params;
    const societyId = req.user?.activeTenantId;
    const userId = req.user?.userId;
    const userName = req.user?.userName;

    if (!societyId || !userId || !userName) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const block = await Block.findOne({
      _id: blockId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    // Check if there are flats attached to this block
    const flatCount = await Flat.countDocuments({ blockId: block._id });
    if (flatCount > 0) {
      res.status(400).json({ error: `Cannot delete block. There are ${flatCount} flats associated with it.` });
      return;
    }

    await block.deleteOne();

    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'BLOCK_DELETE',
      resource: 'Block',
      resourceId: block._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    res.status(200).json({ message: 'Block deleted successfully' });
  } catch (error) {
    next(error);
  }
};
