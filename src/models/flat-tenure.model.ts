import mongoose, { Schema, Document } from 'mongoose';

export type TenureType = 'OWNERSHIP' | 'TENANCY' | 'OWNER_OCCUPANCY';
export type TenureStatus = 'ACTIVE' | 'ENDED';
export type TenureSource = 'INITIAL' | 'SALE' | 'RENT' | 'MIGRATION';

export interface ITenureOccupant {
  userId?: mongoose.Types.ObjectId;
  name: string;
  relationship: string; // OWNER | SPOUSE | CHILD | PARENT | TENANT | OTHER
}

/**
 * One period in a flat's history: who owned it or occupied it, from when to when.
 * The append-only sequence of tenures IS the flat timeline
 * (e.g. "Rakesh owned 2020–2022 → sold to … → rented to Mahesh 2022–2023 → …").
 *
 * Invariants (enforced in the lifecycle service, not the schema): at most one ACTIVE
 * OWNERSHIP and at most one ACTIVE occupancy (TENANCY or OWNER_OCCUPANCY) per flat.
 * `endDate` null + status ACTIVE = the current, ongoing period.
 */
export interface IFlatTenure extends Document {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  type: TenureType;
  party: { userId?: mongoose.Types.ObjectId; name: string };
  occupants: ITenureOccupant[];
  startDate: Date;
  endDate?: Date | null;
  status: TenureStatus;
  source: TenureSource;
  saleAmountPaise?: number;
  rentAmountPaise?: number;
  securityDepositPaise?: number;
  rentalAgreementId?: mongoose.Types.ObjectId;
  notes?: string;

  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const OccupantSchema = new Schema<ITenureOccupant>({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true, trim: true },
  relationship: { type: String, enum: ['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER'], default: 'OTHER' },
}, { _id: false });

const FlatTenureSchema = new Schema<IFlatTenure>({
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  type: { type: String, enum: ['OWNERSHIP', 'TENANCY', 'OWNER_OCCUPANCY'], required: true },
  party: {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true, trim: true },
  },
  occupants: { type: [OccupantSchema], default: [] },
  startDate: { type: Date, required: true },
  endDate: { type: Date, default: null },
  status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
  source: { type: String, enum: ['INITIAL', 'SALE', 'RENT', 'MIGRATION'], required: true },
  saleAmountPaise: { type: Number, min: 0 },
  rentAmountPaise: { type: Number, min: 0 },
  securityDepositPaise: { type: Number, min: 0 },
  rentalAgreementId: { type: Schema.Types.ObjectId, ref: 'RentalAgreement' },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, {
  timestamps: true,
});

FlatTenureSchema.index({ flatId: 1, startDate: 1 });
FlatTenureSchema.index({ flatId: 1, type: 1, status: 1 });
FlatTenureSchema.index({ societyId: 1 });
FlatTenureSchema.index({ 'party.userId': 1 });

export const FlatTenure = mongoose.model<IFlatTenure>('FlatTenure', FlatTenureSchema);
export default FlatTenure;
