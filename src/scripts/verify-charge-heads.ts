/**
 * Phase 3 — PER_BLOCK pricing and the three silent charge-head defects.
 * Real database, THROWAWAY societyId, self-cleaning. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-charge-heads.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { FlatSize } from '../models/flat-size.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead, updateChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { wingWiseIncomeExpenditure, incomeExpenditure } from '../services/reports.service';
import { createChargeHeadSchema, updateChargeHeadSchema } from '../validators/society-finance.validator';
import { createFlatSchema, updateFlatSchema } from '../validators/society.validator';
import { projectChargeHead } from '../services/fund-projection.service';

const societyId = new mongoose.Types.ObjectId();
const otherSociety = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;
const refuses = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e: any) { return e; }
};
const base = { code: 'X', name: 'X', category: 'MAINTENANCE' as const };

async function cleanup() {
  const all = { $in: [societyId, otherSociety] };
  await Promise.all([
    LedgerAccount.deleteMany({ societyId: all }), JournalEntry.deleteMany({ societyId: all }),
    FinancePolicy.deleteMany({ societyId: all }), ChargeHead.deleteMany({ societyId: all }),
    MaintenanceInvoice.deleteMany({ societyId: all }), SequenceCounter.deleteMany({ societyId: all }),
    Flat.deleteMany({ societyId: all }), Block.deleteMany({ societyId: all }),
    FlatSize.deleteMany({ societyId: all }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = false;
    await policy.save();

    const mkBlock = async (name: string, sid = societyId) => {
      const [b] = await Block.create([{ name, societyId: sid, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName }]);
      return b;
    };
    const towerA = await mkBlock('Tower A');
    const towerB = await mkBlock('Tower B');
    const towerC = await mkBlock('Tower C');          // deliberately given no rate
    const foreignBlock = await mkBlock('Foreign', otherSociety);

    const mkFlat = (n: string, block: any) => ({
      number: n, blockName: block.name, blockId: block._id, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await Flat.create([mkFlat('A101', towerA), mkFlat('A102', towerA), mkFlat('B101', towerB), mkFlat('C101', towerC)]);

    // ============================================ pricing coherence (Bug 2)
    console.log('A charge head that cannot price anything is refused');
    const rejects = (label: string, body: any) =>
      ok(label, !createChargeHeadSchema.safeParse({ ...base, ...body }).success);

    rejects('UNIFORM with no amount', { pricingMode: 'UNIFORM' });
    rejects('PER_SQFT with no rate', { pricingMode: 'PER_SQFT' });
    rejects('PER_FLAT_SIZE with no size amounts', { pricingMode: 'PER_FLAT_SIZE' });
    rejects('PER_BLOCK with no wing amounts', { pricingMode: 'PER_BLOCK' });
    rejects('METERED with no rate', { pricingMode: 'METERED' });
    rejects('PER_QUANTITY with no key', { pricingMode: 'PER_QUANTITY', perUnitRatePaise: 500 });
    rejects('PERCENTAGE with no percent', { pricingMode: 'PERCENTAGE', percentOf: 'MAINTENANCE' });
    ok('a properly configured head is accepted',
      createChargeHeadSchema.safeParse({ ...base, pricingMode: 'UNIFORM', uniformAmountPaise: 100_000 }).success);
    ok('switching mode on edit is checked too',
      !updateChargeHeadSchema.safeParse({ pricingMode: 'PER_SQFT' }).success);
    ok('an edit that leaves the mode alone is not blocked',
      updateChargeHeadSchema.safeParse({ name: 'Renamed' }).success);

    // ============================================ PER_BLOCK pricing
    console.log('\nBilling a different amount per wing');
    const paint = await createChargeHead(SID, {
      code: 'PAINT26', name: 'Painting contribution', category: 'ADHOC',
      pricingMode: 'PER_BLOCK',
      perBlockAmounts: [
        { blockId: String(towerA._id), label: 'Tower A', amountPaise: 550_000 },
        { blockId: String(towerB._id), label: 'Tower B', amountPaise: 400_000 },
      ],
      isRecurring: false,
    }, actor);
    eq('the head is created with its wing rates', paint.perBlockAmounts?.length, 2);

    const foreign = await refuses(() => createChargeHead(SID, {
      code: 'BAD', name: 'Bad', category: 'ADHOC', pricingMode: 'PER_BLOCK',
      perBlockAmounts: [{ blockId: String(foreignBlock._id), label: 'Foreign', amountPaise: 100_000 }],
    }, actor));
    ok('a wing from another society is refused', !!foreign,
      'it would be stored, never match a flat, and the head would silently bill nothing');

    const run = await generateInvoicesForSociety(SID, {
      period: '2026-04', chargeHeadIds: [String(paint._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });

    const amountOf = async (n: string) => {
      const inv = await MaintenanceInvoice.findOne({ societyId, flatNumber: n }).lean();
      return inv?.totalPaise ?? -1;
    };
    eq('A-101 is billed Tower A\'s rate', await amountOf('A101'), 550_000);
    eq('A-102 too', await amountOf('A102'), 550_000);
    eq('B-101 is billed Tower B\'s rate', await amountOf('B101'), 400_000);
    eq('three flats billed, not four', run.created, 3);
    eq('the total is the two wings added up', run.totalBilledPaise, 1_500_000);

    // ============================================ the silent-zero warning (Bug 3)
    console.log('\nA flat that would be billed nothing is named, not skipped quietly');
    eq('Tower C\'s flat is reported as unbilled', run.unbilled.length, 1);
    eq('...naming the flat', run.unbilled[0]?.flat, 'Tower C C101');
    eq('...and the charge head', run.unbilled[0]?.chargeHeadCode, 'PAINT26');
    ok('...with a reason a human can act on',
      /wing/i.test(run.unbilled[0]?.reason || ''), run.unbilled[0]?.reason);
    ok('no invoice was raised for it', await amountOf('C101') === -1);

    // A flat with no size at all, on a size-priced head.
    const [size2bhk] = await FlatSize.create([{ name: '2BHK', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName }]);
    await Flat.updateOne({ societyId, number: 'A101' }, { $set: { size: size2bhk._id } });
    const sized = await createChargeHead(SID, {
      code: 'SZ', name: 'Size levy', category: 'MAINTENANCE',
      pricingMode: 'PER_FLAT_SIZE',
      perSizeAmounts: [{ flatSizeId: String(size2bhk._id), label: '2BHK', amountPaise: 300_000 }],
    }, actor);
    const sizeRun = await generateInvoicesForSociety(SID, {
      period: '2026-05', chargeHeadIds: [String(sized._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    eq('only the sized flat is billed', sizeRun.created, 1);
    eq('the other three are named', sizeRun.unbilled.length, 3);
    ok('...saying the size is missing',
      sizeRun.unbilled.every(u => /size/i.test(u.reason)),
      JSON.stringify(sizeRun.unbilled.map(u => u.reason)));

    // A-102 and B-101 carry April arrears but have no charge this run. They used
    // to reach invoice creation, produce a single ₹0 Debtors line, and fail
    // inside postJournal — the whole invoice lost, reported only as a log line.
    ok('a flat with arrears but no charges fails nothing',
      sizeRun.errors.length === 0, JSON.stringify(sizeRun.errors));
    eq('...it is skipped cleanly instead', sizeRun.skipped, 3);

    // A metered head with no reading is NOT a setup gap — it must stay quiet.
    const metered = await createChargeHead(SID, {
      code: 'WTR', name: 'Water', category: 'WATER', pricingMode: 'METERED', perUnitRatePaise: 2_000,
    }, actor);
    const meterRun = await generateInvoicesForSociety(SID, {
      period: '2026-06', chargeHeadIds: [String(metered._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    eq('a missing meter reading raises no false alarm', meterRun.unbilled.length, 0);

    // ============================================ PER_SQFT can actually be set up
    //
    // The area lives on the SIZE and nowhere else: entered once per layout, and a
    // correction there fixes every flat of that size at once. PER_SQFT used to be
    // unusable entirely — the field existed on the flat but nothing accepted it.
    console.log('\nA per-sqft head bills on its size\'s area');

    // A flat now has to say which size it is, because that is where its area
    // lives — created without one it could never be billed per square foot.
    ok('creating a flat WITHOUT a size is refused',
      !createFlatSchema.safeParse({ number: '1', blockId: String(towerA._id) }).success);
    ok('...and with one it is accepted',
      createFlatSchema.safeParse({ number: '1', blockId: String(towerA._id), sizeId: String(size2bhk._id) }).success);

    // The area belongs to the SIZE, so it is entered once and every flat of that
    // size bills off it — rather than being typed on two hundred flats.
    const [size1bhk] = await FlatSize.create([{
      name: '1BHK 1200', carpetAreaSqft: 1200, builtUpAreaSqft: 1400, societyId,
      createdBy: userId, updatedBy: userId,
    }]);
    await FlatSize.updateOne({ _id: size2bhk._id }, { $set: { carpetAreaSqft: 620, builtUpAreaSqft: 800 } });
    await Flat.updateOne({ societyId, number: 'A102' }, { $set: { size: size1bhk._id } });

    const sqft = await createChargeHead(SID, {
      code: 'SQFT', name: 'Per sqft levy', category: 'MAINTENANCE',
      pricingMode: 'PER_SQFT', ratePerSqftPaise: 500, areaBasis: 'CARPET',
    }, actor);
    const sqftRun = await generateInvoicesForSociety(SID, {
      period: '2026-08', chargeHeadIds: [String(sqft._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    const areaOf = async (n: string) =>
      (await MaintenanceInvoice.findOne({ societyId, flatNumber: n, billingPeriod: '2026-08' }).lean())?.totalPaise;
    eq('A-101 bills its size\'s 620 sqft × ₹5', await areaOf('A101'), 310_000);
    eq('A-102 bills the other size\'s 1200 sqft × ₹5', await areaOf('A102'), 600_000);
    ok('a flat with no size is named, not silently skipped',
      sqftRun.unbilled.some(u => /size/i.test(u.reason)),
      JSON.stringify(sqftRun.unbilled.map(u => u.reason)));

    // Correcting the size fixes every flat of that size at once.
    await FlatSize.updateOne({ _id: size1bhk._id }, { $set: { carpetAreaSqft: 1500 } });
    const reRun = await generateInvoicesForSociety(SID, {
      period: '2026-09', chargeHeadIds: [String(sqft._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    const a102Sept = await MaintenanceInvoice.findOne({ societyId, flatNumber: 'A102', billingPeriod: '2026-09' }).lean();
    eq('the corrected size flows through', a102Sept?.totalPaise, 750_000);

    // There is deliberately no per-flat override: the size is the only place an
    // area lives, so a stale second copy cannot quietly do the billing.
    ok('a flat carries no area of its own',
      !('carpetAreaSqft' in (await Flat.findOne({ societyId, number: 'A102' }).lean() as any)),
      'a second place to hold the same number is a second number to keep in step');
    ok('...and the API will not accept one',
      !('carpetAreaSqft' in (updateFlatSchema.parse({ carpetAreaSqft: 1800 } as any) as any)),
      'an accepted-but-ignored field reads as working and is not');

    // The projection must agree with the engine, or a preview promises a figure
    // the real run will not produce.
    const proj = await projectChargeHead(SID, { chargeHeadId: String(sqft._id) }, actor);
    eq('the projection reads the same areas', proj.perRunPaise, 310_000 + 750_000);

    ok('a flat size can be created without an area',
      !!(await FlatSize.create([{ name: 'Studio', societyId, createdBy: userId, updatedBy: userId }]))[0]);

    // ============================================ applicability survives an edit (Bug 1)
    console.log('\nWing scoping survives an edit that does not mention it');
    const scoped = await createChargeHead(SID, {
      code: 'LIFT', name: 'Lift AMC', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 50_000,
      applicability: { occupancy: ['ALL'], blockIds: [String(towerA._id)] },
    }, actor);
    eq('it starts scoped to one wing', scoped.applicability?.blockIds?.length, 1);

    // Exactly what the edit form sends: occupancy only.
    const edited = await updateChargeHead(SID, String(scoped._id), {
      name: 'Lift AMC (revised)',
      applicability: { occupancy: ['ALL'] },
    }, actor);
    eq('the rename lands', edited.name, 'Lift AMC (revised)');
    eq('...and the wing scoping is STILL there', edited.applicability?.blockIds?.length, 1,
      );
    eq('...pointing at the same wing', String(edited.applicability?.blockIds?.[0]), String(towerA._id));

    // An explicit empty array must still be able to clear it.
    const cleared = await updateChargeHead(SID, String(scoped._id), {
      applicability: { occupancy: ['ALL'], blockIds: [] },
    }, actor);
    eq('an explicit empty array clears the scoping', cleared.applicability?.blockIds?.length, 0);

    const foreignScope = await refuses(() => updateChargeHead(SID, String(scoped._id), {
      applicability: { blockIds: [String(foreignBlock._id)] },
    }, actor));
    ok('scoping to another society\'s wing is refused', !!foreignScope);

    // ============================================ merged-document guard
    console.log('\nAn edit cannot leave a head unable to price');
    const stripped = await refuses(() => updateChargeHead(SID, String(paint._id), {
      perBlockAmounts: [],
    }, actor));
    ok('removing every wing rate is refused', !!stripped,
      'the head would have billed ₹0 for ever, silently');
    ok('...with a reason', /wing/i.test(stripped?.message || ''), stripped?.message);

    const modeSwitch = await refuses(() => updateChargeHead(SID, String(paint._id), {
      pricingMode: 'PER_SQFT',
    }, actor));
    ok('switching mode without its config is refused', !!modeSwitch, modeSwitch?.message);

    // ============================================ ties to the wing report
    console.log('\nPER_BLOCK income lands on the right wing');
    const wing = await wingWiseIncomeExpenditure(SID, { fy: '2026' });
    const wingBy = (l: string) => wing.wings.find((w: any) => w.label === l);
    // Asserting an exact rupee total here would just re-add every run above and
    // break each time one is added. The properties worth holding are that the
    // wings account for ALL the income and that nothing lands in the wrong place.
    const ie = await incomeExpenditure(SID, { fy: '2026' });
    eq('the wings account for every rupee billed', wing.totals.totalIncomePaise, ie.totalIncomePaise);
    ok('Tower A carries the most, having two flats and the sqft levy',
      (wingBy('Tower A')?.totalIncomePaise || 0) > (wingBy('Tower B')?.totalIncomePaise || 0));
    eq('Tower B collected one', wingBy('Tower B')?.totalIncomePaise, 400_000);
    eq('Tower C collected nothing', wingBy('Tower C')?.totalIncomePaise, 0);
    ok('nothing is stranded in Common', wing.common.totalIncomePaise === 0,
      `Common holds ${rupees(wing.common.totalIncomePaise)}`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
