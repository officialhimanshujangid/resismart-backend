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
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

VendorSchema.index({ societyId: 1, name: 1 }, { unique: true });

export const Vendor = mongoose.model<IVendor>('Vendor', VendorSchema);
export default Vendor;
