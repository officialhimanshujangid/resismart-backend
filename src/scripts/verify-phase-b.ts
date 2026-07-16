/**
 * Phase B (reports) verification — real database, THROWAWAY societyId, cleans up
 * after itself. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-b.ts
 *
 * Proves the rebuilt reporting surface: aging buckets, a filable GST register,
 * a deductee-wise TDS register, drill-down that reconciles to the statements,
 * and exports that are really PDF/XLSX.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { PassThrough } from 'stream';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Receipt } from '../models/receipt.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { createExpense, approveExpense } from '../services/expenses.service';
import { postJournal } from '../services/ledger.service';
import {
  defaulters, gstRegister, tdsRegister, accountLedger, availableFinancialYears, trialBalance, incomeExpenditure,
} from '../services/reports.service';
import { buildExportDoc, REPORT_TITLES } from '../services/report-doc.builder';
import { sendPdf, sendXlsx } from '../services/report-export.service';
import { financeDashboard } from '../services/finance-dashboard.service';
import * as coa from '../services/chart-of-accounts.service';
import { AccountError } from '../services/chart-of-accounts.service';

const societyId = new mongoose.Types.ObjectId();
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

/** Render an export to a buffer through a stand-in for the Express response. */
function render(fn: (res: any) => void | Promise<void>): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const chunks: Buffer[] = [];
    const res: any = new PassThrough();
    res.setHeader = () => {};
    res.status = () => res;
    res.json = () => res;
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    try { await fn(res); } catch (e) { reject(e); }
  });
}

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), FinancePolicy.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }), MaintenanceInvoice.deleteMany({ societyId }),
    Expense.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    Receipt.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = true;
    policy.gst.defaultRatePercent = 18;
    // Switch the ₹7,500 RWA exemption off: these flats are billed ₹1,000 a month,
    // which is exempt, and this suite is testing the GST *register*, not the
    // exemption. The exemption itself is covered by verify-phase-c.
    policy.gst.rwaExemptionPerMemberPaise = 0;
    policy.billing.dueDays = 0; // bill due the day it's raised, so aging is predictable
    await policy.save();

    const blockId = new mongoose.Types.ObjectId();
    const flats = await Flat.create([1, 2, 3].map(n => ({
      number: `10${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));

    await createChargeHead(SID, {
      code: 'MAINT', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM',
      uniformAmountPaise: 100_000, gstApplicable: true, gstRatePercent: 18, sacCode: '9995',
    }, actor);

    // Three periods of increasing age so every aging bucket is exercised.
    const today = new Date();
    const monthsAgo = (n: number) => {
      const d = new Date(today.getFullYear(), today.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    for (const n of [0, 2, 4]) {
      const period = monthsAgo(n);
      await generateInvoicesForSociety(SID, { period, triggeredByUserId: actor.userId, triggeredByName: actor.userName });
      // `generateInvoicesForSociety` always stamps invoiceDate/dueDate as *now*,
      // whatever period it bills. In production the monthly cron runs inside the
      // period so that's right; here every run is today, so back-date to the
      // period to reproduce what a real society's data actually looks like.
      const [py, pm] = period.split('-').map(Number);
      const raised = new Date(py, pm - 1, 1);
      await MaintenanceInvoice.updateMany(
        { societyId, billingPeriod: period },
        { $set: { invoiceDate: raised, dueDate: raised } },
      );
    }

    // ------------------------------------------------------ aging
    console.log('Defaulter register — aging');
    const def = await defaulters(SID);
    const bucketSum = def.buckets.current + def.buckets.d31_60 + def.buckets.d61_90 + def.buckets.d90plus;
    eq('aging buckets sum to the outstanding total', bucketSum, def.totalPaise);
    eq('every flat appears', def.rows.length, flats.length);
    ok('the oldest bills land beyond 60 days', def.buckets.d61_90 + def.buckets.d90plus > 0,
      JSON.stringify(def.buckets));
    ok('the newest bill is in the current bucket', def.buckets.current > 0, JSON.stringify(def.buckets));
    const perFlat = def.rows[0];
    eq('a flat row foots to its own buckets',
      perFlat.buckets.current + perFlat.buckets.d31_60 + perFlat.buckets.d61_90 + perFlat.buckets.d90plus,
      perFlat.outstandingPaise);

    // ------------------------------------------------------ GST
    console.log('\nGST register');
    const gst = await gstRegister(SID);
    ok('GST is grouped by month, not one row per year', gst.months.length >= 2, `${gst.months.length} month bucket(s)`);
    eq('month buckets sum to the GST total', gst.months.reduce((s, m) => s + m.gstPaise, 0), gst.totalGstPaise);
    eq('invoice rows sum to the GST total', gst.rows.reduce((s, r) => s + r.gstPaise, 0), gst.totalGstPaise);
    eq('CGST + SGST equals total GST', gst.rows.reduce((s, r) => s + r.cgstPaise + r.sgstPaise, 0), gst.totalGstPaise);
    eq('18% of the taxable value is the GST charged', Math.round(gst.totalTaxableValuePaise * 0.18), gst.totalGstPaise);
    ok('rows carry what a return needs (invoice no, SAC, rate)',
      gst.rows.every(r => !!r.invoiceNumber && !!r.sacCode && r.ratePercent === 18));
    // The GST register must agree with the ledger's GST-Output liability.
    const tb = await trialBalance(SID);
    eq('GST register ties to the GST Output ledger account',
      gst.totalGstPaise, tb.rows.find(r => r.code === '2300')?.creditPaise);

    // ------------------------------------------------------ TDS
    console.log('\nTDS register');
    const vendorWithPan = await Vendor.create({
      societyId, name: 'Lift AMC Pvt Ltd', pan: 'AAACL1234C', tdsApplicable: true,
      tdsSection: '194C', tdsRatePercent: 2,
      // Thresholds off: these are ₹1,000 bills, which sit under the real 194C
      // limits. This suite tests the TDS *register*; the thresholds themselves
      // are covered by verify-phase-c.
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 0,
      createdBy: userId, createdByName: actor.userName,
    });
    const vendorNoPan = await Vendor.create({
      societyId, name: 'Painter Co', tdsApplicable: true, tdsSection: '194C', tdsRatePercent: 2,
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 0, // see above
      createdBy: userId, createdByName: actor.userName,
    });
    for (const v of [vendorWithPan, vendorNoPan]) {
      const e = await createExpense(SID, {
        vendorId: String(v._id), expenseDate: new Date(),
        lineItems: [{ expenseAccountCode: '5150', amountPaise: 100_000, description: 'AMC' }],
      }, actor);
      await approveExpense(SID, String(e._id), { userId: new mongoose.Types.ObjectId().toString(), userName: 'Approver' });
    }
    const tds = await tdsRegister(SID);
    eq('TDS is per deductee, not one scalar', tds.deductees.length, 2);
    eq('2% of ₹2,000 gross is deducted', tds.totalTdsPaise, 4_000);
    eq('deductee totals sum to the TDS total', tds.deductees.reduce((s, d) => s + d.tdsPaise, 0), tds.totalTdsPaise);
    eq('quarter totals sum to the TDS total', tds.quarters.reduce((s, q) => s + q.tdsPaise, 0), tds.totalTdsPaise);
    ok('rows carry PAN and section for Form 26Q', tds.deductees.some(d => d.pan === 'AAACL1234C' && d.section === '194C'));
    eq('a deductee with no PAN is flagged', tds.missingPan.includes('Painter Co'), true);
    const tb2 = await trialBalance(SID);
    eq('TDS register ties to the TDS Payable ledger account',
      tds.totalTdsPaise, tb2.rows.find(r => r.code === '2310')?.creditPaise);

    // ------------------------------------------------------ drill-down
    console.log('\nDrill-down');
    const led = await accountLedger(SID, { code: '1200' });
    eq('the debtors ledger closes at the trial-balance figure',
      led.closingPaise, tb2.rows.find(r => r.code === '1200')?.debitPaise);
    eq('every voucher behind the figure is listed', led.rows.length, flats.length * 3);
    ok('rows carry a running balance', led.rows[led.rows.length - 1].balancePaise === led.closingPaise);
    ok('each row names its voucher', led.rows.every(r => !!r.voucherNumber));
    let bad = false;
    try { await accountLedger(SID, { code: '9999' }); } catch { bad = true; }
    ok('an unknown account code is rejected', bad);

    // ------------------------------------------------------ FY picker
    console.log('\nFinancial years');
    const fys = await availableFinancialYears(SID, 4);
    ok('the current FY is offered', fys.financialYears.some(f => f.fy === fys.current));
    ok('FYs are newest-first', fys.financialYears.every((f, i, a) => i === 0 || a[i - 1].fy >= f.fy));
    ok('each FY carries a real date range the client can use',
      fys.financialYears.every(f => !!f.from && !!f.to && new Date(f.from) < new Date(f.to)));
    const cur = fys.financialYears.find(f => f.fy === fys.current)!;
    eq('the FY range starts on the society’s FY start month', new Date(cur.from).getMonth() + 1, 4);

    // ------------------------------------------------------ exports
    console.log('\nExports');
    const ie = await incomeExpenditure(SID, { fy: undefined });
    for (const [key, data] of Object.entries({
      'trial-balance': tb2, 'income-expenditure': ie, defaulters: def, 'gst-register': gst, 'tds-register': tds,
    })) {
      const doc = buildExportDoc(key, data, 'Sunrise CHS');
      const pdf = await render(res => sendPdf(res, doc));
      ok(`${REPORT_TITLES[key]} → a real PDF`, pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 800,
        `${pdf.length} bytes, magic ${JSON.stringify(pdf.subarray(0, 4).toString())}`);
      const xlsx = await render(res => sendXlsx(res, doc));
      ok(`${REPORT_TITLES[key]} → a real XLSX`, xlsx.subarray(0, 2).toString() === 'PK' && xlsx.length > 2000,
        `${xlsx.length} bytes, magic ${JSON.stringify(xlsx.subarray(0, 2).toString())}`);
    }
    let badKey = false;
    try { buildExportDoc('nope', {}, 'X'); } catch { badKey = true; }
    ok('an unknown report key is rejected by the export builder', badKey);

    // ------------------------------------------------------ FE⇄BE contract
    // The reports page consumes these payloads as `any`, so TypeScript cannot
    // catch a renamed field — it would surface as a blank column or a crash in
    // front of the user. Assert the exact keys the page reads.
    console.log('\nFrontend contract');
    const has = (o: any, path: string) => path.split('.').every((p, i, a) => {
      const v = a.slice(0, i + 1).reduce((x: any, k) => x?.[k], o);
      return v !== undefined;
    });
    const contract: Record<string, { data: any; paths: string[] }> = {
      'income-expenditure': {
        data: ie,
        paths: ['period.financialYear', 'period.previousFinancialYear', 'income', 'expenses',
          'totalIncomePaise', 'totalExpensePaise', 'surplusPaise', 'previousTotalIncomePaise', 'previousTotalExpensePaise'],
      },
      'balance-sheet': {
        data: await (await import('../services/reports.service')).balanceSheet(SID, {}),
        paths: ['asOf', 'financialYear', 'assets', 'liabilities', 'funds', 'equity',
          'accumulatedSurplusPaise', 'currentSurplusPaise', 'assetsTotalPaise',
          'liabilitiesPlusFundsPlusEquityPaise', 'balanced', 'differencePaise',
          'previous.financialYear', 'previous.assetsTotalPaise', 'previous.liabilitiesPlusFundsPlusEquityPaise'],
      },
      'trial-balance': { data: tb2, paths: ['rows', 'totalDebitPaise', 'totalCreditPaise', 'balanced', 'drift', 'driftTotalPaise'] },
      defaulters: { data: def, paths: ['asOf', 'rows', 'totalPaise', 'buckets.current', 'buckets.d31_60', 'buckets.d61_90', 'buckets.d90plus'] },
      'gst-register': { data: gst, paths: ['months', 'rows', 'totalTaxableValuePaise', 'totalGstPaise'] },
      'tds-register': { data: tds, paths: ['rows', 'deductees', 'quarters', 'totalGrossPaise', 'totalTdsPaise', 'deductions', 'missingPan'] },
    };
    for (const [k, { data, paths }] of Object.entries(contract)) {
      const missing = paths.filter(p => !has(data, p));
      ok(`${k} returns every field the page reads`, missing.length === 0, `missing: ${missing.join(', ')}`);
    }
    // Row-level keys the tables index into.
    ok('I&E rows carry code/name/amount/previous', ie.income.every((r: any) =>
      r.code !== undefined && r.name !== undefined && r.amountPaise !== undefined && r.previousAmountPaise !== undefined));
    ok('defaulter rows carry flat, owner, oldestDue and buckets', def.rows.every((r: any) =>
      r.flatNumber !== undefined && r.blockName !== undefined && r.oldestDue !== undefined && r.buckets !== undefined));
    ok('drift rows carry the fields the badge renders', (tb2.drift as any[]).every(d =>
      d.code !== undefined && d.cachedBalancePaise !== undefined && d.ledgerBalancePaise !== undefined && d.driftPaise !== undefined));

    // ------------------------------------------------------ dashboard
    console.log('\nFinance dashboard');
    const dash = await financeDashboard(SID, 4);
    eq('outstanding matches the defaulter register', dash.outstandingPaise, def.totalPaise);
    eq('aging matches the defaulter register', JSON.stringify(dash.aging), JSON.stringify(def.buckets));
    ok('billed is non-zero after three billing runs', dash.billedPaise > 0);
    eq('nothing collected yet, so efficiency is 0%', dash.collectionEfficiencyPercent, 0);
    // Both expenses were approved by the TDS block above, so nothing is pending.
    eq('no expenses await approval once approved', dash.pending.expenses, 0);
    ok('top defaulters is capped at five', dash.topDefaulters.length <= 5);
    eq('setup sees the charge head', dash.setup.chargeHeads > 0, true);
    eq('setup knows no opening balance was posted', dash.setup.openingPosted, false);
    eq('setup sees the invoices raised', dash.setup.invoicesGenerated > 0, true);
    // Efficiency must be null (not 0) when nothing is billed — 0% would read as a failure.
    const emptySid = new mongoose.Types.ObjectId().toString();
    const emptyDash = await financeDashboard(emptySid, 4);
    eq('a society that has billed nothing reports null, not 0%', emptyDash.collectionEfficiencyPercent, null);

    // ------------------------------------------------------ chart of accounts
    console.log('\nChart of accounts');
    /** Run an operation expected to fail, returning the AccountError. */
    const refuses = async (fn: () => Promise<unknown>): Promise<AccountError | null> => {
      try { await fn(); return null; } catch (e: any) { return e; }
    };

    const made = await coa.createAccount(SID, { code: '5200', name: 'Garden Maintenance', type: 'EXPENSE' }, actor);
    eq('a new expense account is created', made.code, '5200');
    eq('...with the normal balance derived from its type', made.normalBalance, 'DEBIT');
    eq('...and is not a system account', made.isSystem, false);

    const dup = await refuses(() => coa.createAccount(SID, { code: '5200', name: 'Duplicate', type: 'EXPENSE' }, actor));
    eq('a duplicate code is rejected as a conflict', dup?.status, 409);

    const seeded = await LedgerAccount.findOne({ societyId, code: '1100' });
    const sysDel = await refuses(() => coa.deleteAccount(SID, String(seeded!._id)));
    ok('a system account cannot be deleted', /system account/i.test(sysDel?.message || ''), sysDel?.message);
    const sysOff = await refuses(() => coa.updateAccount(SID, String(seeded!._id), { isActive: false }));
    ok('a system account cannot be deactivated', /system account/i.test(sysOff?.message || ''), sysOff?.message);

    // Must be a NON-system account, or the isSystem guard fires first and the
    // has-history guard is never actually exercised.
    const withHistory = await coa.createAccount(SID, { code: '5210', name: 'Borewell Repair', type: 'EXPENSE' }, actor);
    await postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(), narration: 'verify: use the account',
      lines: [{ accountCode: '5210', debitPaise: 1_000 }, { accountCode: '1110', creditPaise: 1_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    const usedDel = await refuses(() => coa.deleteAccount(SID, String(withHistory._id)));
    ok('an account with posted entries cannot be deleted', /posted entr/i.test(usedDel?.message || ''), usedDel?.message);
    const off = await coa.updateAccount(SID, String(withHistory._id), { isActive: false });
    eq('...but it can be deactivated instead', off.isActive, false);

    const renamed = await coa.updateAccount(SID, String(made._id), { name: 'Garden & Landscaping' });
    eq('an account can be renamed', renamed.name, 'Garden & Landscaping');
    eq('...without its code changing', renamed.code, '5200');

    const del = await coa.deleteAccount(SID, String(made._id));
    eq('an unused account can be deleted', del.deleted, true);
    eq('...and is really gone', await LedgerAccount.countDocuments({ societyId, code: '5200' }), 0);
  } catch (e: any) {
    fail++;
    console.log(`\n  ERROR  ${e.message}\n${e.stack}`);
  } finally {
    await cleanup();
    console.log('\nThrowaway data removed.');
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  process.exit(fail ? 1 : 0);
}

main();
