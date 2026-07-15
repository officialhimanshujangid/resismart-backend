import mongoose, { Schema, Document } from 'mongoose';

export interface IBillTemplate {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  category: 'MAINTENANCE' | 'CORPUS' | 'SPECIAL' | 'UTILITY' | 'CUSTOM';
  pricingMode: 'UNIFORM' | 'PER_FLAT_SIZE';
  uniformAmountPaise?: number;
  perSizeAmounts?: {
    flatSizeId: mongoose.Types.ObjectId;
    label: string;
    amountPaise: number;
  }[];
  applicableTo: 'ALL' | 'OWNER_OCCUPIED' | 'RENTED' | 'VACANT';
  isRecurring: boolean;
  isActive: boolean;
}

export interface ISocietyFinanceSettings extends Document {
  societyId: mongoose.Types.ObjectId;
  
  // Bank Account (Razorpay-verified via penny drop)
  bankAccount?: {
    accountName: string;
    accountNumberEncrypted: string;
    accountNumberIv: string;
    accountNumberTag: string;
    accountNumberLast4: string;
    ifsc: string;
    bankName: string;
    branchName?: string;
    razorpayContactId?: string;
    razorpayFundAccountId?: string;
    razorpayValidationId?: string;
    verificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'FAILED';
    verifiedAt?: Date;
    verificationFailureReason?: string;
  };

  // UPI
  upiId?: string;
  upiQrImageKey?: string;

  // Online toggle
  wantPaymentOnline: boolean;

  // Auto billing
  autoBillingEnabled: boolean;
  billingGenerationDay: number; // 1-28
  billDueDays: number;
  billPrefix: string;
  lastBillSequence: number;

  // Late fee
  lateFeeEnabled: boolean;
  lateFeeGraceDays: number;
  lateFeePercent: number;
  lateFeeMode: 'SIMPLE' | 'COMPOUND';
  lateFeeCap?: number;

  // Reminders
  reminderEnabled: boolean;
  reminderDaysBeforeDue: number[];
  reminderDaysAfterDue: number[];

  // Bill templates
  billTemplates: IBillTemplate[];

  // Audit
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const BillTemplateSchema = new Schema<IBillTemplate>({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  category: { type: String, enum: ['MAINTENANCE', 'CORPUS', 'SPECIAL', 'UTILITY', 'CUSTOM'], required: true },
  pricingMode: { type: String, enum: ['UNIFORM', 'PER_FLAT_SIZE'], required: true },
  uniformAmountPaise: { type: Number, min: 0 },
  perSizeAmounts: [{
    flatSizeId: { type: Schema.Types.ObjectId, ref: 'FlatSize', required: true },
    label: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
  }],
  applicableTo: { type: String, enum: ['ALL', 'OWNER_OCCUPIED', 'RENTED', 'VACANT'], required: true },
  isRecurring: { type: Boolean, required: true },
  isActive: { type: Boolean, default: true },
});

const SocietyFinanceSettingsSchema = new Schema<ISocietyFinanceSettings>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
  
  bankAccount: {
    accountName: { type: String, trim: true },
    accountNumberEncrypted: { type: String },
    accountNumberIv: { type: String },
    accountNumberTag: { type: String },
    accountNumberLast4: { type: String },
    ifsc: { type: String, trim: true },
    bankName: { type: String, trim: true },
    branchName: { type: String, trim: true },
    razorpayContactId: { type: String },
    razorpayFundAccountId: { type: String },
    razorpayValidationId: { type: String },
    verificationStatus: { type: String, enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED'], default: 'UNVERIFIED' },
    verifiedAt: { type: Date },
    verificationFailureReason: { type: String },
  },

  upiId: { type: String, trim: true },
  upiQrImageKey: { type: String },

  wantPaymentOnline: { type: Boolean, default: false },

  autoBillingEnabled: { type: Boolean, default: false },
  billingGenerationDay: { type: Number, min: 1, max: 28, default: 1 },
  billDueDays: { type: Number, min: 0, default: 10 },
  billPrefix: { type: String, trim: true, default: 'INV' },
  lastBillSequence: { type: Number, default: 0 },

  lateFeeEnabled: { type: Boolean, default: false },
  lateFeeGraceDays: { type: Number, min: 0, default: 3 },
  lateFeePercent: { type: Number, min: 0, default: 0 },
  lateFeeMode: { type: String, enum: ['SIMPLE', 'COMPOUND'], default: 'SIMPLE' },
  lateFeeCap: { type: Number, min: 0, default: 0 },

  reminderEnabled: { type: Boolean, default: false },
  reminderDaysBeforeDue: [{ type: Number, min: 1 }],
  reminderDaysAfterDue: [{ type: Number, min: 1 }],

  billTemplates: [BillTemplateSchema],

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

export const SocietyFinanceSettings = mongoose.model<ISocietyFinanceSettings>('SocietyFinanceSettings', SocietyFinanceSettingsSchema);
export default SocietyFinanceSettings;
