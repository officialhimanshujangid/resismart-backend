import mongoose, { Schema, Document } from 'mongoose';

/** A user's shortlisted listing (favorites + compare). */
export interface IFavorite extends Document {
  userId: mongoose.Types.ObjectId;
  listingId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const FavoriteSchema = new Schema<IFavorite>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  listingId: { type: Schema.Types.ObjectId, ref: 'PropertyListing', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

FavoriteSchema.index({ userId: 1, listingId: 1 }, { unique: true });
FavoriteSchema.index({ userId: 1, createdAt: -1 });

export const Favorite = mongoose.model<IFavorite>('Favorite', FavoriteSchema);
export default Favorite;
