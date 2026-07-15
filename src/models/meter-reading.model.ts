import mongoose, { Schema, Document } from 'mongoose';

/**
 * A metered-utility reading for a flat in a billing period, consumed by METERED
 * charge heads at invoice generation.
 */
export interface IMeterReading extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  chargeHeadId: mongoose.Types.ObjectId;
  meterType?: string;
  billingPeriod: string; // 'YYYY-MM'
  previousReading: number;
  currentReading: number;
  unitsConsumed: number;
  recordedBy: mongoose.Types.ObjectId;
  recordedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const MeterReadingSchema = new Schema<IMeterReading>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  chargeHeadId: { type: Schema.Types.ObjectId, ref: 'ChargeHead', required: true },
  meterType: { type: String },
  billingPeriod: { type: String, required: true },
  previousReading: { type: Number, required: true, default: 0 },
  currentReading: { type: Number, required: true, default: 0 },
  unitsConsumed: { type: Number, required: true, default: 0 },
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recordedByName: { type: String, required: true },
}, { timestamps: true });

MeterReadingSchema.index({ societyId: 1, flatId: 1, chargeHeadId: 1, billingPeriod: 1 }, { unique: true });

export const MeterReading = mongoose.model<IMeterReading>('MeterReading', MeterReadingSchema);
export default MeterReading;
