import { Request, Response } from 'express';
import { Designation } from '../models/designation.model';
import {
  createDesignationSchema,
  updateDesignationSchema,
} from '../validators/designation.validator';

export const createDesignation = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = createDesignationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const existing = await Designation.findOne({ name: parsed.data.name });
    if (existing) {
      res.status(409).json({ error: 'A designation with this name already exists' });
      return;
    }

    const designation = await Designation.create({
      ...parsed.data,
      createdBy: req.user!.userId,
    });
    res.status(201).json({ message: 'Designation created successfully', designation });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create designation' });
  }
};

export const getDesignations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { includeInactive, search, status, startDate, endDate, isPagination, page, pageSize } = req.query;
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

    // Search filter
    if (search) {
      const searchRegex = new RegExp(String(search), 'i');
      filter.$or = [
        { name: searchRegex },
        { description: searchRegex }
      ];
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

    // Pagination: only apply when isPagination=true
    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [designations, total] = await Promise.all([
        Designation.find(filter)
          .populate('createdBy', 'name')
          .populate('updatedBy', 'name')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Designation.countDocuments(filter),
      ]);

      res.json({
        designations,
        pagination: {
          total,
          page: currentPage,
          pageSize: limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } else {
      // Non-paginated: return all (used for dropdowns / selects)
      const designations = await Designation.find(filter)
        .populate('createdBy', 'name')
        .populate('updatedBy', 'name')
        .sort({ createdAt: -1 });
      res.json({ designations });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch designations' });
  }
};

export const getDesignationById = async (req: Request, res: Response): Promise<void> => {
  try {
    const designation = await Designation.findById(req.params.id)
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name');
    if (!designation) {
      res.status(404).json({ error: 'Designation not found' });
      return;
    }
    res.json({ designation });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch designation' });
  }
};

export const updateDesignation = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = updateDesignationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    if (parsed.data.name) {
      const conflict = await Designation.findOne({ name: parsed.data.name, _id: { $ne: req.params.id } });
      if (conflict) {
        res.status(409).json({ error: 'A designation with this name already exists' });
        return;
      }
    }

    const designation = await Designation.findByIdAndUpdate(
      req.params.id,
      {
        ...parsed.data,
        updatedBy: req.user!.userId,
      },
      { new: true }
    );
    if (!designation) {
      res.status(404).json({ error: 'Designation not found' });
      return;
    }
    res.json({ message: 'Designation updated successfully', designation });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update designation' });
  }
};

export const deleteDesignation = async (req: Request, res: Response): Promise<void> => {
  try {
    const designation = await Designation.findByIdAndUpdate(
      req.params.id,
      { 
        isActive: false,
        updatedBy: req.user!.userId,
      },
      { new: true }
    );
    if (!designation) {
      res.status(404).json({ error: 'Designation not found' });
      return;
    }
    res.json({ message: 'Designation deactivated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete designation' });
  }
};
