/**
 * Phase 1 — vendor master, ledger and payable. Real database, THROWAWAY
 * societyId, self-cleaning. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-vendors.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { seedChartOfAccounts, ACCOUNT_CODES } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createExpense, approveExpense, payExpense } from '../services/expenses.service';
import { trialBalance, vendorRegister } from '../services/reports.service';
import {
  createVendor, updateVendor, deleteVendor, listVendors, vendorLedger, vendorPayables,
} from '../services/vendor.service';
import { createVendorSchema, updateVendorSchema } from '../validators/society-finance.validator';

const societyId = new mongoose.Types.ObjectId();
const otherSociety = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const approverId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const approver = { userId: approverId.toString(), userName: 'Approver' };
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
const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
  const r = rows.find(x => x.code === code);
  return r ? r.creditPaise - r.debitPaise : 0; // liability: credit-positive
};

async function cleanup() {
  const all = { $in: [societyId, otherSociety] };
  await Promise.all([
    LedgerAccount.deleteMany({ societyId: all }), JournalEntry.deleteMany({ societyId: all }),
    FinancePolicy.deleteMany({ societyId: all }), Expense.deleteMany({ societyId: all }),
    Vendor.deleteMany({ societyId: all }), SequenceCounter.deleteMany({ societyId: all }),
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

    // ==================================================== validation
    console.log('The form refuses what Form 26Q would reject');
    ok('a malformed PAN is refused',
      !createVendorSchema.safeParse({ name: 'X', pan: 'NOTAPAN' }).success);
    ok('a well-formed PAN is accepted',
      createVendorSchema.safeParse({ name: 'X', pan: 'AABCL1234M' }).success);
    ok('a malformed GSTIN is refused',
      !createVendorSchema.safeParse({ name: 'X', gstin: '27ABC' }).success);
    ok('a bad IFSC is refused',
      !createVendorSchema.safeParse({ name: 'X', bank: { ifsc: 'HD1' } }).success);
    ok('a good IFSC is accepted',
      createVendorSchema.safeParse({ name: 'X', bank: { ifsc: 'HDFC0001234' } }).success);

    // The coherence rule — the whole reason PAN mattered enough to build this.
    ok('TDS on with no rate is refused',
      !createVendorSchema.safeParse({ name: 'X', tdsApplicable: true, pan: 'AABCL1234M' }).success);
    ok('TDS on with no PAN is refused',
      !createVendorSchema.safeParse({ name: 'X', tdsApplicable: true, tdsRatePercent: 2 }).success);
    ok('TDS on, fully specified, is accepted',
      createVendorSchema.safeParse({ name: 'X', tdsApplicable: true, tdsRatePercent: 2, pan: 'AABCL1234M' }).success);
    ok('TDS off needs neither',
      createVendorSchema.safeParse({ name: 'X' }).success);
    ok('the same rule applies on edit, not just create',
      !updateVendorSchema.safeParse({ tdsApplicable: true }).success);

    // ==================================================== create + fields
    console.log('\nEvery field the vendor actually has');
    const lift = await createVendor(SID, {
      name: 'LiftCo Engineering',
      contactPerson: 'R. Menon', phone: '9876543210', email: 'ops@liftco.in',
      pan: 'AABCL1234M', gstin: '27AABCL1234M1Z5',
      tdsApplicable: true, tdsSection: '194C', tdsRatePercent: 2,
      tdsThresholdSinglePaise: 3_000_000, tdsThresholdAnnualPaise: 10_000_000,
      bank: { accountName: 'LiftCo Engineering', accountNumber: '918020031234567', ifsc: 'HDFC0001234', bankName: 'HDFC', upiId: 'liftco@okhdfcbank' },
      notes: 'AMC renews every April',
    }, actor);

    eq('PAN is stored — it could not be entered anywhere before', lift.pan, 'AABCL1234M');
    eq('TDS section is stored, which 26Q groups by', lift.tdsSection, '194C');
    eq('the single-bill threshold is settable', lift.tdsThresholdSinglePaise, 3_000_000);
    eq('the annual threshold is settable', lift.tdsThresholdAnnualPaise, 10_000_000);
    eq('contact details survive', lift.phone, '9876543210');

    console.log('\nBank details are stored but never handed back');
    eq('only the last four digits are exposed', lift.bank?.last4, '4567');
    ok('the account number itself is not in the response',
      !JSON.stringify(lift).includes('918020031234567'),
      'the full account number leaked to the client');
    const rawLift = await Vendor.findById(lift._id).lean();
    ok('...and it is encrypted at rest, not stored plainly',
      !!rawLift?.bank?.accountNumberEnc && rawLift.bank.accountNumberEnc !== '918020031234567');
    ok('...with its own IV and auth tag', !!rawLift?.bank?.accountNumberIv && !!rawLift?.bank?.accountNumberTag);
    eq('audit columns are set on create', rawLift?.createdByName, 'Verifier');
    eq('...including updatedBy', rawLift?.updatedByName, 'Verifier');

    // ==================================================== update
    console.log('\nEditing is whitelisted, not a blind overwrite');
    const edited = await updateVendor(SID, lift._id, {
      phone: '9000000000',
      societyId: String(otherSociety),          // must be ignored
      createdByName: 'Impostor',                 // must be ignored
      tdsApplicable: true, tdsRatePercent: 2, pan: 'AABCL1234M',
    } as any, approver);
    eq('the editable field changes', edited.phone, '9000000000');
    const afterEdit = await Vendor.findById(lift._id).lean();
    eq('societyId cannot be rewritten by the client', String(afterEdit?.societyId), SID);
    eq('...nor the original author', afterEdit?.createdByName, 'Verifier');
    eq('updatedBy records who actually edited', afterEdit?.updatedByName, 'Approver');
    eq('the bank account survives an edit that omits it', afterEdit?.bank?.last4, '4567');

    // ==================================================== ledger + payable
    console.log('\nThe vendor ledger that never existed');
    const mkBill = async (v: string, paise: number) => {
      const e = await createExpense(SID, {
        vendorId: v, category: 'REPAIRS', paymentMode: 'BANK',
        lineItems: [{ expenseAccountCode: '5150', amountPaise: paise }],
      }, actor);
      await approveExpense(SID, String(e._id), approver);
      return e;
    };

    // ₹60,000 bill, 2% TDS → ₹58,800 payable.
    const bill1 = await mkBill(lift._id, 6_000_000);
    eq('TDS is withheld at the vendor rate', bill1.tdsPaise, 120_000);
    eq('...leaving the net payable', bill1.netPayablePaise, 5_880_000);

    let led = await vendorLedger(SID, lift._id);
    eq('the ledger has the accrual', led.entries.length, 1);
    eq('an approved bill is a credit — we owe it', led.entries[0].creditPaise, 5_880_000);
    eq('outstanding payable is the net of TDS', led.outstandingPayablePaise, 5_880_000);
    eq('running balance tracks it', led.entries[0].balancePaise, 5_880_000);
    eq('this FY gross is the bill before TDS', led.fyGrossPaise, 6_000_000);
    eq('...and this FY TDS', led.fyTdsPaise, 120_000);

    await payExpense(SID, String(bill1._id), approver);
    led = await vendorLedger(SID, lift._id);
    eq('paying adds the settling debit', led.entries.length, 2);
    eq('...and clears the payable', led.outstandingPayablePaise, 0);
    eq('billed total is unaffected by payment', led.billedPaise, 5_880_000);
    eq('...and paid total now matches', led.paidPaise, 5_880_000);

    // A second, unpaid bill leaves a real outstanding figure — and demonstrates
    // the thresholds. ₹20,000 is under the ₹30,000 single-bill limit, and the
    // year's running total (₹60,000 + ₹20,000 = ₹80,000) is still under the
    // ₹1,00,000 aggregate, so nothing is withheld and the full amount is owed.
    const bill2 = await mkBill(lift._id, 2_000_000);
    eq('a bill under both TDS thresholds withholds nothing', bill2.tdsPaise, 0);
    eq('...so the whole bill is payable', bill2.netPayablePaise, 2_000_000);
    led = await vendorLedger(SID, lift._id);
    eq('an unpaid bill shows as outstanding', led.outstandingPayablePaise, 2_000_000);

    // ============================== the property that makes the number trustworthy
    console.log('\nEvery vendor\'s payable ties to the Creditors control account');
    const plumber = await createVendor(SID, { name: 'Sharma Plumbing' }, actor);
    await mkBill(plumber._id, 1_500_000); // no TDS configured → full amount payable

    const payables = await vendorPayables(SID);
    const sumPayables = [...payables.values()].reduce((s, v) => s + v, 0);
    const creditors = balOf((await trialBalance(SID)).rows, ACCOUNT_CODES.CREDITORS);
    eq('the sum of vendor payables equals 2200 Sundry Creditors', sumPayables, creditors);
    ok('...and it is a real, non-zero figure', creditors > 0, `2200 stands at ${rupees(creditors)}`);
    eq('the plumber owes the full bill, no TDS deducted', payables.get(plumber._id), 1_500_000);

    // The ledger must show the Creditors leg only. An expense also debits 5150
    // with the same vendor tag; counting both would double every bill.
    const ledP = await vendorLedger(SID, plumber._id);
    eq('the expense leg is excluded from the payable ledger', ledP.entries.length, 1);
    eq('...so the payable is the bill, not twice the bill', ledP.outstandingPayablePaise, 1_500_000);

    // ==================================================== the vendor register
    console.log('\nThe vendor register ties to the Balance Sheet');
    const reg = await vendorRegister(SID);
    const liftRow = reg.rows.find(r => r.name === 'LiftCo Engineering');
    const plumberRow = reg.rows.find(r => r.name === 'Sharma Plumbing');

    eq('both vendors appear', reg.rows.length, 2);
    eq('LiftCo shows both bills', liftRow?.bills, 2);
    eq('...billed ₹60,000 + ₹20,000', liftRow?.billedPaise, 8_000_000);
    eq('...TDS withheld on the first only', liftRow?.tdsPaise, 120_000);
    eq('...₹58,800 paid so far', liftRow?.paidPaise, 5_880_000);
    eq('...and ₹20,000 still owed', liftRow?.outstandingPaise, 2_000_000);
    eq('the plumber owes the full bill', plumberRow?.outstandingPaise, 1_500_000);

    // The property that makes this report worth printing.
    const creditorsNow = balOf((await trialBalance(SID)).rows, ACCOUNT_CODES.CREDITORS);
    eq('the register total equals Sundry Creditors', reg.totals.outstandingPaise, creditorsNow);
    ok('...and it is a real figure', creditorsNow > 0, `2200 stands at ${rupees(creditorsNow)}`);

    // A vendor with no activity and nothing owed is noise, not a row.
    const idle = await createVendor(SID, { name: 'Never Used' }, actor);
    const regIdle = await vendorRegister(SID);
    ok('an untouched vendor is left out', !regIdle.rows.some(r => r.name === 'Never Used'));
    await deleteVendor(SID, idle._id, actor);

    // ==================================================== list
    console.log('\nThe list screen');
    const listed = await listVendors(SID, {});
    eq('both vendors are listed', listed.pagination.total, 2);
    ok('no account number reaches the list either',
      !JSON.stringify(listed).includes('918020031234567'));

    const searched = await listVendors(SID, { search: 'plumb' });
    eq('search finds by name, case-insensitively', searched.pagination.total, 1);
    eq('...the right one', searched.vendors[0].name, 'Sharma Plumbing');
    const byPan = await listVendors(SID, { search: 'AABCL1234M' });
    eq('search also matches PAN', byPan.pagination.total, 1);

    // A regex metacharacter in the search box must be searched for, not executed.
    const weird = await createVendor(SID, { name: 'C++ Services (Pvt)' }, actor);
    const safeSearch = await listVendors(SID, { search: 'C++ Services (Pvt)' });
    eq('a name full of regex characters is searchable', safeSearch.pagination.total, 1);

    // The 26Q blocker is surfaced here too, as it is on the TDS register.
    console.log('\nA TDS vendor with no PAN is flagged');
    const noPan = await createVendor(SID, {
      name: 'Cash Contractor', tdsApplicable: true, tdsRatePercent: 2, pan: 'AAAAA1111A',
    }, actor);
    await Vendor.updateOne({ _id: noPan._id }, { $unset: { pan: 1 } });   // as a legacy row would be
    await mkBill(noPan._id, 5_000_000);
    const regPan = await vendorRegister(SID);
    eq('it is counted', regPan.missingPanCount, 1);
    ok('...and flagged on its own row',
      regPan.rows.find(r => r.name === 'Cash Contractor')?.missingPan === true);
    // Still ties, now with three vendors and a part-paid one among them.
    eq('the register still equals Sundry Creditors',
      regPan.totals.outstandingPaise, balOf((await trialBalance(SID)).rows, ACCOUNT_CODES.CREDITORS));

    // ==================================================== delete guard
    console.log('\nDeleting a vendor cannot orphan its history');
    const del = await deleteVendor(SID, weird._id, actor);
    eq('an unused vendor is genuinely removed', del.deleted, true);
    eq('...and is gone', await Vendor.countDocuments({ societyId, _id: weird._id }), 0);

    const guarded = await deleteVendor(SID, lift._id, actor);
    eq('a vendor with bills is NOT deleted', guarded.deleted, false);
    ok('...the reason is explained', /deactivated/i.test(guarded.message), guarded.message);
    const stillThere = await Vendor.findById(lift._id).lean();
    ok('...the record survives', !!stillThere);
    eq('...but is retired', stillThere?.isActive, false);

    const led2 = await vendorLedger(SID, lift._id);
    eq('its ledger still reads after deactivation', led2.outstandingPayablePaise, 2_000_000);

    const activeOnly = await listVendors(SID, { isActive: true });
    ok('a retired vendor drops out of the active list',
      !activeOnly.vendors.some(v => v._id === lift._id));

    // ==================================================== tenant isolation
    console.log('\nOne society cannot reach another\'s vendors');
    const foreign = await refuses(() => vendorLedger(String(otherSociety), lift._id));
    ok('a vendor id from another society is refused', !!foreign, 'cross-tenant read succeeded');
    const foreignEdit = await refuses(() => updateVendor(String(otherSociety), lift._id, { phone: '1' }, actor));
    ok('...and cannot be edited across societies', !!foreignEdit);
    const foreignDelete = await refuses(() => deleteVendor(String(otherSociety), lift._id, actor));
    ok('...nor deleted', !!foreignDelete);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
