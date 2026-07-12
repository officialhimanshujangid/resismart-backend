import mongoose, { Schema, Document } from 'mongoose';

export type ReportReason = 'WRONG_INFO' | 'SPAM' | 'SCAM' | 'INAPPROPRIATE' | 'OTHER';
export type ReportStatus = 'PENDING' | 'REVIEWED' | 'DISMISSED';

export interface IListingReport extends Document {
  listingId: mongoose.Types.ObjectId;
  societyId?: mongoose.Types.ObjectId;
  reason: ReportReason;
  details?: string;
  ip?: string;
  source: 'PUBLIC' | 'IN_APP';
  status: ReportStatus;
  reviewedBy?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ListingReportSchema = new Schema<IListingReport>(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'PropertyListing', required: true },
    societyId: { type: Schema.Types.ObjectId, ref: 'Society' },
    reason: { type: String, enum: ['WRONG_INFO', 'SPAM', 'SCAM', 'INAPPROPRIATE', 'OTHER'], required: true },
    details: { type: String, trim: true, maxlength: 500 },
    ip: { type: String },
    source: { type: String, enum: ['PUBLIC', 'IN_APP'], default: 'PUBLIC' },
    status: { type: String, enum: ['PENDING', 'REVIEWED', 'DISMISSED'], default: 'PENDING' },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

ListingReportSchema.index({ listingId: 1 });
ListingReportSchema.index({ status: 1, createdAt: -1 });

export const ListingReport = mongoose.model<IListingReport>('ListingReport', ListingReportSchema);
export default ListingReport;
