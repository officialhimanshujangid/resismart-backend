/**
 * Equipment — the edit path that shipped with no caller, and the AMC sweep.
 *
 * Checks:
 *   1. an asset's wing and kind can now be corrected (updateAsset gained both)
 *   2. editing the AMC date clears the warn marker, so next year's alert fires
 *   3. sweepExpiringAmcs warns the committee, once, about a soon-expiring AMC
 *   4. findExpiringAmcs no longer surfaces long-dead contracts
 *
 *   npx tsx src/scripts/verify-equipment-edit.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Asset } from '../models/asset.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Notification } from '../models/notification.model';
import {
  createAsset, updateAsset, findExpiringAmcs, sweepExpiringAmcs, AssetError,
} from '../services/asset.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const chairId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Admin' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const audit = { societyId, createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup' };
const settle = () => new Promise(r => setTimeout(r, 300));

async function cleanup() {
  await Promise.all([
    Asset.deleteMany({ societyId }), Block.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway society ${societyId}\n`);

  try {
    const [wingA, wingB] = await Block.create([
      { ...audit, name: 'A Wing' }, { ...audit, name: 'B Wing' },
    ]);
    const vendor = await Vendor.create({ ...audit, name: 'Otis', phone: '9000000001', isActive: true });
    const term = await Committee.create({ ...audit, name: 'MC', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: chairId, startDate: new Date('2026-01-01'),
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman', status: 'ACTIVE', memberSnapshot: { name: 'Chair' },
    });

    // ================================================================= edit
    console.log('An asset can be corrected after creation');
    const lift = await createAsset(SID, { name: 'Lift 1', category: 'LIFT', blockId: String(wingA._id) }, actor);
    eq('it starts in A Wing', lift.blockName, 'A Wing');

    const moved = await updateAsset(SID, String(lift._id), { blockId: String(wingB._id) }, actor);
    eq('THE WING CAN BE CHANGED — updateAsset used to refuse it', moved.blockName, 'B Wing');

    const recat = await updateAsset(SID, String(lift._id), { category: 'DG' }, actor);
    eq('...and the kind of equipment too', recat.category, 'DG');

    let badCat = '';
    try { await updateAsset(SID, String(lift._id), { category: 'SPACESHIP' }, actor); }
    catch (e: any) { badCat = e.message; }
    ok('...but not to a kind that does not exist', badCat.includes('kind of equipment'), badCat);

    // ============================================================ AMC marker
    console.log('\nEditing the AMC date re-arms the warning');
    const soon = new Date(Date.now() + 10 * 86_400_000);
    await updateAsset(SID, String(lift._id), { vendorId: String(vendor._id), amcExpiresOn: soon.toISOString() }, actor);

    const warned = await sweepExpiringAmcs(SID);
    ok('the committee is warned about a soon-expiring AMC', warned >= 1);
    await settle();
    const inbox1 = await Notification.find({ societyId, userId: chairId, kind: 'AMC_EXPIRING' }).lean();
    ok('...actually notified', inbox1.length >= 1);

    // A second sweep, same date, must NOT warn again.
    const again = await sweepExpiringAmcs(SID);
    eq('a second sweep does not repeat the same warning', again, 0);

    // Renewing the AMC to a new date re-arms it.
    const next = new Date(Date.now() + 20 * 86_400_000);
    await updateAsset(SID, String(lift._id), { amcExpiresOn: next.toISOString() }, actor);
    const afterRenew = await sweepExpiringAmcs(SID);
    ok('EDITING THE DATE CLEARS THE MARKER — the new expiry warns again', afterRenew >= 1);

    // ============================================================ lower bound
    console.log('\nLong-dead AMCs are not surfaced as "expiring"');
    const old = await createAsset(SID, { name: 'Old pump', category: 'PUMP', blockId: String(wingA._id) }, actor);
    await Asset.collection.updateOne(
      { _id: old._id },
      { $set: { amcExpiresOn: new Date(Date.now() - 400 * 86_400_000), vendorId: vendor._id, vendorName: 'Otis' } },
    );
    const expiring = await findExpiringAmcs(SID);
    ok('an AMC that lapsed over a year ago is NOT listed as running out',
      !expiring.some(a => String(a._id) === String(old._id)),
      JSON.stringify(expiring.map(a => a.name)));
    ok('...while the soon-expiring one still is',
      expiring.some(a => String(a._id) === String(lift._id)));

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
