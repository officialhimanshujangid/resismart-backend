import mongoose, { Schema, Document } from 'mongoose';

export interface IRentalAgreement extends Document {
  flatId: mongoose.Types.ObjectId;
  tenantId: mongoose.Types.ObjectId; // User with role RESIDENT_TENANT
  societyId: mongoose.Types.ObjectId;
  rentAmount: number;
  securityDeposit: number;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  
  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const RentalAgreementSchema = new Schema<IRentalAgreement>({
  flatId: {
    type: Schema.Types.ObjectId,
    ref: 'Flat',
    required: true,
  },
  tenantId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  rentAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  securityDeposit: {
    type: Number,
    required: true,
    min: 0,
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdByName: {
    type: String,
    required: true,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedByName: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// Optimization Indexes
RentalAgreementSchema.index({ flatId: 1 });
RentalAgreementSchema.index({ tenantId: 1 });
RentalAgreementSchema.index({ societyId: 1 });
RentalAgreementSchema.index({ isActive: 1 });

export const RentalAgreement = mongoose.model<IRentalAgreement>('RentalAgreement', RentalAgreementSchema);
export default RentalAgreement;
