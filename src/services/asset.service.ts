import mongoose from 'mongoose';
import { Asset, IAsset, ASSET_CATEGORIES } from '../models/asset.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { ComplaintCategory } from '../models/complaint-category.model';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class AssetError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

async function nextAssetCode(societyId: string): Promise<string> {
  const count = await Asset.countDocuments({ societyId: oid(societyId) });
  return `AST/${String(count + 1).padStart(4, '0')}`;
}

export async function createAsset(societyId: string, input: any, actor: Actor): Promise<IAsset> {
  if (!(ASSET_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new AssetError('That is not a kind of equipment this society tracks.');
  }

  let blockName: string | undefined;
  if (input.blockId) {
    const block = await Block.findOne({ _id: input.blockId, societyId: oid(societyId) }).select('name').lean();
    if (!block) throw new AssetError('That wing does not belong to this society.');
    blockName = block.name;
  }

  let vendorName: string | undefined;
  if (input.vendorId) {
    const vendor = await Vendor.findOne({ _id: input.vendorId, societyId: oid(societyId), isActive: true })
      .select('name').lean();
    if (!vendor) throw new AssetError('That vendor is unknown to this society or inactive.');
    vendorName = vendor.name;
  }

  return Asset.create({
    societyId: oid(societyId),
    assetCode: await nextAssetCode(societyId),
    name: String(input.name).trim(),
    category: input.category,
    blockId: input.blockId ? oid(input.blockId) : undefined,
    blockName,
    location: input.location,
    vendorId: input.vendorId ? oid(input.vendorId) : undefined,
    vendorName,
    amcExpiresOn: input.amcExpiresOn ? new Date(input.amcExpiresOn) : undefined,
    isActive: true,
    notes: input.notes,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function updateAsset(societyId: string, id: string, body: any, actor: Actor): Promise<IAsset> {
  const asset = await Asset.findOne({ _id: id, societyId: oid(societyId) });
  if (!asset) throw new AssetError('That equipment could not be found.', 404);

  if (body.name) asset.name = String(body.name).trim();
  if (body.location !== undefined) asset.location = body.location;
  if (body.notes !== undefined) asset.notes = body.notes;
  if (body.amcExpiresOn !== undefined) {
    asset.amcExpiresOn = body.amcExpiresOn ? new Date(body.amcExpiresOn) : undefined;
  }
  if (body.isActive !== undefined) asset.isActive = body.isActive;
  if (body.vendorId !== undefined) {
    if (body.vendorId) {
      const vendor = await Vendor.findOne({ _id: body.vendorId, societyId: oid(societyId), isActive: true })
        .select('name').lean();
      if (!vendor) throw new AssetError('That vendor is unknown to this society or inactive.');
      asset.vendorId = oid(body.vendorId);
      asset.vendorName = vendor.name;
    } else {
      asset.vendorId = undefined;
      asset.vendorName = undefined;
    }
  }

  asset.updatedBy = oid(actor.userId);
  asset.updatedByName = actor.userName;
  await asset.save();
  return asset;
}

export async function listAssets(societyId: string, query: any = {}) {
  const filter: any = { societyId: oid(societyId) };
  if (query.active !== 'all') filter.isActive = true;
  if (query.category) filter.category = query.category;
  return Asset.find(filter).sort({ category: 1, name: 1 }).lean();
}

export interface ScanResult {
  asset: { _id: string; name: string; assetCode: string; category: string; location?: string; blockName?: string };
  societyId: string;
  /** Pre-chosen so the person scanning types as little as possible. */
  suggestedCategoryId?: string;
  underAmc: boolean;
}

/**
 * Resolve a sticker.
 *
 * The token identifies the SOCIETY too — the scan URL carries nothing else, and
 * the person holding the phone may not even be signed in yet. That is why the
 * token is random rather than derived from the asset id: a guessable one would
 * let anybody enumerate a society's equipment.
 */
export async function resolveScan(qrToken: string): Promise<ScanResult> {
  const asset = await Asset.findOne({ qrToken, isActive: true }).lean();
  if (!asset) throw new AssetError('That sticker does not match any equipment.', 404);

  // Offer the matching complaint category so the form arrives filled in.
  const wanted = asset.category === 'LIFT' ? 'Lift'
    : asset.category === 'PUMP' || asset.category === 'TANK' ? 'Water supply'
    : asset.category === 'DG' ? 'Electrical'
    : undefined;
  const cat = wanted
    ? await ComplaintCategory.findOne({ societyId: asset.societyId, category: wanted, isActive: true })
        .sort({ sortOrder: 1 }).select('_id').lean()
    : null;

  return {
    asset: {
      _id: String(asset._id), name: asset.name, assetCode: asset.assetCode,
      category: asset.category, location: asset.location, blockName: asset.blockName,
    },
    societyId: String(asset.societyId),
    suggestedCategoryId: cat ? String(cat._id) : undefined,
    underAmc: Boolean(asset.amcExpiresOn && asset.amcExpiresOn > new Date()),
  };
}

/** AMCs running out, so a renewal conversation starts before the cover lapses. */
export async function findExpiringAmcs(societyId: string, withinDays = 45, at = new Date()) {
  const horizon = new Date(at.getTime() + withinDays * 86_400_000);
  return Asset.find({
    societyId: oid(societyId), isActive: true,
    amcExpiresOn: { $ne: null, $lte: horizon },
  }).select('assetCode name vendorName amcExpiresOn blockName').sort({ amcExpiresOn: 1 }).lean();
}
