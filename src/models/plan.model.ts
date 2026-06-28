import mongoose, { Schema, Document } from 'mongoose';

// Interface for Billing Cycle
export interface IBillingCycle {
  tenure: 'monthly' | 'quarterly' | 'halfYearly' | 'yearly';
  label: string;
  durationMonths: number;
  discountPercent: number;
  isEnabled: boolean;
  razorpayPlanId?: string;
}

// Interface for Computed Pricing
export interface IComputedPricing extends IBillingCycle {
  totalPrice: number;
  perMonthEquivalent: number;
  savedAmount: number;
}

// Interface for Plan
export interface IPlan extends Document {
  name: string;
  description: string;
  isActive: boolean;
  isFeatured: boolean;
  isDeleted: boolean;
  isSystem: boolean; // internal plans (e.g. Free Trial) — hidden from plan management
  basePrice: number;
  currency: string;
  billingCycles: IBillingCycle[];
  capabilities: Map<string, any>;
  
  // Virtuals
  computedPricing: IComputedPricing[];
  
  // Audit
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  updatedBy?: mongoose.Types.ObjectId;
  updatedByName?: string;

  // Methods
  getPricingForTenure(tenure: string): IComputedPricing | null;
  getCapabilityValue(key: string, definitions?: any[]): any;
  resolveCapabilities(definitions?: any[]): Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const BillingCycleSchema = new Schema<IBillingCycle>({
  tenure: {
    type: String,
    required: true,
    enum: ['monthly', 'quarterly', 'halfYearly', 'yearly'],
  },
  label: { type: String, default: '' },
  durationMonths: { type: Number, required: true },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  isEnabled: { type: Boolean, default: true },
  razorpayPlanId: { type: String, default: null },
}, { _id: false });

const PlanSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  isSystem: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: { type: String },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedByName: { type: String },
  basePrice: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: { type: String, default: 'INR' },
  billingCycles: {
    type: [BillingCycleSchema],
    default: () => [
      { tenure: 'monthly', label: 'Monthly', durationMonths: 1, discountPercent: 0 },
      { tenure: 'quarterly', label: 'Quarterly', durationMonths: 3, discountPercent: 10 },
      { tenure: 'halfYearly', label: 'Half-Yearly', durationMonths: 6, discountPercent: 15 },
      { tenure: 'yearly', label: 'Yearly', durationMonths: 12, discountPercent: 25 },
    ],
  },
  capabilities: {
    type: Map,
    of: Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

PlanSchema.virtual('computedPricing').get(function(this: IPlan) {
  const base = this.basePrice || 0;
  return (this.billingCycles || [])
    .filter((c) => c.isEnabled)
    .map((cycle) => {
      const fullPrice = base * cycle.durationMonths;
      const discountFraction = cycle.discountPercent / 100;
      const totalPrice = Math.round(fullPrice * (1 - discountFraction));
      const perMonthEquivalent = Math.round(totalPrice / cycle.durationMonths);
      const savedAmount = fullPrice - totalPrice;

      return {
        tenure: cycle.tenure,
        label: cycle.label,
        durationMonths: cycle.durationMonths,
        discountPercent: cycle.discountPercent,
        totalPrice,
        perMonthEquivalent,
        savedAmount,
        razorpayPlanId: cycle.razorpayPlanId || null,
        isEnabled: cycle.isEnabled,
      };
    });
});

PlanSchema.methods.getPricingForTenure = function(this: IPlan, tenure: string) {
  return (this.computedPricing || []).find((c) => c.tenure === tenure) || null;
};

PlanSchema.methods.getCapabilityValue = function(this: IPlan, key: string, definitions: any[] = []) {
  const caps = this.capabilities;
  
  if (caps instanceof Map && caps.has(key)) return caps.get(key);
  if (caps && typeof caps === 'object' && key in caps) return (caps as any)[key];

  const def = definitions.find((d) => d.key === key);
  return def ? def.defaultValue : null;
};

PlanSchema.methods.resolveCapabilities = function(this: IPlan, definitions: any[] = []) {
  const result: Record<string, any> = {};
  for (const def of definitions) {
    result[def.key] = this.getCapabilityValue(def.key, definitions);
  }
  return result;
};

export const Plan = mongoose.model<IPlan>('Plan', PlanSchema);
export default Plan;
