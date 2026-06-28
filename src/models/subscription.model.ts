import mongoose, { Schema, Document } from 'mongoose';

export interface IHistoryEntry {
  action: 'created' | 'activated' | 'trial_started' | 'upgraded' | 'downgraded' | 'extended' | 'cancelled' | 'renewed' | 'suspended' | 'reactivated' | 'cash_plan_assigned' | 'expired';
  fromPlanId?: mongoose.Types.ObjectId;
  toPlanId?: mongoose.Types.ObjectId;
  note?: string;
  performedBy?: string;
  date: Date;
}

export interface ISubscription extends Document {
  tenantId: mongoose.Types.ObjectId; // E.g., Society ID or Shop ID
  tenantType: 'SOCIETY' | 'SHOP';
  planId: mongoose.Types.ObjectId;
  tenure: 'trial' | 'monthly' | 'quarterly' | 'halfYearly' | 'yearly';
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'pending_payment' | 'scheduled';
  startDate: Date;
  endDate: Date;
  graceEndsAt?: Date; // when status is past_due, full access continues until this date
  isFreeTier?: boolean; // true for the perpetual free-tier subscription
  capabilities?: Map<string, any>; // SNAPSHOT of the plan limits at purchase time (locked until next payment)
  razorpaySubscriptionId?: string;
  upgradedFrom?: mongoose.Types.ObjectId;
  history: IHistoryEntry[];
  
  createdAt: Date;
  updatedAt: Date;
}

const HistoryEntrySchema = new Schema<IHistoryEntry>({
  action: {
    type: String,
    enum: [
      'created', 'activated', 'trial_started', 'upgraded',
      'downgraded', 'extended', 'cancelled', 'renewed',
      'suspended', 'reactivated', 'cash_plan_assigned', 'expired'
    ],
    required: true,
  },
  fromPlanId: { type: Schema.Types.ObjectId, ref: 'Plan' },
  toPlanId: { type: Schema.Types.ObjectId, ref: 'Plan' },
  note: { type: String, default: '' },
  performedBy: { type: String, default: 'system' },
  date: { type: Date, default: Date.now },
}, { _id: false });

const SubscriptionSchema = new Schema<ISubscription>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  tenantType: { 
    type: String, 
    enum: ['SOCIETY', 'SHOP'], 
    required: true 
  },
  planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
  tenure: {
    type: String,
    enum: ['trial', 'monthly', 'quarterly', 'halfYearly', 'yearly'],
    required: true
  },
  status: {
    type: String,
    enum: ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'pending_payment', 'scheduled'],
    required: true
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  graceEndsAt: { type: Date },
  isFreeTier: { type: Boolean, default: false },
  capabilities: { type: Map, of: Schema.Types.Mixed },
  razorpaySubscriptionId: { type: String },
  upgradedFrom: { type: Schema.Types.ObjectId, ref: 'Subscription' },
  history: {
    type: [HistoryEntrySchema],
    default: () => []
  },
}, { 
  timestamps: true 
});

// Indexes for fast lookup
SubscriptionSchema.index({ tenantId: 1, tenantType: 1, status: 1 });
SubscriptionSchema.index({ planId: 1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
export default Subscription;
