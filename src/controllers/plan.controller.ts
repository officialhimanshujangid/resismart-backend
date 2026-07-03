import { Request, Response } from 'express';
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { createPlanSchema, updatePlanSchema } from '../validators/plan.validator';
import { ensureRazorpayPlans as syncRazorpayPlans } from '../services/razorpay-plan.service';

/** Attaches `subscriberCount` (live active/grace societies) to each plan row. */
async function withSubscriberCounts(plans: any[]): Promise<any[]> {
  const ids = plans.map((p) => p._id);
  const counts = await Subscription.aggregate([
    { $match: { planId: { $in: ids }, status: { $in: ['active', 'past_due'] } } },
    { $group: { _id: '$planId', n: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((c) => [String(c._id), c.n]));
  // flattenMaps so the `capabilities` Map serializes to a plain object (a raw Map -> {} in JSON).
  return plans.map((p) => ({ ...p.toObject({ virtuals: true, flattenMaps: true }), subscriberCount: map.get(String(p._id)) || 0 }));
}

export class PlanController {
  // Create a new Plan (Owner only)
  static async createPlan(req: Request, res: Response) {
    try {
      const parsed = createPlanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
      }

      const existing = await Plan.findOne({ name: new RegExp(`^${parsed.data.name}$`, 'i'), isDeleted: false });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A plan with this name already exists' });
      }

      const newPlan = await Plan.create({
        ...parsed.data,
        createdBy: req.user?.userId,
        createdByName: req.user?.userName,
        updatedBy: req.user?.userId,
        updatedByName: req.user?.userName,
      });
      await syncRazorpayPlans(newPlan);
      return res.status(201).json({ success: true, plan: newPlan });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  /**
   * Public list of active customer-facing plans (excludes internal system plans).
   * Returns computed pricing via the model virtuals.
   */
  static async getActivePlans(req: Request, res: Response) {
    try {
      const module = req.query.module || 'society';
      const plans = await Plan.find({ isActive: true, isDeleted: false, isSystem: false, module }).sort({ basePrice: 1 });
      return res.status(200).json({ success: true, plans });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Admin plan management list with pagination / search / status filtering.
   */
  static async getPlans(req: Request, res: Response) {
    try {
      const { page, pageSize, isPagination, search, status, module } = req.query;
      const filter: Record<string, any> = { isDeleted: false, isSystem: false };

      if (module) filter.module = module;
      else filter.module = 'society';

      if (status === 'active') filter.isActive = true;
      else if (status === 'inactive') filter.isActive = false;

      if (search) {
        const rx = new RegExp(String(search), 'i');
        filter.$or = [{ name: rx }, { description: rx }];
      }

      if (isPagination === 'true') {
        const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
        const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
        const skip = (currentPage - 1) * limit;

        const [plans, total] = await Promise.all([
          Plan.find(filter).populate('createdBy', 'name').populate('updatedBy', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
          Plan.countDocuments(filter),
        ]);

        return res.status(200).json({
          success: true,
          plans: await withSubscriberCounts(plans),
          pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
        });
      }

      const plans = await Plan.find(filter).sort({ createdAt: -1 });
      return res.status(200).json({ success: true, plans: await withSubscriberCounts(plans) });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async getPlanById(req: Request, res: Response) {
    try {
      const plan = await Plan.findOne({ _id: req.params.id, isDeleted: false });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      return res.status(200).json({ success: true, plan });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  static async updatePlan(req: Request, res: Response) {
    try {
      const parsed = updatePlanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
      }

      if (parsed.data.name) {
        const conflict = await Plan.findOne({
          name: new RegExp(`^${parsed.data.name}$`, 'i'),
          _id: { $ne: req.params.id },
          isDeleted: false,
        });
        if (conflict) return res.status(409).json({ success: false, message: 'A plan with this name already exists' });
      }

      const plan = await Plan.findOne({ _id: req.params.id, isSystem: false });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

      // Snapshot pricing-relevant state so we can keep Razorpay plan ids that are still valid.
      const oldBase = plan.basePrice;
      const oldCycles = plan.billingCycles.map((c) => ({ tenure: c.tenure, discountPercent: c.discountPercent, durationMonths: c.durationMonths, razorpayPlanId: c.razorpayPlanId }));

      plan.set(parsed.data);

      const baseUnchanged = plan.basePrice === oldBase;
      for (const cyc of plan.billingCycles) {
        if (cyc.razorpayPlanId) continue;
        const prev = oldCycles.find((o) => o.tenure === cyc.tenure);
        if (prev?.razorpayPlanId && baseUnchanged && prev.discountPercent === cyc.discountPercent && prev.durationMonths === cyc.durationMonths) {
          cyc.razorpayPlanId = prev.razorpayPlanId; // unchanged pricing — reuse existing Razorpay plan
        }
      }

      plan.updatedBy = req.user?.userId as any;
      plan.updatedByName = req.user?.userName;
      await plan.save();
      await syncRazorpayPlans(plan); // create Razorpay plans for new / changed cycles

      return res.status(200).json({ success: true, plan });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  static async deletePlan(req: Request, res: Response) {
    try {
      const plan = await Plan.findOneAndUpdate(
        { _id: req.params.id, isSystem: false },
        { isDeleted: true, isActive: false },
        { new: true }
      );
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      return res.status(200).json({ success: true, message: 'Plan deleted successfully' });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

export default PlanController;
