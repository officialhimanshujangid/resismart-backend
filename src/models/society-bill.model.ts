import mongoose, { Schema, Document } from 'mongoose';

export interface ISocietyBill extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  flatNumber: string;
  blockName: string;
  flatSizeId?: mongoose.Types.ObjectId;
  flatSizeLabel?: string;
  primaryOwnerUserId?: mongoose.Types.ObjectId;
  primaryOwnerName?: string;

  billNumber: string;
  billTemplateId: mongoose.Types.ObjectId;
  billTemplateName: string;
  category: string;
  billingPeriod: string; // e.g., '2026-07'
  description: string;

  baseAmountPaise: number;
  lateFeeAmountPaise: number;
  totalAmountPaise: number;
  paidAmountPaise: number;

  dueDate: Date;
  lateFeeAppliedAt?: Date;
  paidAt?: Date;

  status: 'UNPAID' | 'PENDING_CONFIRMATION' | 'PARTIALLY_PAID' | 'PAID' | 'WAIVED' | 'VOID';
  waivedBy?: mongoose.Types.ObjectId;
  waivedByName?: string;
  waivedReason?: string;
  waivedAt?: Date;

  generatedBy: 'CRON' | 'MANUAL';
  generatedByUserId?: mongoose.Types.ObjectId;

  remindersSent: { sentAt: Date; daysOffset: number; channel: string }[];

  createdAt: Date;
  updatedAt: Date;
}

const SocietyBillSchema = new Schema<ISocietyBill>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  flatNumber: { type: String, required: true },
  blockName: { type: String, required: true },
  flatSizeId: { type: Schema.Types.ObjectId, ref: 'FlatSize' },
  flatSizeLabel: { type: String },
  primaryOwnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  primaryOwnerName: { type: String },

  billNumber: { type: String, required: true },
  billTemplateId: { type: Schema.Types.ObjectId, required: true },
  billTemplateName: { type: String, required: true },
  category: { type: String, required: true },
  billingPeriod: { type: String, required: true },
  description: { type: String, required: true },

  baseAmountPaise: { type: Number, required: true, min: 0 },
  lateFeeAmountPaise: { type: Number, default: 0, min: 0 },
  totalAmountPaise: { type: Number, required: true, min: 0 },
  paidAmountPaise: { type: Number, default: 0, min: 0 },

  dueDate: { type: Date, required: true },
  lateFeeAppliedAt: { type: Date },
  paidAt: { type: Date },

  status: { 
    type: String, 
    enum: ['UNPAID', 'PENDING_CONFIRMATION', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'VOID'], 
    default: 'UNPAID' 
  },
  waivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  waivedByName: { type: String },
  waivedReason: { type: String },
  waivedAt: { type: Date },

  generatedBy: { type: String, enum: ['CRON', 'MANUAL'], required: true },
  generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

  remindersSent: [{
    sentAt: { type: Date, required: true },
    daysOffset: { type: Number, required: true },
    channel: { type: String, required: true }
  }],
}, { timestamps: true });

// Indexes
SocietyBillSchema.index({ societyId: 1, flatId: 1, billTemplateId: 1, billingPeriod: 1 }, { unique: true });
SocietyBillSchema.index({ societyId: 1, status: 1, dueDate: 1 });
SocietyBillSchema.index({ flatId: 1, status: 1, createdAt: -1 });
SocietyBillSchema.index({ societyId: 1, billingPeriod: 1, status: 1 });
SocietyBillSchema.index({ billNumber: 1, societyId: 1 }, { unique: true });

export const SocietyBill = mongoose.model<ISocietyBill>('SocietyBill', SocietyBillSchema);
export default SocietyBill;
