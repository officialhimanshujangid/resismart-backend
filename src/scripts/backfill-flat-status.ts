/**
 * Give every flat an honest status.
 *
 * `Flat.status` used to default to VACANT, so a society that imported its flats
 * — or created them before anybody moved in, and then moved people in through
 * the household screens — could be left with occupied flats still marked empty.
 * That is not cosmetic. The gate branches on this field: a vacant flat has no
 * household to ask, so the request goes to the whole serving committee instead.
 * A society in this state notifies every committee member about every arrival
 * in the building, and a committee member who is also a resident sees alerts
 * about their neighbours' visitors. It reads as a leak because, in effect, it
 * is one.
 *
 * The rule, applied only to flats currently marked VACANT or carrying no status
 * at all — a flat somebody has explicitly marked RENTED or OWNER_OCCUPIED is
 * left exactly as it is:
 *
 *   an active TENANT household   → RENTED
 *   an active OWNER household    → OWNER_OCCUPIED
 *   neither                      → genuinely vacant, left alone
 *
 * Reads before it writes and prints what it would do. Nothing changes without
 * `--apply`, because a script that silently rewrites occupancy across every
 * society is not a script anybody should run twice by accident.
 *
 *   npx tsx src/scripts/backfill-flat-status.ts            # dry run
 *   npx tsx src/scripts/backfill-flat-status.ts --apply
 *   npx tsx src/scripts/backfill-flat-status.ts --apply --society <id>
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';

const apply = process.argv.includes('--apply');
const societyArg = process.argv[process.argv.indexOf('--society') + 1];
const onlySociety = process.argv.includes('--society') && societyArg && !societyArg.startsWith('--')
  ? societyArg : null;

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(apply ? 'APPLYING changes\n' : 'DRY RUN — nothing will be written. Add --apply to commit.\n');

  const filter: Record<string, unknown> = {
    $or: [{ status: FlatStatus.VACANT }, { status: { $exists: false } }, { status: null }],
  };
  if (onlySociety) filter.societyId = new mongoose.Types.ObjectId(onlySociety);

  const candidates = await Flat.find(filter).select('_id societyId number blockName status').lean();
  console.log(`${candidates.length} flat(s) marked vacant or unset.\n`);

  let toRented = 0, toOwner = 0, leftVacant = 0;

  for (const flat of candidates) {
    // One query per flat rather than a clever aggregation: this runs once, on
    // a few thousand rows, and being obviously correct matters more here than
    // being fast. A wrong occupancy is a privacy bug, not a slow page.
    const rows = await Resident.find({
      societyId: flat.societyId, flatId: flat._id, isActive: true,
    }).select('householdType').lean();

    const hasTenant = rows.some(r => r.householdType === 'TENANT');
    const hasOwner = rows.some(r => r.householdType === 'OWNER');

    const next = hasTenant ? FlatStatus.RENTED
      : hasOwner ? FlatStatus.OWNER_OCCUPIED
      : null;

    const label = `${flat.blockName || ''} ${flat.number}`.trim();

    if (!next) {
      leftVacant++;
      // A flat with no status at all still needs one written, or it fails
      // validation the next time anything saves it.
      if (!flat.status && apply) {
        await Flat.updateOne({ _id: flat._id }, { $set: { status: FlatStatus.VACANT } });
      }
      continue;
    }

    if (next === FlatStatus.RENTED) toRented++; else toOwner++;
    console.log(`  ${label.padEnd(16)} vacant → ${next}`);
    if (apply) await Flat.updateOne({ _id: flat._id }, { $set: { status: next } });
  }

  console.log(`\n  → RENTED          ${toRented}`);
  console.log(`  → OWNER_OCCUPIED  ${toOwner}`);
  console.log(`  genuinely vacant  ${leftVacant}`);
  if (!apply && (toRented || toOwner)) {
    console.log('\nNothing was written. Re-run with --apply.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
