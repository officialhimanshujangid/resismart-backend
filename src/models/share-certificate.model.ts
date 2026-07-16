import mongoose, { Schema, Document } from 'mongoose';

export type ShareStatus = 'ACTIVE' | 'TRANSFERRED' | 'CANCELLED';

/**
 * A share certificate issued to a member.
 *
 * Membership of a co-operative housing society runs through shares, not through
 * owning the flat — the society must maintain a register of members and issue a
 * certificate to each. This was missing entirely, which is also why the Balance
 * Sheet had no Share Capital line: there was nothing to raise it from.
 *
 * Certificates are never edited on transfer. The old one is marked TRANSFERRED
 * and a new one issued, so the register keeps the full chain of who held what.
 */
export interface IShareCertificate extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  blockName: string;
  flatNumber: string;

  memberName: string;
  memberUserId?: mongoose.Types.ObjectId;

  certificateNumber: string;
  /** Distinctive share numbers, e.g. 51–60. Kept for the statutory register. */
  distinctiveFrom: number;
  distinctiveTo: number;
  shareCount: number;
  faceValuePaise: number;
  amountPaise: number;

  issuedOn: Date;
  status: ShareStatus;
  transferredOn?: Date;
  /** The certificate this one replaced, when issued through a transfer. */
  supersedesId?: mongoose.Types.ObjectId;

  journalEntryId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ShareCertificateSchema = new Schema<IShareCertificate>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  blockName: { type: String, required: true },
  flatNumber: { type: String, required: true },

  memberName: { type: String, required: true, trim: true },
  memberUserId: { type: Schema.Types.ObjectId, ref: 'User' },

  certificateNumber: { type: String, required: true },
  distinctiveFrom: { type: Number, required: true, min: 1 },
  distinctiveTo: { type: Number, required: true, min: 1 },
  shareCount: { type: Number, required: true, min: 1 },
  faceValuePaise: { type: Number, required: true, min: 0 },
  amountPaise: { type: Number, required: true, min: 0 },

  issuedOn: { type: Date, required: true },
  status: { type: String, enum: ['ACTIVE', 'TRANSFERRED', 'CANCELLED'], default: 'ACTIVE' },
  transferredOn: { type: Date },
  supersedesId: { type: Schema.Types.ObjectId, ref: 'ShareCertificate' },

  journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

ShareCertificateSchema.index({ societyId: 1, certificateNumber: 1 }, { unique: true });
ShareCertificateSchema.index({ societyId: 1, flatId: 1, status: 1 });

export const ShareCertificate = mongoose.model<IShareCertificate>('ShareCertificate', ShareCertificateSchema);
export default ShareCertificate;
