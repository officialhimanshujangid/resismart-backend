import mongoose, { Schema, Document } from 'mongoose';

export interface IVendor extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  pan?: string;
  tdsApplicable: boolean;
  tdsSection?: string;
  tdsRatePercent?: number;
  /**
   * TDS thresholds. Tax is only deducted once a payment breaches the single-bill
   * limit OR the vendor's running total for the year breaches the annual one —
   * deducting from rupee one (as this used to) over-deducts and leaves the
   * society explaining refunds to its vendors. Defaults follow 194C
   * (₹30,000 single / ₹1,00,000 aggregate); 0 means "always deduct".
   */
  tdsThresholdSinglePaise?: number;
  tdsThresholdAnnualPaise?: number;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const VendorSchema = new Schema<IVendor>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true },
  gstin: { type: String, trim: true },
  pan: { type: String, trim: true },
  tdsApplicable: { type: Boolean, default: false },
  tdsSection: { type: String },
  tdsRatePercent: { type: Number, min: 0 },
  tdsThresholdSinglePaise: { type: Number, default: 3000000, min: 0 },   // ₹30,000 (194C)
  tdsThresholdAnnualPaise: { type: Number, default: 10000000, min: 0 },  // ₹1,00,000 (194C)
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

VendorSchema.index({ societyId: 1, name: 1 }, { unique: true });

export const Vendor = mongoose.model<IVendor>('Vendor', VendorSchema);
export default Vendor;
