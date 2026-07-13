import mongoose, { Schema, Document } from 'mongoose';

/**
 * An append-only activity-log entry for a flat. Complements FlatTenure: where FlatTenure
 * records ownership/occupancy PERIODS, FlatEvent records discrete CHANGES — a family member
 * added, the head changed, access granted, a contact updated, a document attached, a
 * lifecycle transition. The admin/resident Timeline merges FlatTenure periods with these
 * events into one chronological feed, so every household change is recorded automatically.
 */
export type FlatEventType =
  | 'OWNER_ASSIGNED'
  | 'OWNER_CHANGED'
  | 'MEMBER_ADDED'
  | 'MEMBER_UPDATED'
  | 'MEMBER_REMOVED'
  | 'HEAD_CHANGED'
  | 'ACCESS_GRANTED'
  | 'CONTACT_UPDATED'
  | 'DOCUMENT_ADDED'
  | 'RENTED'
  | 'TENANCY_ENDED'
  | 'OWNER_MOVED_IN'
  | 'MARKED_VACANT'
  | 'STATUS_CHANGED'
  | 'MIGRATION_NOTE';

export const FLAT_EVENT_TYPES: FlatEventType[] = [
  'OWNER_ASSIGNED', 'OWNER_CHANGED', 'MEMBER_ADDED', 'MEMBER_UPDATED', 'MEMBER_REMOVED',
  'HEAD_CHANGED', 'ACCESS_GRANTED', 'CONTACT_UPDATED', 'DOCUMENT_ADDED', 'RENTED',
  'TENANCY_ENDED', 'OWNER_MOVED_IN', 'MARKED_VACANT', 'STATUS_CHANGED', 'MIGRATION_NOTE',
];

export interface IFlatEvent extends Document {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  type: FlatEventType;
  actor: { userId?: mongoose.Types.ObjectId; name: string };
  subject: {
    userId?: mongoose.Types.ObjectId;
    residentId?: mongoose.Types.ObjectId;
    name?: string;
    relationship?: string;
  };
  summary: string; // human-readable, e.g. "Added Rahul Modi (Son)"
  meta?: Record<string, any>; // before/after, amounts, dates
  tenureId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FlatEventSchema = new Schema<IFlatEvent>({
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  type: { type: String, enum: FLAT_EVENT_TYPES, required: true },
  actor: {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true },
  },
  subject: {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    residentId: { type: Schema.Types.ObjectId, ref: 'Resident' },
    name: { type: String, trim: true },
    relationship: { type: String, trim: true },
  },
  summary: { type: String, required: true, trim: true },
  meta: { type: Schema.Types.Mixed },
  tenureId: { type: Schema.Types.ObjectId, ref: 'FlatTenure' },
}, {
  timestamps: true,
});

FlatEventSchema.index({ flatId: 1, createdAt: -1 });
FlatEventSchema.index({ societyId: 1, createdAt: -1 });

export const FlatEvent = mongoose.model<IFlatEvent>('FlatEvent', FlatEventSchema);
export default FlatEvent;
