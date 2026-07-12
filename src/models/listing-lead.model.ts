import mongoose, { Schema, Document } from 'mongoose';

/**
 * An inquiry on a listing. Public leads require an OTP-verified phone before the
 * listing owner's contact is revealed (anti-spam + privacy). In-app leads come from
 * authenticated residents.
 */
export interface IListingLead extends Document {
  listingId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  from: { userId?: mongoose.Types.ObjectId; name: string; phone: string; phoneVerified: boolean };
  message?: string;
  source: 'PUBLIC' | 'IN_APP';
  createdAt: Date;
  updatedAt: Date;
}

const ListingLeadSchema = new Schema<IListingLead>({
  listingId: { type: Schema.Types.ObjectId, ref: 'PropertyListing', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  from: {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    phoneVerified: { type: Boolean, default: false },
  },
  message: { type: String, trim: true, maxlength: 1000 },
  source: { type: String, enum: ['PUBLIC', 'IN_APP'], default: 'PUBLIC' },
}, { timestamps: true });

ListingLeadSchema.index({ listingId: 1, createdAt: -1 });
ListingLeadSchema.index({ societyId: 1 });
ListingLeadSchema.index({ 'from.phone': 1 });

export const ListingLead = mongoose.model<IListingLead>('ListingLead', ListingLeadSchema);
export default ListingLead;
