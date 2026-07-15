import mongoose, { Schema, Document } from 'mongoose';
import { ChargeCategory, PricingMode } from './charge-head.model';

export type InvoiceLineCategory = ChargeCategory | 'ARREARS_BF' | 'INTEREST';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'WAIVED' | 'CANCELLED';

export interface IInvoiceLineItem {
  chargeHeadId?: mongoose.Types.ObjectId;
  code: string;
  name: string;
  category: InvoiceLineCategory;
  pricingMode?: PricingMode;
  quantity?: number;
  ratePaise?: number;
  baseAmountPaise: number;
  gstApplicable: boolean;
  gstRatePercent?: number;
  sacCode?: string;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  lineTotalPaise: number;
  incomeAccountCode?: string;   // GL account this line credits (income or fund account)
  fundId?: mongoose.Types.ObjectId;
  isPostable: boolean;          // ARREARS_BF is display-only (already in Debtors) → false
}

export interface IMaintenanceInvoice extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  blockName: string;
  flatNumber: string;
  flatSizeId?: mongoose.Types.ObjectId;
  flatSizeLabel?: string;
  primaryOwnerUserId?: mongoose.Types.ObjectId;
  primaryOwnerName?: string;
  billToRole: 'OWNER' | 'TENANT';

  invoiceNumber: string;
  financialYear: string;
  billingPeriod: string;      // 'YYYY-MM'
  periodStart?: Date;
  periodEnd?: Date;
  invoiceDate: Date;
  dueDate: Date;

  lineItems: IInvoiceLineItem[];
  openingArrearsPaise: number;
  subTotalPaise: number;      // sum of postable line base (pre-tax)
  gstPaise: number;
  interestPaise: number;
  roundingPaise: number;      // signed
  totalPaise: number;         // current-period charges incl tax + rounding
  grandTotalDuePaise: number; // totalPaise + openingArrears

  allocatedPaise: number;
  advanceAppliedPaise: number;
  waivedPaise: number;
  outstandingPaise: number;

  status: InvoiceStatus;
  pdfKey?: string;
  pdfUrl?: string;
  journalEntryId?: mongoose.Types.ObjectId;

  generatedBy: 'CRON' | 'MANUAL';
  generatedByUserId?: mongoose.Types.ObjectId;
  remindersSent: { sentAt: Date; offsetDays: number; channel: string }[];

  createdAt: Date;
  updatedAt: Date;
}

const InvoiceLineItemSchema = new Schema<IInvoiceLineItem>({
  chargeHeadId: { type: Schema.Types.ObjectId, ref: 'ChargeHead' },
  code: { type: String, required: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  pricingMode: { type: String },
  quantity: { type: Number },
  ratePaise: { type: Number },
  baseAmountPaise: { type: Number, required: true, default: 0 },
  gstApplicable: { type: Boolean, default: false },
  gstRatePercent: { type: Number },
  sacCode: { type: String },
  cgstPaise: { type: Number, default: 0 },
  sgstPaise: { type: Number, default: 0 },
  igstPaise: { type: Number, default: 0 },
  gstPaise: { type: Number, default: 0 },
  lineTotalPaise: { type: Number, required: true, default: 0 },
  incomeAccountCode: { type: String },
  fundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },
  isPostable: { type: Boolean, default: true },
}, { _id: false });

const MaintenanceInvoiceSchema = new Schema<IMaintenanceInvoice>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  blockName: { type: String, required: true },
  flatNumber: { type: String, required: true },
  flatSizeId: { type: Schema.Types.ObjectId, ref: 'FlatSize' },
  flatSizeLabel: { type: String },
  primaryOwnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  primaryOwnerName: { type: String },
  billToRole: { type: String, enum: ['OWNER', 'TENANT'], default: 'OWNER' },

  invoiceNumber: { type: String, required: true },
  financialYear: { type: String, required: true },
  billingPeriod: { type: String, required: true },
  periodStart: { type: Date },
  periodEnd: { type: Date },
  invoiceDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },

  lineItems: { type: [InvoiceLineItemSchema], default: [] },
  openingArrearsPaise: { type: Number, default: 0 },
  subTotalPaise: { type: Number, default: 0 },
  gstPaise: { type: Number, default: 0 },
  interestPaise: { type: Number, default: 0 },
  roundingPaise: { type: Number, default: 0 },
  totalPaise: { type: Number, default: 0 },
  grandTotalDuePaise: { type: Number, default: 0 },

  allocatedPaise: { type: Number, default: 0 },
  advanceAppliedPaise: { type: Number, default: 0 },
  waivedPaise: { type: Number, default: 0 },
  outstandingPaise: { type: Number, default: 0 },

  status: { type: String, enum: ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED'], default: 'ISSUED' },
  pdfKey: { type: String },
  pdfUrl: { type: String },
  journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },

  generatedBy: { type: String, enum: ['CRON', 'MANUAL'], required: true },
  generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  remindersSent: [{
    sentAt: { type: Date, required: true },
    offsetDays: { type: Number, required: true },
    channel: { type: String, required: true },
  }],
}, { timestamps: true });

// One invoice per flat per period (idempotent generation).
MaintenanceInvoiceSchema.index({ societyId: 1, flatId: 1, billingPeriod: 1 }, { unique: true });
MaintenanceInvoiceSchema.index({ societyId: 1, invoiceNumber: 1 }, { unique: true });
MaintenanceInvoiceSchema.index({ societyId: 1, status: 1, dueDate: 1 });
MaintenanceInvoiceSchema.index({ flatId: 1, status: 1, createdAt: -1 });
MaintenanceInvoiceSchema.index({ societyId: 1, billingPeriod: 1, status: 1 });

export const MaintenanceInvoice = mongoose.model<IMaintenanceInvoice>('MaintenanceInvoice', MaintenanceInvoiceSchema);
export default MaintenanceInvoice;
