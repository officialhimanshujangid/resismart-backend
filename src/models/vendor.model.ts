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

  /**
   * Where the society pays this vendor. The account number is encrypted at rest
   * with the finance key and never returned to a screen — only `last4`, so a
   * treasurer can confirm they are paying the right account without the number
   * being readable by anyone who can open the vendor page.
   */
  bank?: {
    accountName?: string;
    accountNumberEnc?: string;
    accountNumberIv?: string;
    accountNumberTag?: string;
    last4?: string;
    ifsc?: string;
    bankName?: string;
    upiId?: string;
  };

  notes?: string;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy?: mongoose.Types.ObjectId;
  updatedByName?: string;
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

  bank: {
    accountName: { type: String, trim: true },
    accountNumberEnc: { type: String },
    accountNumberIv: { type: String },
    accountNumberTag: { type: String },
    last4: { type: String },
    ifsc: { type: String, trim: true, uppercase: true },
    bankName: { type: String, trim: true },
    upiId: { type: String, trim: true },
  },

  notes: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedByName: { type: String },
}, { timestamps: true });

VendorSchema.index({ societyId: 1, name: 1 }, { unique: true });
// Vendor lists filter on active-ness and sort by name; without this every page
// load scans the society's whole vendor collection.
VendorSchema.index({ societyId: 1, isActive: 1, name: 1 });

export const Vendor = mongoose.model<IVendor>('Vendor', VendorSchema);
export default Vendor;
