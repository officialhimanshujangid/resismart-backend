import mongoose, { Schema, Document } from 'mongoose';

export interface IShop extends Document {
  name: string;
  contactNumber: string;
  gstNumber?: string;
  storeType?: string;
  typeService?: string;
  salesAndProduct?: string;
  address: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED';
  location?: {
    type: 'Point';
    coordinates: number[]; // [longitude, latitude]
  };
  // Primary admin contact (captured on self-registration, before a User exists)
  adminEmail: string;
  adminUserId?: mongoose.Types.ObjectId; // SHOP_ADMIN user, created on approval
  rejectionReason?: string;
  // Extended details
  city?: string;
  state?: string;
  pincode?: string;
  // Audit metadata columns
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  updatedBy?: mongoose.Types.ObjectId;
  updatedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const SHOP_SERVICE_TYPES = ['Delivery', 'Dine-in', 'Takeaway', 'Installation', 'Repair', 'Consulting', 'Retail', 'Online', 'Offline', 'Other'] as const;

const ShopSchema = new Schema<IShop>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  contactNumber: {
    type: String,
    required: true,
    trim: true,
  },
  gstNumber: { type: String, trim: true },
  storeType: { type: String, trim: true },
  typeService: { 
    type: String, 
    enum: SHOP_SERVICE_TYPES,
    trim: true 
  },
  salesAndProduct: { type: String, trim: true },
  address: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'ACTIVE', 'REJECTED'],
    default: 'PENDING',
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
    }
  },
  adminEmail: { 
    type: String, 
    required: true,
    trim: true, 
    lowercase: true 
  },
  adminUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectionReason: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  pincode: { type: String, trim: true },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  createdByName: {
    type: String,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  updatedByName: {
    type: String,
  },
}, {
  timestamps: true,
});

// Indexes for fast querying
ShopSchema.index({ createdBy: 1 });
ShopSchema.index({ name: 1 });
ShopSchema.index({ status: 1 });
ShopSchema.index({ location: '2dsphere' });

export const Shop = mongoose.model<IShop>('Shop', ShopSchema);
export default Shop;
