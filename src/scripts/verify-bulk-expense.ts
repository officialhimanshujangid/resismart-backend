/**
 * Phase 2 — bulk expense entry.
 * Real database, THROWAWAY societyId, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertions are the two about money: a batch must post
 * EXACTLY what the preview promised, and a society's approval threshold must
 * apply to a spreadsheet exactly as it applies to the screen. A bulk tool that
 * quietly bypasses separation of duties is worse than no bulk tool.
 *
 *   npx ts-node src/scripts/verify-bulk-expense.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { FinanceFund } from '../models/finance-fund.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { seedChartOfAccounts, ACCOUNT_CODES, DEFAULT_ACCOUNTS, ACCOUNT_GROUPS } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createFund } from '../services/funds.service';
import { preview, commit, repeatFrom, templateFor } from '../services/bulk-expense.service';
import { completeSetup } from '../services/finance-setup.service';
import { approveExpense } from '../services/expenses.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const secondActor = { userId: otherUserId.toString(), userName: 'Second Officer' };
const SID = societyId.toString();
/** Extra throwaway societies created mid-run, so cleanup can find them. */
const squatters: mongoose.Types.ObjectId[] = [];

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

const csv = (s: string) => ({ csvText: s.trim() });

async function cleanup() {
  for (const s of squatters) await LedgerAccount.deleteMany({ societyId: s });
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), Expense.deleteMany({ societyId }),
    Vendor.deleteMany({ societyId }), Block.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
  ]);
}

/** What the bank account actually holds, straight from the ledger. */
const bankBalance = async () =>
  (await LedgerAccount.findOne({ societyId, code: ACCOUNT_CODES.BANK }).lean())?.currentBalancePaise ?? 0;

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);
    // The setup gate from Phase 1 is live now — a society that has not answered
    // cannot record anything, and that includes this.
    await completeSetup(SID, actor.userId, actor.userName, {
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 10_000_000 }],
      declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });

    const [towerA] = await Block.create([{
      name: 'Tower A', societyId,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    }]);
    const mseb = await Vendor.create({
      societyId, name: 'MSEB', phone: '9000000001', isActive: true,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    const repairFund = await createFund(SID, { name: 'Repair Fund', category: 'REPAIR' }, actor);

    // ==================================================== the seeded staff account
    console.log('The staff payments account exists and no code is claimed twice');
    const staffAcct = await LedgerAccount.findOne({ societyId, code: '5200' }).lean();
    ok('5200 Staff Payments was seeded', Boolean(staffAcct), 'missing');
    eq('...as an expense account', staffAcct?.type, 'EXPENSE');
    ok('...and it is NOT the outsourced-agency account 5100',
      staffAcct?.name !== 'Security / Guard Charges');

    // The `1500` bug: an account and a group claimed the same code, $setOnInsert
    // matched the existing row, did nothing, and the account was never created.
    const claimed = new Map<string, string>();
    let collision = '';
    for (const a of [...DEFAULT_ACCOUNTS.map(a => ({ c: a.code, n: `account ${a.name}` })),
                     ...ACCOUNT_GROUPS.map(g => ({ c: g.code, n: `group ${g.name}` }))]) {
      if (claimed.has(a.c)) collision = `${a.c}: ${claimed.get(a.c)} vs ${a.n}`;
      claimed.set(a.c, a.n);
    }
    ok('no account and group share a code — the 1500 bug cannot recur', !collision, collision);

    // The other direction: a society's OWN account already sitting on a code we
    // later seed. `$setOnInsert` matches it and does nothing, so the standard
    // account never appears. The society's meaning wins — which is right — but
    // it must not happen silently.
    const squatterId = new mongoose.Types.ObjectId();
    squatters.push(squatterId);
    await LedgerAccount.create({
      societyId: squatterId, code: '5200', name: 'Garden Maintenance', type: 'EXPENSE',
      normalBalance: 'DEBIT', isSystem: false, isActive: true, currentBalancePaise: 0,
      createdBy: userId, createdByName: actor.userName,
    });
    await seedChartOfAccounts(squatterId.toString(), actor.userId, actor.userName);
    const squatted = await LedgerAccount.findOne({ societyId: squatterId, code: '5200' }).lean();
    eq('a society that already owns 5200 keeps its own account', squatted?.name, 'Garden Maintenance');
    ok('...and it was never turned into a system account behind their back', squatted?.isSystem === false);
    const others = await LedgerAccount.countDocuments({ societyId: squatterId, code: '5100' });
    eq('...while the rest of the chart still seeds normally', others, 1);

    // ============================================================== names, not codes
    console.log('\nA manager writes names, not account codes');
    const p1 = await preview(SID, csv(`
Date,Head,Amount,Vendor,Block,Fund,Note
2026-07-31,Electricity,45000,MSEB,Tower A,,July bill
2026-07-31,Staff Payments,12000,,,,Gangaram
2026-07-31,Repairs & Maintenance,8000,,,Repair Fund,Pump
`), { shape: 'PER_ROW' });
    eq('every row reads', p1.totals.create, 3);
    eq('...with no errors', p1.totals.error, 0);
    eq('...and the total is right', p1.totalAmountPaise, 6_500_000);
    ok('...the summary says what will happen', p1.summary.includes('3 separate expense vouchers'), p1.summary);

    // Codes still work for anyone who prefers them.
    const p2 = await preview(SID, csv('Head,Amount\n5120,100'), { shape: 'ONE_VOUCHER' });
    eq('a raw code is accepted too', p2.totals.create, 1);

    // ======================================================= one bad row, not one bad file
    console.log('\nOne bad row fails alone');
    const p3 = await preview(SID, csv(`
Head,Amount,Vendor
Electricity,1000,MSEB
Nonsense Head,2000,
Electricity,abc,
Electricity,3000,Ghost Vendor
Electricity,4000,MSEB
`), { shape: 'PER_ROW' });
    eq('the good rows survive', p3.totals.create, 2);
    eq('...and only the bad ones fail', p3.totals.error, 3);
    ok('an unknown head names itself', p3.rows[1].message?.includes('Nonsense Head'), p3.rows[1].message);
    ok('a non-numeric amount names itself', p3.rows[2].message?.includes('abc'), p3.rows[2].message);
    ok('an unknown vendor names itself', p3.rows[3].message?.includes('Ghost Vendor'), p3.rows[3].message);
    eq('...and the total counts only what will post', p3.totalAmountPaise, 500_000);

    // Missing required columns is a whole-file problem, not a row problem.
    let noHead = '';
    try { await preview(SID, csv('Amount,Note\n100,x'), { shape: 'PER_ROW' }); }
    catch (e: any) { noHead = e.message; }
    ok('a file with no Head column is refused outright', noHead.includes('"Head"'), noHead);

    // ================================================ what preview promises, commit does
    console.log('\nCommit posts exactly what preview promised');
    const file = csv(`
Date,Head,Amount,Vendor,Block,Fund,Note
2026-07-31,Electricity,45000,MSEB,Tower A,,July bill
2026-07-31,Staff Payments,12000,,,,Gangaram
2026-07-31,Repairs & Maintenance,8000,,,Repair Fund,Pump
`);
    const promised = await preview(SID, file, { shape: 'ONE_VOUCHER' });
    const before = await bankBalance();
    const done = await commit(SID, file, { shape: 'ONE_VOUCHER', alreadyPaid: true, paymentMode: 'BANK' }, actor);

    eq('one voucher, as asked', done.vouchers, 1);
    eq('...with all three lines on it', done.lines, 3);
    eq('...for exactly the promised amount', done.totalAmountPaise, promised.totalAmountPaise);
    eq('...all of it paid', done.posted, 1);
    eq('...with nothing left pending', done.pending.length, 0);

    const after = await bankBalance();
    eq('the bank account fell by exactly that much', before - after, promised.totalAmountPaise);

    const posted = await Expense.findOne({ societyId, status: 'PAID' }).lean();
    eq('the voucher is PAID', posted?.status, 'PAID');
    eq('...and carries every line', posted?.lineItems.length, 3);
    ok('...the wing tag survived', posted?.lineItems.some(l => l.blockName === 'Tower A'));
    ok('...and so did the fund tag',
      posted?.lineItems.some(l => String(l.fundId) === String(repairFund._id)));
    eq('...the vendor was picked up from the row that named one', String(posted?.vendorId), String(mseb._id));

    // ==================================================== per-row shape
    console.log('\nPer-row shape makes separate vouchers');
    const perRow = await commit(SID, csv(`
Head,Amount,Note
Electricity,100,one
Water Expense,200,two
`), { shape: 'PER_ROW' }, actor);
    eq('two rows, two vouchers', perRow.vouchers, 2);
    eq('...each with one line', perRow.lines, 2);
    eq('...and they wait for approval by default', perRow.posted, 0);

    const awaiting = await Expense.countDocuments({ societyId, status: 'PENDING_APPROVAL' });
    eq('both sit in PENDING_APPROVAL — a spreadsheet does not skip the queue', awaiting, 2);

    // ============================================== the approval threshold still bites
    console.log('\nA spreadsheet cannot bypass separation of duties');
    const policy = await FinancePolicy.findOne({ societyId });
    policy!.approvals.expenseThresholdPaise = 100_000; // ₹1,000
    await policy!.save();

    const big = await commit(SID, csv('Head,Amount\nElectricity,5000'),
      { shape: 'PER_ROW', alreadyPaid: true, paymentMode: 'BANK' }, actor);
    eq('the voucher is still created', big.vouchers, 1);
    eq('...but not paid, because the same person cannot approve it', big.posted, 0);
    eq('...and it says so', big.pending.length, 1);
    ok('...naming the reason', Boolean(big.pending[0].reason), big.pending[0]?.reason);

    const stillPending = await Expense.findOne({ societyId, voucherNumber: big.pending[0].voucherNumber }).lean();
    eq('...leaving it awaiting approval, not half-posted', stillPending?.status, 'PENDING_APPROVAL');

    // The rule is creator ≠ approver, so whoever UPLOADS can never auto-pay
    // above the threshold — they are always the creator. That is correct, and
    // it means "mark as paid" is simply unavailable above the limit, for
    // everyone, always. Worth stating as a property rather than hoping a
    // different actor slips through.
    const secondPass = await commit(SID, csv('Head,Amount\nElectricity,5000'),
      { shape: 'PER_ROW', alreadyPaid: true, paymentMode: 'BANK' }, secondActor);
    eq('a different uploader cannot self-approve either — the rule is about two people', secondPass.posted, 0);

    const waiting = await Expense.findOne({ societyId, voucherNumber: secondPass.pending[0].voucherNumber }).lean();
    const approved = await approveExpense(SID, String(waiting!._id), actor);
    eq('...but a genuinely different officer can approve it', approved.status, 'APPROVED');

    // And the screen must say so BEFORE the upload, not after.
    const warned = await preview(SID, csv('Head,Amount\nElectricity,5000'),
      { shape: 'PER_ROW', alreadyPaid: true });
    ok('the preview warns that these will wait for a second officer',
      warned.approvalWarning?.includes('second officer'), warned.approvalWarning);
    const unwarned = await preview(SID, csv('Head,Amount\nElectricity,5'),
      { shape: 'PER_ROW', alreadyPaid: true });
    ok('...and stays quiet when nothing is over the limit', !unwarned.approvalWarning, unwarned.approvalWarning);

    policy!.approvals.expenseThresholdPaise = 0;
    await policy!.save();

    // ================================================================ duplicate warning
    console.log('\nA repeat of the same month is flagged, not blocked');
    const same = csv('Date,Head,Amount\n2026-07-31,Electricity,100');
    await commit(SID, same, { shape: 'ONE_VOUCHER' }, actor);
    const again = await preview(SID, same, { shape: 'ONE_VOUCHER' });
    ok('the duplicate is noticed', Boolean(again.duplicateWarning), 'no warning');
    ok('...and says what will happen', again.duplicateWarning?.includes('twice'), again.duplicateWarning);

    const twiceOver = await commit(SID, same, { shape: 'ONE_VOUCHER' }, actor);
    eq('...but it is a warning, not a block — a bonus is legitimate', twiceOver.vouchers, 1);

    // ============================================================== repeat last month
    console.log('\nRepeating last month needs no file at all');
    const rep = await repeatFrom(SID, String(posted!._id));
    eq('it brings back every line', rep.lines.length, 3);
    ok('...as names, not codes', rep.lines.some(l => l.head === 'Electricity'), JSON.stringify(rep.lines[0]));
    eq('...with the amounts intact', rep.lines.reduce((s, l) => s + l.amountPaise, 0), promised.totalAmountPaise);
    ok('...the wing survives', rep.lines.some(l => l.blockId));
    ok('...and the fund', rep.lines.some(l => l.fundId));
    ok('...every head is still valid', rep.lines.every(l => l.stillValid));

    // A head retired since should be flagged, not silently swapped or dropped.
    await LedgerAccount.updateOne({ societyId, code: ACCOUNT_CODES.BANK_SAVINGS }, { $set: { isActive: false } });
    await LedgerAccount.updateOne({ societyId, code: '5130' }, { $set: { isActive: false } });
    const repStale = await repeatFrom(SID, String((await Expense.findOne({ societyId, 'lineItems.expenseAccountCode': '5130' }).lean())!._id));
    ok('a head retired since last month is flagged, not dropped',
      repStale.lines.some(l => l.accountCode === '5130' && !l.stillValid));
    await LedgerAccount.updateOne({ societyId, code: '5130' }, { $set: { isActive: true } });

    // ==================================================================== the template
    console.log('\nThe template is filled in with this society\'s own heads');
    const buf = await templateFor(SID);
    ok('it is a real workbook', buf.length > 1000, `${buf.length} bytes`);

    // ================================================================== safety rails
    console.log('\nSafety rails');
    let empty = '';
    try { await commit(SID, csv('Head,Amount\nNonsense,100'), { shape: 'PER_ROW' }, actor); }
    catch (e: any) { empty = e.message; }
    ok('a file where every row is broken refuses to commit', empty.includes('every row'), empty);

    const negative = await preview(SID, csv('Head,Amount\nElectricity,-500'), { shape: 'PER_ROW' });
    eq('a negative amount is a row error, not a credit', negative.totals.error, 1);

    const huge = await preview(SID, csv('Head,Amount\nElectricity,99999999999999'), { shape: 'PER_ROW' });
    eq('an implausible amount is refused', huge.totals.error, 1);

    const messy = await preview(SID, csv('Head,Amount\nElectricity,"₹1,200.50"'), { shape: 'PER_ROW' });
    eq('rupee signs and commas are understood', messy.totalAmountPaise, 120_050);

    // Headers a real treasurer types.
    const loose = await preview(SID, csv('particulars,amount rs,payee\nElectricity,100,MSEB'), { shape: 'PER_ROW' });
    eq('loosely-named headers still map', loose.totals.create, 1);

    // ====================================================== the books still balance
    console.log('\nThe books balance after all of it');
    const all = await JournalEntry.find({ societyId }).lean();
    const dr = all.reduce((s, j: any) => s + j.lines.reduce((t: number, l: any) => t + (l.debitPaise || 0), 0), 0);
    const cr = all.reduce((s, j: any) => s + j.lines.reduce((t: number, l: any) => t + (l.creditPaise || 0), 0), 0);
    eq('every debit has its credit', dr, cr);

    console.log(`\n  (bank fell ${rupees(before - after)} on the main batch)`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
