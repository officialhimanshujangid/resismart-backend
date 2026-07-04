import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import * as xlsx from 'xlsx';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { User } from '../models/user.model';
import { Resident } from '../models/resident.model';
import { Society } from '../models/society.model';
import { createFlatSchema, updateFlatSchema, bulkUploadFlatRowSchema } from '../validators/society.validator';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { hashPassword } from '../utils/hash.util';
import { TenantType, UserRole } from '../constants/roles';

export const createFlat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const validatedData = createFlatSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    // Validate block
    const block = await Block.findOne({ _id: validatedData.blockId, societyId: new mongoose.Types.ObjectId(societyId) }).session(session);
    if (!block) {
      res.status(404).json({ error: 'Block not found in this society' });
      return;
    }

    // Check unique flat number in block
    const existingFlat = await Flat.findOne({
      societyId: new mongoose.Types.ObjectId(societyId),
      blockId: block._id,
      number: validatedData.number,
    }).session(session);

    if (existingFlat) {
      res.status(400).json({ error: 'Flat already exists in this block' });
      return;
    }

    let ownerUserId: mongoose.Types.ObjectId | undefined;
    let newResident: any = null;

    if (validatedData.ownerEmail && validatedData.ownerName) {
      const email = validatedData.ownerEmail.toLowerCase();
      let user = await User.findOne({ email }).session(session);
      let isNewUser = false;
      let passwordStr = '';

      if (!user) {
        isNewUser = true;
        passwordStr = crypto.randomBytes(6).toString('hex');
        const passwordHash = await hashPassword(passwordStr);
        
        user = new User({
          name: validatedData.ownerName,
          email,
          passwordHash,
          memberships: [],
        });
      }

      const hasMembership = user.memberships.some(
        (m) => m.tenantId.toString() === societyId && m.tenantType === TenantType.SOCIETY
      );

      if (!hasMembership) {
        user.memberships.push({
          tenantType: TenantType.SOCIETY,
          tenantId: new mongoose.Types.ObjectId(societyId),
          role: UserRole.RESIDENT_OWNER,
        });
      }

      await user.save({ session });
      ownerUserId = user._id;

      // Email the owner
      if (isNewUser) {
        const society = await Society.findById(societyId).select('name').session(session);
        EmailService.sendFlatOwnerCreatedEmail(
          email,
          validatedData.ownerName,
          validatedData.number,
          block.name,
          society?.name || 'Society',
          passwordStr
        );
      }
    }

    const flatPayload: any = {
      number: validatedData.number,
      blockName: block.name,
      blockId: block._id,
      societyId: new mongoose.Types.ObjectId(societyId),
      status: FlatStatus.VACANT,
      plotNumber: validatedData.plotNumber,
      fullAddress: validatedData.fullAddress,
      registrationNumber: validatedData.registrationNumber,
      owners: [],
      residents: [],
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    };

    if (validatedData.latitude && validatedData.longitude) {
      flatPayload.location = { type: 'Point', coordinates: [validatedData.longitude, validatedData.latitude] };
    }

    if (ownerUserId) {
      flatPayload.ownerUserId = ownerUserId;
      flatPayload.status = FlatStatus.OWNER_OCCUPIED;
    }

    const newFlat = new Flat(flatPayload);
    await newFlat.save({ session });

    if (ownerUserId) {
      newResident = new Resident({
        flatId: newFlat._id,
        societyId: new mongoose.Types.ObjectId(societyId),
        userId: ownerUserId,
        relationship: 'OWNER',
        isOwner: true,
        isActive: true,
        createdBy: new mongoose.Types.ObjectId(userId),
        createdByName: userName,
        updatedBy: new mongoose.Types.ObjectId(userId),
        updatedByName: userName,
      });
      await newResident.save({ session });

      newFlat.residents.push(newResident._id);
      await newFlat.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

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
      newValues: { number: newFlat.number, blockId: block._id.toString() },
    });

    res.status(201).json({ message: 'Flat created successfully', flat: newFlat });
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

export const updateFlat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      plotNumber: flat.plotNumber,
      fullAddress: flat.fullAddress,
    };

    if (validatedData.status) flat.status = validatedData.status as FlatStatus;
    if (validatedData.plotNumber !== undefined) flat.plotNumber = validatedData.plotNumber;
    if (validatedData.fullAddress !== undefined) flat.fullAddress = validatedData.fullAddress;
    if (validatedData.registrationNumber !== undefined) flat.registrationNumber = validatedData.registrationNumber;
    
    if (validatedData.latitude && validatedData.longitude) {
      flat.location = { type: 'Point', coordinates: [validatedData.longitude, validatedData.latitude] };
    }

    flat.updatedBy = new mongoose.Types.ObjectId(userId);
    flat.updatedByName = userName;
    await flat.save();

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
      newValues: { status: flat.status },
    });

    res.status(200).json({ message: 'Flat updated successfully', flat });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const getFlats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const { page, pageSize, isPagination, search, status, blockId } = req.query;
    const filter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };

    if (status && ['VACANT', 'OWNER_OCCUPIED', 'RENTED'].includes(String(status))) {
      filter.status = status;
    }
    if (blockId) {
      filter.blockId = new mongoose.Types.ObjectId(String(blockId));
    }
    if (search) {
      const rx = new RegExp(String(search), 'i');
      filter.$or = [{ number: rx }, { blockName: rx }, { fullAddress: rx }];
    }

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [flats, total] = await Promise.all([
        Flat.find(filter)
          .select('-__v')
          .populate('ownerUserId', 'name email phone')
          .populate('blockId', 'name')
          .sort({ blockName: 1, number: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Flat.countDocuments(filter),
      ]);

      res.status(200).json({
        flats,
        pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
      });
      return;
    }

    const flats = await Flat.find(filter)
      .select('-__v')
      .populate('ownerUserId', 'name email phone')
      .populate('blockId', 'name')
      .sort({ blockName: 1, number: 1 })
      .lean();
    res.status(200).json({ flats });
  } catch (error) {
    next(error);
  }
};

export const getFlatById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { flatId } = req.params;
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const flat = await Flat.findOne({ _id: flatId, societyId: new mongoose.Types.ObjectId(societyId) })
      .populate('ownerUserId', 'name email phone')
      .populate({
        path: 'residents',
        populate: { path: 'userId', select: 'name email phone' }
      })
      .lean();

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    res.status(200).json({ flat });
  } catch (error) {
    next(error);
  }
};

export const deleteFlat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { flatId } = req.params;
    const societyId = req.user?.activeTenantId;

    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const flat = await Flat.findOne({ _id: flatId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    // Remove associated residents
    await Resident.deleteMany({ flatId: flat._id });
    await flat.deleteOne();

    res.status(200).json({ message: 'Flat deleted successfully' });
  } catch (error) {
    next(error);
  }
};

export const downloadBulkUploadTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const workbook = xlsx.utils.book_new();
    const worksheetData = [
      ['Block Name', 'Flat Number', 'Plot Number', 'Full Address', 'Registration Number', 'Owner Name', 'Owner Email', 'Owner Phone', 'Latitude', 'Longitude'],
      ['Tower A', '101', '', 'Address line 1', '', 'John Doe', 'john.doe@example.com', '+919876543210', '', '']
    ];
    const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
    
    const wscols = [
      {wch: 15}, {wch: 15}, {wch: 15}, {wch: 30}, {wch: 20}, {wch: 20}, {wch: 25}, {wch: 15}, {wch: 15}, {wch: 15}
    ];
    worksheet['!cols'] = wscols;

    xlsx.utils.book_append_sheet(workbook, worksheet, 'Flats');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename="flats_bulk_upload_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.status(200).send(buffer);
  } catch (error) {
    next(error);
  }
};

export const bulkUploadFlats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No Excel file provided' });
      return;
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const rawData = xlsx.utils.sheet_to_json<any>(worksheet);
    
    const errors: string[] = [];
    let successCount = 0;
    
    const society = await Society.findById(societyId).select('name');

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      const rowNum = i + 2; // +1 for 0-index, +1 for header
      
      try {
        const rowData = {
          blockName: String(row['Block Name'] || '').trim(),
          number: String(row['Flat Number'] || '').trim(),
          plotNumber: row['Plot Number'] ? String(row['Plot Number']).trim() : undefined,
          fullAddress: row['Full Address'] ? String(row['Full Address']).trim() : undefined,
          registrationNumber: row['Registration Number'] ? String(row['Registration Number']).trim() : undefined,
          ownerName: row['Owner Name'] ? String(row['Owner Name']).trim() : undefined,
          ownerEmail: row['Owner Email'] ? String(row['Owner Email']).trim() : undefined,
          ownerPhone: row['Owner Phone'] ? String(row['Owner Phone']).trim() : undefined,
          latitude: row['Latitude'] ? Number(row['Latitude']) : undefined,
          longitude: row['Longitude'] ? Number(row['Longitude']) : undefined,
        };
        
        // Remove undefined fields for zod parsing
        Object.keys(rowData).forEach(key => (rowData as any)[key] === undefined && delete (rowData as any)[key]);
        
        const validated = bulkUploadFlatRowSchema.parse(rowData);
        
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
          // 1. Find or create block
          let block = await Block.findOne({ societyId: new mongoose.Types.ObjectId(societyId), name: validated.blockName }).session(session);
          if (!block) {
            block = new Block({
              name: validated.blockName,
              societyId: new mongoose.Types.ObjectId(societyId),
              createdBy: new mongoose.Types.ObjectId(userId),
              createdByName: userName,
              updatedBy: new mongoose.Types.ObjectId(userId),
              updatedByName: userName,
            });
            await block.save({ session });
          }
          
          // 2. Check if flat exists
          const existingFlat = await Flat.findOne({
            societyId: new mongoose.Types.ObjectId(societyId),
            blockId: block._id,
            number: validated.number,
          }).session(session);
          
          if (existingFlat) {
            throw new Error('Flat already exists in this block');
          }
          
          // 3. Process Owner
          let ownerUserId: mongoose.Types.ObjectId | undefined;
          let newResident: any = null;
          
          if (validated.ownerEmail && validated.ownerName) {
            const email = validated.ownerEmail.toLowerCase();
            let user = await User.findOne({ email }).session(session);
            let isNewUser = false;
            let passwordStr = '';
            
            if (!user) {
              isNewUser = true;
              passwordStr = crypto.randomBytes(6).toString('hex');
              const passwordHash = await hashPassword(passwordStr);
              
              user = new User({
                name: validated.ownerName,
                email,
                passwordHash,
                memberships: [],
              });
            }
            
            const hasMembership = user.memberships.some(
              (m) => m.tenantId.toString() === societyId && m.tenantType === TenantType.SOCIETY
            );

            if (!hasMembership) {
              user.memberships.push({
                tenantType: TenantType.SOCIETY,
                tenantId: new mongoose.Types.ObjectId(societyId),
                role: UserRole.RESIDENT_OWNER,
              });
            }

            await user.save({ session });
            ownerUserId = user._id;

            if (isNewUser) {
              EmailService.sendFlatOwnerCreatedEmail(
                email,
                validated.ownerName,
                validated.number,
                block.name,
                society?.name || 'Society',
                passwordStr
              );
            }
          }
          
          // 4. Create Flat
          const flatPayload: any = {
            number: validated.number,
            blockName: block.name,
            blockId: block._id,
            societyId: new mongoose.Types.ObjectId(societyId),
            status: FlatStatus.VACANT,
            plotNumber: validated.plotNumber,
            fullAddress: validated.fullAddress,
            registrationNumber: validated.registrationNumber,
            owners: [],
            residents: [],
            createdBy: new mongoose.Types.ObjectId(userId),
            createdByName: userName,
            updatedBy: new mongoose.Types.ObjectId(userId),
            updatedByName: userName,
          };

          if (validated.latitude && validated.longitude && !isNaN(validated.latitude) && !isNaN(validated.longitude)) {
            flatPayload.location = { type: 'Point', coordinates: [validated.longitude, validated.latitude] };
          }

          if (ownerUserId) {
            flatPayload.ownerUserId = ownerUserId;
            flatPayload.status = FlatStatus.OWNER_OCCUPIED;
          }

          const newFlat = new Flat(flatPayload);
          await newFlat.save({ session });

          // 5. Create Resident
          if (ownerUserId) {
            newResident = new Resident({
              flatId: newFlat._id,
              societyId: new mongoose.Types.ObjectId(societyId),
              userId: ownerUserId,
              relationship: 'OWNER',
              isOwner: true,
              isActive: true,
              createdBy: new mongoose.Types.ObjectId(userId),
              createdByName: userName,
              updatedBy: new mongoose.Types.ObjectId(userId),
              updatedByName: userName,
            });
            await newResident.save({ session });

            newFlat.residents.push(newResident._id);
            await newFlat.save({ session });
          }
          
          await session.commitTransaction();
          session.endSession();
          successCount++;
          
        } catch (txnError: any) {
          await session.abortTransaction();
          session.endSession();
          throw txnError;
        }
      } catch (err: any) {
        if (err.name === 'ZodError') {
          const msg = err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
          errors.push(`Row ${rowNum}: Validation failed - ${msg}`);
        } else {
          errors.push(`Row ${rowNum}: ${err.message}`);
        }
      }
    }
    
    res.status(200).json({
      message: `Bulk upload processed. ${successCount} imported successfully, ${errors.length} failed.`,
      successCount,
      errorCount: errors.length,
      errors
    });

  } catch (error) {
    next(error);
  }
};
