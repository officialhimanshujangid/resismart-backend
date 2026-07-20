/**
 * One-time: let societies see the modules that were hidden from them.
 *
 * The fault this repairs: `resolveOpsModules` used to default to `['GATE']`
 * and WRITE that guess into the policy. From then on it was indistinguishable
 * from an admin deliberately switching Staff, Complaints and Equipment off —
 * so those screens were invisible, permanently, to every society created
 * before this ran. An admin cannot enable a feature they have never seen.
 *
 * What this does: marks such rows as inferred (`modulesInferredAt`), which
 * makes `resolveOpsModules` work them out again on the next read — this time
 * from actual data, with everything on by default.
 *
 * **The honest caveat.** A row written by the old code and a row an admin
 * genuinely saved are identical on disk; the marker did not exist yet, so
 * there is nothing to tell them apart. This therefore re-opens modules for a
 * society that had deliberately turned them off. That is the right trade while
 * no real society has made that choice, and it is the reason this is a script
 * you run once knowingly rather than something that fires on boot.
 *
 * Safe to run twice: rows already marked, and rows saved since the fix, are
 * left alone.
 *
 *   npx tsx src/scripts/migrate-ops-modules.ts          # report only
 *   npx tsx src/scripts/migrate-ops-modules.ts --apply  # actually change
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { resolveOpsModules, OPS_MODULE_CATALOG } from '../services/ops-policy.service';

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(apply ? 'APPLYING changes\n' : 'Dry run — nothing will be changed. Add --apply to commit.\n');

  const ALL = OPS_MODULE_CATALOG.map(m => m.key);

  // Rows that have a module list, no marker, and are missing at least one
  // module — i.e. exactly the shape the old inference left behind.
  const suspect = await SocietyOpsPolicy.find({
    modules: { $exists: true, $ne: [] },
    modulesInferredAt: { $exists: false },
  }).select('societyId modules').lean();

  const affected = suspect.filter(p => (p.modules || []).length < ALL.length);

  if (!affected.length) {
    console.log('Nothing to repair — every society already sees its full module list.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${affected.length} societ${affected.length === 1 ? 'y' : 'ies'} to re-evaluate:\n`);
  for (const p of affected) {
    const missing = ALL.filter(m => !(p.modules || []).includes(m));
    console.log(`  ${p.societyId}  has [${(p.modules || []).join(', ')}]  ·  hidden: ${missing.join(', ')}`);
  }

  if (!apply) {
    console.log('\nRe-run with --apply to let these societies see their hidden modules.');
    await mongoose.disconnect();
    return;
  }

  console.log('');
  for (const p of affected) {
    await SocietyOpsPolicy.updateOne(
      { _id: (p as any)._id },
      { $set: { modulesInferredAt: new Date() } },
    );
    // Force the re-evaluation now rather than leaving it to whoever next loads
    // a sidebar, so this script's output is the truth rather than a promise.
    const now = await resolveOpsModules(String(p.societyId));
    console.log(`  ${p.societyId}  now sees [${now.join(', ')}]`);
  }

  console.log(`\nDone. ${affected.length} societ${affected.length === 1 ? 'y' : 'ies'} repaired.`);
  console.log('Any admin who genuinely wants a module off can switch it off in Gate → Settings,');
  console.log('and that choice will now stick permanently.');

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
