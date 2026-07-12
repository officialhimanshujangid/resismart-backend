import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import * as xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import { Flat, FlatStatus } from '../models/flat.model';
import { FlatSize } from '../models/flat-size.model';
import { Block } from '../models/block.model';
import { User } from '../models/user.model';
import { Resident } from '../models/resident.model';
import { Society } from '../models/society.model';
import { createFlatSchema, updateFlatSchema, bulkUploadFlatRowSchema } from '../validators/society.validator';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { hashPassword } from '../utils/hash.util';
import { normalizePhone } from '../utils/phone.util';
import { assertVerified, consumeVerification } from '../services/otp.service';
import { attachTenantMembership, primaryIdentityId } from '../services/identity.service';
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
    let ownerIdentityIds: mongoose.Types.ObjectId[] = [];
    let newResident: any = null;
    // Consumed after the transaction commits so the one-time tokens can't be reused.
    let consumeEmail = '';
    let consumePhone = '';

    if (validatedData.ownerEmail && validatedData.ownerName) {
      const email = validatedData.ownerEmail.toLowerCase();
      const normPhone = validatedData.ownerPhone ? normalizePhone(validatedData.ownerPhone) : '';

      if (!normPhone) {
        await session.abortTransaction();
        session.endSession();
        res.status(400).json({ error: 'A valid owner phone number is required.' });
        return;
      }

      // BOTH the owner email and phone must be OTP-verified.
      const [emailOk, phoneOk] = await Promise.all([
        assertVerified(validatedData.ownerEmailVerificationToken || '', 'EMAIL', email, 'FLAT_REGISTRATION'),
        assertVerified(validatedData.ownerPhoneVerificationToken || '', 'PHONE', normPhone, 'FLAT_REGISTRATION'),
      ]);
      if (!emailOk || !phoneOk) {
        await session.abortTransaction();
        session.endSession();
        res.status(400).json({ error: `Owner ${!emailOk ? 'email' : 'phone number'} is not verified. Please verify via OTP.` });
        return;
      }

      // Identifier-scoped, passwordless: grant RESIDENT_OWNER to BOTH the email
      // identity and the phone identity so either can log in and see this flat.
      const identities = await attachTenantMembership({
        email,
        phone: normPhone,
        name: validatedData.ownerName,
        tenantType: TenantType.SOCIETY,
        tenantId: societyId,
        role: UserRole.RESIDENT_OWNER,
      }, session);

      ownerUserId = primaryIdentityId(identities);
      ownerIdentityIds = [identities.emailUser?._id, identities.phoneUser?._id]
        .filter(Boolean) as mongoose.Types.ObjectId[];
      consumeEmail = email;
      consumePhone = normPhone;

      const society = await Society.findById(societyId).select('name').session(session);
      EmailService.sendTenantAccessEmail(email, `${block.name}-${validatedData.number}`, 'flat', [['Society', society?.name || 'Society']]);
    }

    // Retrieve society for location if needed
    const society = await Society.findById(societyId).select('name location').session(session);

    const flatPayload: any = {
      number: validatedData.number,
      blockName: block.name,
      blockId: block._id,
      societyId: new mongoose.Types.ObjectId(societyId),
      status: FlatStatus.VACANT,
      fullAddress: validatedData.fullAddress,
      registrationNumber: validatedData.registrationNumber,
      owners: [],
      residents: [],
      familyMembers: [],
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    };

    if (validatedData.latitude && validatedData.longitude) {
      flatPayload.location = { type: 'Point', coordinates: [validatedData.longitude, validatedData.latitude] };
    } else if (society?.location) {
      flatPayload.location = society.location;
    }

    if (validatedData.sizeId) {
      flatPayload.size = new mongoose.Types.ObjectId(validatedData.sizeId);
    }

    if (validatedData.headOfFamily) {
      flatPayload.headOfFamily = new mongoose.Types.ObjectId(validatedData.headOfFamily);
    }

    if (validatedData.familyMembers) {
      flatPayload.familyMembers = validatedData.familyMembers.map((id: string) => new mongoose.Types.ObjectId(id));
    }

    if (ownerUserId) {
      flatPayload.ownerUserId = ownerUserId;
      flatPayload.status = FlatStatus.OWNER_OCCUPIED;
    }

    const newFlat = new Flat(flatPayload);
    await newFlat.save({ session });

    if (ownerIdentityIds.length) {
      // One OWNER Resident row per identity (email + phone) so either login sees the flat.
      for (const uid of ownerIdentityIds) {
        newResident = new Resident({
          flatId: newFlat._id,
          societyId: new mongoose.Types.ObjectId(societyId),
          userId: uid,
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
      }
      await newFlat.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    // One-time use: burn the owner's verifications now that the flat exists.
    if (consumeEmail) await consumeVerification('EMAIL', consumeEmail, 'FLAT_REGISTRATION');
    if (consumePhone) await consumeVerification('PHONE', consumePhone, 'FLAT_REGISTRATION');

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
      fullAddress: flat.fullAddress,
    };

    if (validatedData.status) flat.status = validatedData.status as FlatStatus;
    if (validatedData.fullAddress !== undefined) flat.fullAddress = validatedData.fullAddress;
    if (validatedData.registrationNumber !== undefined) flat.registrationNumber = validatedData.registrationNumber;

    if (validatedData.sizeId !== undefined) {
      flat.size = validatedData.sizeId ? new mongoose.Types.ObjectId(validatedData.sizeId) : undefined;
    }
    if (validatedData.headOfFamily !== undefined) {
      flat.headOfFamily = validatedData.headOfFamily ? new mongoose.Types.ObjectId(validatedData.headOfFamily) : undefined;
    }
    if (validatedData.familyMembers !== undefined) {
      flat.familyMembers = validatedData.familyMembers.map((id: string) => new mongoose.Types.ObjectId(id));
    }

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

    const { page, pageSize, isPagination, search, status, blockId, myFlatsOnly } = req.query;
    const filter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };

    // Flat owner listing flow: only show flats the caller owns
    if (myFlatsOnly === 'true' && req.user?.userId) {
      filter.ownerUserId = new mongoose.Types.ObjectId(req.user.userId);
    }

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
          .populate('size', 'name details')
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
      .populate('size', 'name details')
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

    if (!mongoose.Types.ObjectId.isValid(flatId)) {
      res.status(400).json({ error: 'Invalid flat ID format' });
      return;
    }

    const flat = await Flat.findOne({ _id: flatId, societyId: new mongoose.Types.ObjectId(societyId) })
      .populate('ownerUserId', 'name email phone')
      .populate('size', 'name details')
      .populate('headOfFamily', 'name email phone')
      .populate('familyMembers', 'name email phone')
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
    const userId = req.user?.userId;
    const userName = req.user?.userName;

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

    AuditService.log({
      userId: userId || 'system',
      userName: userName || 'system',
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_DELETE',
      resource: 'Flat',
      resourceId: flat._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues: { number: flat.number, blockName: flat.blockName },
    });

    res.status(200).json({ message: 'Flat deleted successfully' });
  } catch (error) {
    next(error);
  }
};

export const downloadBulkUploadTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(401).json({ error: 'Missing tenant details' });
      return;
    }

    const blocks = await Block.find({ societyId: new mongoose.Types.ObjectId(societyId) }).select('name').lean();
    const flatSizes = await FlatSize.find({ societyId: new mongoose.Types.ObjectId(societyId) }).select('name details').lean();

    const blockNames = blocks.map(b => b.name);
    const sizeNames = flatSizes.map(s => `${s.name}${s.details ? ` (${s.details})` : ''}`);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Flats');

    worksheet.columns = [
      { header: 'Block Name', key: 'block', width: 20 },
      { header: 'Flat Number', key: 'number', width: 15 },
      { header: 'Flat Size', key: 'size', width: 25 },
      { header: 'Full Address', key: 'address', width: 30 },
      { header: 'Registration Number', key: 'registration', width: 20 },
      { header: 'Owner Name', key: 'ownerName', width: 20 },
      { header: 'Owner Email', key: 'ownerEmail', width: 25 },
      { header: 'Owner Phone', key: 'ownerPhone', width: 20 },
      { header: 'Latitude', key: 'lat', width: 15 },
      { header: 'Longitude', key: 'lng', width: 15 },
    ];

    // Example row
    worksheet.addRow({
      block: blockNames[0] || 'Tower A',
      number: '101',
      size: sizeNames[0] || '',
      address: 'Address line 1',
      ownerName: 'John Doe',
      ownerEmail: 'john.doe@example.com',
      ownerPhone: '+919876543210'
    });

    const refSheet = workbook.addWorksheet('_reference', { state: 'hidden' });
    refSheet.getColumn('A').values = blockNames.length > 0 ? blockNames : ['(No Blocks)'];
    refSheet.getColumn('B').values = sizeNames.length > 0 ? sizeNames : ['(No Sizes)'];

    for (let i = 2; i <= 1000; i++) {
      worksheet.getCell(`A${i}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`_reference!$A$1:$A$${Math.max(1, blockNames.length)}`]
      };

      worksheet.getCell(`C${i}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`_reference!$B$1:$B$${Math.max(1, sizeNames.length)}`]
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();

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

    const results: Array<{ row: number; block: string; flat: string; status: 'SUCCESS' | 'FAILED' | 'DUPLICATE'; reason: string }> = [];
    let successCount = 0;
    let failedCount = 0;
    let duplicateCount = 0;

    const society = await Society.findById(societyId).select('name location');

    // Fetch valid blocks and sizes
    const blocks = await Block.find({ societyId: new mongoose.Types.ObjectId(societyId) }).select('_id name');
    const flatSizes = await FlatSize.find({ societyId: new mongoose.Types.ObjectId(societyId) }).select('_id name details');

    const blockMap = new Map(blocks.map(b => [b.name, b._id]));
    const sizeMap = new Map(flatSizes.map(s => {
      const label = `${s.name}${s.details ? ` (${s.details})` : ''}`;
      return [label, s._id];
    }));

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      const rowNum = i + 2; // +1 for 0-index, +1 for header

      const blockName = String(row['Block Name'] || '').trim();
      const number = String(row['Flat Number'] || '').trim();
      const sizeName = String(row['Flat Size'] || '').trim();

      let status: 'SUCCESS' | 'FAILED' | 'DUPLICATE' = 'FAILED';
      let reason = '';

      try {
        if (!blockName || !number) {
          throw new Error('Block Name and Flat Number are required.');
        }

        const blockId = blockMap.get(blockName);
        if (!blockId) {
          throw new Error(`Invalid Block Name "${blockName}". You must select from existing blocks.`);
        }

        let sizeId = undefined;
        if (sizeName) {
          sizeId = sizeMap.get(sizeName);
          if (!sizeId) {
            throw new Error(`Invalid Flat Size "${sizeName}". You must select from existing sizes.`);
          }
        }

        const rowDataToValidate = {
          blockName,
          number,
          fullAddress: row['Full Address'] ? String(row['Full Address']).trim() : undefined,
          registrationNumber: row['Registration Number'] ? String(row['Registration Number']).trim() : undefined,
          ownerName: row['Owner Name'] ? String(row['Owner Name']).trim() : undefined,
          ownerEmail: row['Owner Email'] ? String(row['Owner Email']).trim() : undefined,
          ownerPhone: row['Owner Phone'] ? String(row['Owner Phone']).trim() : undefined,
          latitude: row['Latitude'] ? Number(row['Latitude']) : undefined,
          longitude: row['Longitude'] ? Number(row['Longitude']) : undefined,
        };

        Object.keys(rowDataToValidate).forEach(key => (rowDataToValidate as any)[key] === undefined && delete (rowDataToValidate as any)[key]);
        const validated = bulkUploadFlatRowSchema.parse(rowDataToValidate);

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const existingFlat = await Flat.findOne({
            societyId: new mongoose.Types.ObjectId(societyId),
            blockId: blockId,
            number: validated.number,
          }).session(session);

          if (existingFlat) {
            status = 'DUPLICATE';
            throw new Error('Flat already exists in this block.');
          }

          let ownerUserId: mongoose.Types.ObjectId | undefined;
          let ownerIdentityIds: mongoose.Types.ObjectId[] = [];
          let newResident: any = null;

          if (validated.ownerEmail && validated.ownerName) {
            // Identifier-scoped, passwordless (bulk is admin-trusted, no OTP).
            const email = validated.ownerEmail.toLowerCase();
            const identities = await attachTenantMembership({
              email,
              phone: validated.ownerPhone,
              name: validated.ownerName,
              tenantType: TenantType.SOCIETY,
              tenantId: societyId,
              role: UserRole.RESIDENT_OWNER,
            }, session);
            ownerUserId = primaryIdentityId(identities);
            ownerIdentityIds = [identities.emailUser?._id, identities.phoneUser?._id]
              .filter(Boolean) as mongoose.Types.ObjectId[];
            EmailService.sendTenantAccessEmail(email, `${blockName}-${validated.number}`, 'flat', [['Society', society?.name || 'Society']]);
          }

          const flatPayload: any = {
            number: validated.number,
            blockName: blockName,
            blockId: blockId,
            sizeId,
            societyId: new mongoose.Types.ObjectId(societyId),
            status: FlatStatus.VACANT,
            fullAddress: validated.fullAddress,
            registrationNumber: validated.registrationNumber,
            owners: [],
            residents: [],
            familyMembers: [],
            createdBy: new mongoose.Types.ObjectId(userId),
            createdByName: userName,
            updatedBy: new mongoose.Types.ObjectId(userId),
            updatedByName: userName,
          };

          if (validated.latitude && validated.longitude && !isNaN(validated.latitude) && !isNaN(validated.longitude)) {
            flatPayload.location = { type: 'Point', coordinates: [validated.longitude, validated.latitude] };
          } else if (society?.location) {
            flatPayload.location = society.location;
          }

          if (ownerUserId) {
            flatPayload.ownerUserId = ownerUserId;
            flatPayload.status = FlatStatus.OWNER_OCCUPIED;
          }

          const newFlat = new Flat(flatPayload);
          await newFlat.save({ session });

          if (ownerIdentityIds.length) {
            for (const uid of ownerIdentityIds) {
              newResident = new Resident({
                flatId: newFlat._id,
                societyId: new mongoose.Types.ObjectId(societyId),
                userId: uid,
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
            }
            await newFlat.save({ session });
          }

          await session.commitTransaction();
          session.endSession();

          status = 'SUCCESS';
          reason = 'Created successfully';
          successCount++;
        } catch (txnError: any) {
          await session.abortTransaction();
          session.endSession();
          throw txnError;
        }
      } catch (err: any) {
        if ((status as string) !== 'DUPLICATE') {
          status = 'FAILED';
          failedCount++;
        } else {
          duplicateCount++;
        }

        if (err.name === 'ZodError') {
          const msg = err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
          reason = `Validation failed - ${msg}`;
        } else {
          reason = err.message;
        }
      }

      results.push({ row: rowNum, block: blockName, flat: number, status, reason });
    }

    res.status(200).json({
      summary: { total: rawData.length, success: successCount, failed: failedCount, duplicates: duplicateCount },
      results
    });

  } catch (error) {
    next(error);
  }
};

export const getFlatFormLookup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(401).json({ error: 'Missing tenant details' });
      return;
    }

    const { flatId } = req.query;

    if (flatId && typeof flatId === 'string' && !mongoose.Types.ObjectId.isValid(flatId)) {
      res.status(400).json({ error: 'Invalid flat ID format' });
      return;
    }

    const [blocks, flatSizes, society, flat] = await Promise.all([
      Block.find({ societyId }).sort({ name: 1 }).lean(),
      FlatSize.find({ societyId }).sort({ name: 1 }).lean(),
      Society.findById(societyId).lean(),
      flatId ? Flat.findById(flatId).populate('ownerUserId', 'name email phone').populate('blockId').populate('size').lean() : Promise.resolve(null)
    ]);

    res.status(200).json({ blocks, flatSizes, society, flat });
  } catch (error) {
    next(error);
  }
};
