import mongoose, { Schema, Document } from 'mongoose';

/**
 * A saved property search with optional email alerts. A daily cron matches newly
 * published listings against each search's criteria and emails the owner.
 */
export interface ISavedSearch extends Document {
  userId: mongoose.Types.ObjectId;
  name?: string;
  criteria: {
    kind?: 'SALE' | 'RENT';
    city?: string;
    pincode?: string;
    minPaise?: number;
    maxPaise?: number;
    bedrooms?: number;
  };
  alertsEnabled: boolean;
  lastNotifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SavedSearchSchema = new Schema<ISavedSearch>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, trim: true, maxlength: 80 },
  criteria: {
    kind: { type: String, enum: ['SALE', 'RENT'] },
    city: { type: String, trim: true },
    pincode: { type: String, trim: true },
    minPaise: { type: Number, min: 0 },
    maxPaise: { type: Number, min: 0 },
    bedrooms: { type: Number, min: 0 },
  },
  alertsEnabled: { type: Boolean, default: true },
  lastNotifiedAt: { type: Date },
}, { timestamps: true });

SavedSearchSchema.index({ userId: 1, createdAt: -1 });
SavedSearchSchema.index({ alertsEnabled: 1 });

export const SavedSearch = mongoose.model<ISavedSearch>('SavedSearch', SavedSearchSchema);
export default SavedSearch;
