import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/user.model';
import { SystemEmployee } from '../models/system-employee.model';
import { Designation } from '../models/designation.model';
import { PermissionRole } from '../models/permission-role.model';
import {
  createSystemEmployeeSchema,
  updateSystemEmployeeSchema,
} from '../validators/system-employee.validator';
import { TenantType, UserRole } from '../constants/roles';
import EmailService from '../services/email.service';
import AuditService from '../services/audit.service';

// Auto-generate employee code: EMP-XXXXXX
const generateEmployeeCode = (): string => {
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `EMP-${suffix}`;
};

export const createSystemEmployee = async (req: Request, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const parsed = createSystemEmployeeSchema.safeParse(req.body);
    if (!parsed.success) {
      await session.abortTransaction();
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const {
      name, email, password, phone, designationId, permissionRoleId,
      bankDetails, address, dateOfBirth, dateOfJoining, emergencyContact,
      reportingManagerId, profileImage
    } = parsed.data;

    // Validate references exist
    const [designation, permissionRole] = await Promise.all([
      Designation.findById(designationId).lean(),
      PermissionRole.findById(permissionRoleId).lean(),
    ]);

    if (!designation || !designation.isActive) {
      await session.abortTransaction();
      res.status(404).json({ error: 'Designation not found or inactive' });
      return;
    }
    if (!permissionRole || !permissionRole.isActive) {
      await session.abortTransaction();
      res.status(404).json({ error: 'Permission role not found or inactive' });
      return;
    }

    // Check email uniqueness
    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      await session.abortTransaction();
      res.status(409).json({ error: 'A user with this email already exists' });
      return;
    }

    // Use SYSTEM tenant (owner's tenantId) from the JWT
    const ownerTenantId = req.user!.activeTenantId;

    const passwordHash = await bcrypt.hash(password, 12);

    // Create User identity
    const [newUser] = await User.create(
      [
        {
          name,
          email,
          passwordHash,
          isActive: true,
          profileImage,
          memberships: [
            {
              tenantType: TenantType.SYSTEM,
              tenantId: new mongoose.Types.ObjectId(ownerTenantId),
              role: UserRole.SYSTEM_EMPLOYEE,
            },
          ],
        },
      ],
      { session }
    );

    // Generate unique employee code
    let employeeCode = generateEmployeeCode();
    let codeExists = await SystemEmployee.findOne({ employeeCode }).lean();
    while (codeExists) {
      employeeCode = generateEmployeeCode();
      codeExists = await SystemEmployee.findOne({ employeeCode }).lean();
    }

    // Create SystemEmployee profile
    const [employee] = await SystemEmployee.create(
      [
        {
          userId: newUser._id,
          designationId,
          permissionRoleId,
          employeeCode,
          phone,
          isActive: true,
          createdBy: new mongoose.Types.ObjectId(req.user!.userId),
          bankDetails,
          address,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          dateOfJoining: dateOfJoining ? new Date(dateOfJoining) : undefined,
          emergencyContact,
          reportingManagerId: reportingManagerId ? new mongoose.Types.ObjectId(reportingManagerId) : undefined,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    // Trigger Welcoming email
    EmailService.sendEmployeeCreatedEmail(
      email,
      name,
      password,
      designation.name
    );

    // Write audit log
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    AuditService.log({
      userId: req.user!.userId,
      userName: req.user!.userName || 'System Owner',
      tenantId: null,
      tenantType: TenantType.SYSTEM,
      action: 'SYSTEM_EMPLOYEE_CREATE',
      resource: 'SystemEmployee',
      resourceId: employee._id,
      ipAddress,
      userAgent,
      newValues: {
        employeeCode,
        name,
        email,
        phone,
        designation: designation.name,
        permissionRole: permissionRole.name,
        bankDetails,
        address,
        dateOfBirth,
        dateOfJoining,
        emergencyContact,
        reportingManagerId,
      }
    });

    res.status(201).json({
      message: 'System employee created successfully',
      employee: {
        ...employee.toObject(),
        user: { name: newUser.name, email: newUser.email },
      },
    });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: 'Failed to create system employee' });
  } finally {
    session.endSession();
  }
};

export const getSystemEmployees = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      includeInactive,
      search,
      status,
      designationId,
      permissionRoleId,
      startDate,
      endDate,
      joiningStartDate,
      joiningEndDate,
      isPagination,
      page,
      pageSize,
    } = req.query;

    const filter: any = {};

    // Status filter
    if (status === 'active') {
      filter.isActive = true;
    } else if (status === 'inactive') {
      filter.isActive = false;
    } else if (status === 'all') {
      // do nothing, includes both
    } else {
      // Default fallback using includeInactive
      if (includeInactive !== 'true') {
        filter.isActive = true;
      }
    }

    // Designation filter
    if (designationId) {
      filter.designationId = designationId;
    }

    // Permission Role filter
    if (permissionRoleId) {
      filter.permissionRoleId = permissionRoleId;
    }

    // Date range filter (createdAt)
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(String(startDate));
      }
      if (endDate) {
        const end = new Date(String(endDate));
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Date range filter (dateOfJoining)
    if (joiningStartDate || joiningEndDate) {
      filter.dateOfJoining = {};
      if (joiningStartDate) {
        filter.dateOfJoining.$gte = new Date(String(joiningStartDate));
      }
      if (joiningEndDate) {
        const end = new Date(String(joiningEndDate));
        end.setHours(23, 59, 59, 999);
        filter.dateOfJoining.$lte = end;
      }
    }

    // Search filter (name, email, phone, employeeCode)
    if (search) {
      const searchStr = String(search);
      // Query the User collection for name/email match
      const matchingUsers = await User.find({
        $or: [
          { name: new RegExp(searchStr, 'i') },
          { email: new RegExp(searchStr, 'i') }
        ]
      }).select('_id').lean();

      const userIds = matchingUsers.map(u => u._id);

      filter.$or = [
        { phone: new RegExp(searchStr, 'i') },
        { employeeCode: new RegExp(searchStr, 'i') },
        { userId: { $in: userIds } }
      ];
    }

    const populateFields = (query: ReturnType<typeof SystemEmployee.find>) =>
      query
        .populate('userId', 'name email isActive profileImage')
        .populate('designationId', 'name')
        .populate('permissionRoleId', 'name')
        .populate('createdBy', 'name')
        .populate('updatedBy', 'name')
        .populate('reportingManagerId', 'name email')
        .sort({ createdAt: -1 });

    // Pagination: only apply when isPagination=true
    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [employees, total] = await Promise.all([
        populateFields(SystemEmployee.find(filter)).skip(skip).limit(limit),
        SystemEmployee.countDocuments(filter),
      ]);

      res.json({
        employees,
        pagination: {
          total,
          page: currentPage,
          pageSize: limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } else {
      // Non-paginated: return all (used for dropdowns / selects)
      const employees = await populateFields(SystemEmployee.find(filter));
      res.json({ employees });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system employees' });
  }
};

export const getSystemEmployeeById = async (req: Request, res: Response): Promise<void> => {
  try {
    const employee = await SystemEmployee.findById(req.params.id)
      .populate('userId', 'name email isActive profileImage')
      .populate('designationId', 'name description')
      .populate('permissionRoleId', 'name permissions')
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name')
      .populate('reportingManagerId', 'name email');

    if (!employee) {
      res.status(404).json({ error: 'System employee not found' });
      return;
    }
    res.json({ employee });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system employee' });
  }
};

export const updateSystemEmployee = async (req: Request, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const parsed = updateSystemEmployeeSchema.safeParse(req.body);
    if (!parsed.success) {
      await session.abortTransaction();
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const employee = await SystemEmployee.findById(req.params.id).session(session);
    if (!employee) {
      await session.abortTransaction();
      res.status(404).json({ error: 'System employee not found' });
      return;
    }

    const oldEmployeeObject = employee.toObject();

    const {
      name, phone, designationId, permissionRoleId, isActive,
      bankDetails, address, dateOfBirth, dateOfJoining, emergencyContact,
      reportingManagerId, profileImage
    } = parsed.data;

    // Update User name and profileImage if provided
    const userUpdate: any = {};
    if (name) userUpdate.name = name;
    if (profileImage !== undefined) userUpdate.profileImage = profileImage;
    if (Object.keys(userUpdate).length > 0) {
      await User.findByIdAndUpdate(employee.userId, userUpdate, { session });
    }

    // Update employee record
    if (designationId) employee.designationId = new mongoose.Types.ObjectId(designationId);
    if (permissionRoleId) employee.permissionRoleId = new mongoose.Types.ObjectId(permissionRoleId);
    if (phone !== undefined) employee.phone = phone;
    if (isActive !== undefined) {
      employee.isActive = isActive;
      await User.findByIdAndUpdate(employee.userId, { isActive }, { session });
    }

    // Set updatedBy
    employee.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);

    // Update other details
    if (bankDetails) {
      employee.bankDetails = {
        bankName: bankDetails.bankName ?? employee.bankDetails?.bankName ?? '',
        accountNumber: bankDetails.accountNumber ?? employee.bankDetails?.accountNumber ?? '',
        ifscCode: bankDetails.ifscCode ?? employee.bankDetails?.ifscCode ?? '',
      };
    }
    if (address) {
      employee.address = {
        street: address.street ?? employee.address?.street ?? '',
        city: address.city ?? employee.address?.city ?? '',
        state: address.state ?? employee.address?.state ?? '',
        zipCode: address.zipCode ?? employee.address?.zipCode ?? '',
        country: address.country ?? employee.address?.country ?? '',
      };
    }
    if (dateOfBirth !== undefined) {
      employee.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : undefined;
    }
    if (dateOfJoining !== undefined) {
      employee.dateOfJoining = dateOfJoining ? new Date(dateOfJoining) : undefined;
    }
    if (emergencyContact !== undefined) {
      employee.emergencyContact = emergencyContact;
    }
    if (reportingManagerId !== undefined) {
      employee.reportingManagerId = reportingManagerId ? new mongoose.Types.ObjectId(reportingManagerId) : undefined;
    }

    await employee.save({ session });
    await session.commitTransaction();

    // Fetch designation details for email / logs
    const activeDesignation = await Designation.findById(employee.designationId).lean();
    const activeDesignationName = activeDesignation?.name || 'Employee';

    // Fetch user details for email
    const updatedUser = await User.findById(employee.userId).lean();
    const employeeEmail = updatedUser?.email || '';
    const employeeName = updatedUser?.name || '';

    // Write audit log
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    AuditService.log({
      userId: req.user!.userId,
      userName: req.user!.userName || 'System Owner',
      tenantId: null,
      tenantType: TenantType.SYSTEM,
      action: 'SYSTEM_EMPLOYEE_UPDATE',
      resource: 'SystemEmployee',
      resourceId: employee._id,
      ipAddress,
      userAgent,
      oldValues: oldEmployeeObject,
      newValues: employee.toObject(),
    });

    // Send update email
    if (employeeEmail) {
      EmailService.sendEmployeeUpdatedEmail(
        employeeEmail,
        employeeName,
        activeDesignationName
      );
    }

    res.json({ message: 'System employee updated successfully', employee });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: 'Failed to update system employee' });
  } finally {
    session.endSession();
  }
};

export const deleteSystemEmployee = async (req: Request, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const employee = await SystemEmployee.findById(req.params.id).session(session);
    if (!employee) {
      await session.abortTransaction();
      res.status(404).json({ error: 'System employee not found' });
      return;
    }

    employee.isActive = false;
    employee.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    await employee.save({ session });
    await User.findByIdAndUpdate(employee.userId, { isActive: false }, { session });

    await session.commitTransaction();

    // Write audit log
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    AuditService.log({
      userId: req.user!.userId,
      userName: req.user!.userName || 'System Owner',
      tenantId: null,
      tenantType: TenantType.SYSTEM,
      action: 'SYSTEM_EMPLOYEE_DEACTIVATE',
      resource: 'SystemEmployee',
      resourceId: employee._id,
      ipAddress,
      userAgent,
    });

    res.json({ message: 'System employee deactivated successfully' });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: 'Failed to deactivate system employee' });
  } finally {
    session.endSession();
  }
};

// Called by SYSTEM_EMPLOYEE on login to load their permissions for the sidebar
export const getMyPermissions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const employee = await SystemEmployee.findOne({ userId, isActive: true })
      .populate('permissionRoleId', 'name permissions')
      .populate('designationId', 'name')
      .lean();

    if (!employee) {
      res.status(404).json({ error: 'System employee profile not found' });
      return;
    }

    const permissionRole = employee.permissionRoleId as any;

    res.json({
      employeeCode: employee.employeeCode,
      designation: (employee.designationId as any)?.name,
      permissionRoleName: permissionRole?.name,
      permissions: permissionRole?.permissions ?? [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
};

export const getReportingManagers = async (req: Request, res: Response): Promise<void> => {
  try {
    const ownerTenantId = req.user!.activeTenantId;
    
    // Find all users who are either system owner or system employee under the current tenant
    const managers = await User.find({
      memberships: {
        $elemMatch: {
          tenantId: new mongoose.Types.ObjectId(ownerTenantId),
          role: { $in: [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE] }
        }
      },
      isActive: true
    }).select('name email profileImage').sort({ name: 1 }).lean();

    res.json({ managers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reporting managers' });
  }
};
