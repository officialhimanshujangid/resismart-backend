/**
 * Phase C (bank reconciliation) verification — real database, THROWAWAY
 * societyId, cleans up after itself. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-c-bank.ts
 *
 * Proves the BRS an auditor actually leans on: that re-importing a statement is
 * a no-op, that auto-match pairs the obvious ones and refuses to spend a voucher
 * twice, that the arithmetic ties, and that a bank charge nobody has booked shows
 * up on the statement side rather than vanishing.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { BankStatementLine } from '../models/bank-statement-line.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { postJournal } from '../services/ledger.service';
import {
  importStatement, autoMatch, reconciliation, matchLine, unmatchLine, ignoreLine, bankAccounts,
} from '../services/bank-reconciliation.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

const BANK = '1100';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** Run an operation expected to fail, returning its message ('' when it wrongly succeeded). */
const refuses = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ''; } catch (e: any) { return e.message || 'error'; }
};

/** A date `n` days before today, at midday so day-boundary maths stays honest. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
};
const iso = (d: Date) => d.toISOString();

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    BankStatementLine.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);

    // ------------------------------------------------------ the picker
    console.log('Bank account picker');
    const accounts = await bankAccounts(SID);
    ok('the current account is offered', accounts.some(a => a.code === BANK), JSON.stringify(accounts.map(a => a.code)));
    ok('only cash & bank accounts are offered', accounts.every(a => ['1100', '1105', '1110', '1120'].includes(a.code)),
      JSON.stringify(accounts.map(a => a.code)));
    const notBank = await refuses(() => reconciliation(SID, { accountCode: '4100' }));
    ok('an income account cannot be reconciled', /not a bank or cash account/.test(notBank), notBank);

    // ------------------------------------------------------ the books
    // Four bank transactions the society has recorded. `daysAgo` keeps them all
    // inside the tolerance window of the statement rows built below.
    console.log('\nBooks');
    const maintenance = await postJournal(SID, {
      voucherType: 'RECEIPT', entryDate: daysAgo(20), narration: 'Maintenance receipt A-101',
      lines: [{ accountCode: BANK, debitPaise: 500_000 }, { accountCode: '4100', creditPaise: 500_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    const security = await postJournal(SID, {
      voucherType: 'PAYMENT', entryDate: daysAgo(18), narration: 'Security agency April',
      lines: [{ accountCode: '5100', debitPaise: 300_000 }, { accountCode: BANK, creditPaise: 300_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    // Dated two days before the bank shows it — inside the ±3-day window, so
    // auto-match must still find it.
    const lift = await postJournal(SID, {
      voucherType: 'PAYMENT', entryDate: daysAgo(12), narration: 'Lift AMC cheque 004417',
      lines: [{ accountCode: '5150', debitPaise: 250_000 }, { accountCode: BANK, creditPaise: 250_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    // A cheque the society has written that the payee has not yet banked: in the
    // books, never on the statement. The classic reconciling item.
    const unpresented = await postJournal(SID, {
      voucherType: 'PAYMENT', entryDate: daysAgo(2), narration: 'Painter advance cheque 004418',
      lines: [{ accountCode: '5140', debitPaise: 120_000 }, { accountCode: BANK, creditPaise: 120_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    ok('four bank vouchers are posted', [maintenance, security, lift, unpresented].every(j => !!j));

    // ------------------------------------------------------ import
    console.log('\nImport');
    // Mirrors the books, EXCEPT: no painter cheque (unpresented), plus a bank
    // charge nobody has booked. Note the direction flip — the society's receipt
    // is a CREDIT on the bank's statement.
    const statement = [
      { txnDate: iso(daysAgo(20)), description: 'NEFT CR MAINTENANCE A-101', refNo: 'UTR900001', creditPaise: 500_000 },
      { txnDate: iso(daysAgo(18)), description: 'NEFT DR SECURE GUARDS', refNo: 'UTR900002', debitPaise: 300_000 },
      { txnDate: iso(daysAgo(10)), description: 'CHQ 004417 LIFT AMC', refNo: '004417', debitPaise: 250_000 },
      { txnDate: iso(daysAgo(5)), description: 'BANK CHARGES QTRLY', refNo: '', debitPaise: 5_000 },
    ];
    const first = await importStatement(SID, { accountCode: BANK, lines: statement }, actor);
    eq('every row of a fresh statement is imported', first.imported, 4);
    eq('...and none is a duplicate', first.duplicates, 0);

    const second = await importStatement(SID, { accountCode: BANK, lines: statement }, actor);
    eq('re-importing the same file imports nothing', second.imported, 0);
    eq('...and reports every row as a duplicate', second.duplicates, 4);
    eq('...leaving the line count unchanged', await BankStatementLine.countDocuments({ societyId, accountCode: BANK }), 4);

    // Two identical ₹500 cash deposits on one day are two real transactions, not
    // one — `dedupeSeq` is what stops the unique index eating the second.
    const twins = [
      { txnDate: iso(daysAgo(9)), description: 'CASH DEP', refNo: '', creditPaise: 50_000 },
      { txnDate: iso(daysAgo(9)), description: 'CASH DEP', refNo: '', creditPaise: 50_000 },
    ];
    const twinsFirst = await importStatement(SID, { accountCode: BANK, lines: twins }, actor);
    eq('two identical transactions on one day are both kept', twinsFirst.imported, 2);
    const twinsAgain = await importStatement(SID, { accountCode: BANK, lines: twins }, actor);
    eq('...and re-importing them is still a no-op', twinsAgain.duplicates, 2);
    // Clear them again — they exist only to prove the index, and would otherwise
    // muddy the reconciling columns below.
    await BankStatementLine.deleteMany({ societyId, accountCode: BANK, description: 'CASH DEP' });

    const zeroRow = await refuses(() => importStatement(SID, {
      accountCode: BANK, lines: [{ txnDate: iso(daysAgo(1)), description: 'BALANCE C/F', debitPaise: 0, creditPaise: 0 }],
    }, actor));
    ok('a row that moves no money is rejected', /either money in or money out/.test(zeroRow), zeroRow);
    const badDate = await refuses(() => importStatement(SID, {
      accountCode: BANK, lines: [{ txnDate: 'not-a-date', description: 'X', creditPaise: 100 }],
    }, actor));
    ok('an unparseable date is rejected, naming the row', /row 1/.test(badDate), badDate);

    // ------------------------------------------------------ auto-match
    console.log('\nAuto-match');
    const am = await autoMatch(SID, BANK, actor);
    eq('the three obvious pairs are matched', am.matched, 3);
    eq('only the unbooked bank charge is left on the statement', am.unmatchedLines, 1);
    eq('only the unpresented cheque is left in the books', am.unmatchedBookEntries, 1);

    const liftLine = await BankStatementLine.findOne({ societyId, refNo: '004417' });
    eq('a voucher dated two days off the bank still matches', String(liftLine?.matchedJournalEntryId), String(lift._id));
    const chargeLine = await BankStatementLine.findOne({ societyId, description: /BANK CHARGES/ });
    eq('the bank charge stays unmatched', chargeLine?.status, 'UNMATCHED');

    const again = await autoMatch(SID, BANK, actor);
    eq('running auto-match again matches nothing new', again.matched, 0);

    // ------------------------------------------------------ no double-spending a voucher
    console.log('\nA voucher is spent once');
    const doubled = await refuses(() => matchLine(SID, String(chargeLine!._id), String(maintenance._id), actor));
    ok('a voucher already matched cannot be matched to a second line', !!doubled, doubled);
    eq('...and the line it would have claimed is untouched',
      (await BankStatementLine.findById(chargeLine!._id))?.status, 'UNMATCHED');
    // The database, not just the service, is the arbiter — auto-match and a hand
    // match can race, and a double-claimed voucher would be counted twice.
    const indexRefused = await refuses(() => BankStatementLine.create({
      societyId, accountCode: BANK, txnDate: daysAgo(1), description: 'FORGED', refNo: 'X',
      debitPaise: 1, creditPaise: 0, importBatchId: new mongoose.Types.ObjectId(), dedupeSeq: 0,
      status: 'MATCHED', matchedJournalEntryId: maintenance._id,
    }));
    ok('the unique index refuses a second claim on the same voucher', /E11000|duplicate key/i.test(indexRefused), indexRefused);

    // ------------------------------------------------------ the BRS
    console.log('\nReconciliation');
    const r = await reconciliation(SID, { accountCode: BANK });
    // Books: +500,000 −300,000 −250,000 −120,000 = −170,000
    eq('the book balance is what the ledger says', r.bookBalancePaise, -170_000);
    // Bank: +500,000 −300,000 −250,000 −5,000 = −55,000
    eq('the statement balance is what the bank says', r.statementBalancePaise, -55_000);

    eq('the unpresented cheque is the only item in the books, not on the statement', r.unmatchedInBooks.length, 1);
    eq('...and it is the painter cheque', r.unmatchedInBooks[0].voucherNumber, unpresented.voucherNumber);
    eq('...worth ₹1,200 out', r.unmatchedInBooks[0].netPaise, -120_000);

    eq('the bank charge is the only item on the statement, not in the books', r.unmatchedOnStatement.length, 1);
    ok('...and it is the charge', /BANK CHARGES/.test(r.unmatchedOnStatement[0].description), r.unmatchedOnStatement[0].description);
    eq('...worth ₹50 out', r.unmatchedOnStatement[0].netPaise, -5_000);

    // The proof: book balance, less what the bank has not seen, plus what the
    // books have not booked, IS the bank's balance.
    eq('book balance − books-only + statement-only equals the statement balance',
      r.bookBalancePaise - r.booksOnlyNetPaise + r.statementOnlyNetPaise, r.statementBalancePaise);
    eq('the reconciliation reports no difference', r.differencePaise, 0);
    eq('...and says so', r.reconciled, true);
    eq('counts add up', r.counts.matched + r.counts.unmatched + r.counts.ignored, r.counts.statementLines);

    // ------------------------------------------------------ the cut-off
    // A pair that straddles the cut-off is NOT settled at the cut-off: the lift
    // cheque is in the books on day −12 but only on the bank on day −10, so at a
    // day −11 cut-off it must appear as a reconciling item, and the arithmetic
    // must still tie.
    console.log('\nCut-off dates');
    const mid = await reconciliation(SID, { accountCode: BANK, asOf: iso(daysAgo(11)) });
    ok('a cheque cleared after the cut-off is still a reconciling item',
      mid.unmatchedInBooks.some(i => i.voucherNumber === lift.voucherNumber),
      JSON.stringify(mid.unmatchedInBooks.map(i => i.voucherNumber)));
    eq('...and the arithmetic still ties at that cut-off',
      mid.bookBalancePaise - mid.booksOnlyNetPaise + mid.statementOnlyNetPaise, mid.statementBalancePaise);
    eq('...with no difference', mid.differencePaise, 0);
    ok('nothing dated after the cut-off leaks in', mid.unmatchedOnStatement.every(i => new Date(i.txnDate) <= daysAgo(11)));

    // ------------------------------------------------------ manual override
    console.log('\nManual match, unmatch, ignore');
    const mismatch = await refuses(() => matchLine(SID, String(chargeLine!._id), String(unpresented._id), actor));
    ok('a hand match on unequal amounts is refused', /Amounts differ/.test(mismatch), mismatch);
    const wrongAccount = await refuses(async () => {
      const je = await postJournal(SID, {
        voucherType: 'JOURNAL', entryDate: daysAgo(5), narration: 'verify: nothing to do with the bank',
        lines: [{ accountCode: '5170', debitPaise: 5_000 }, { accountCode: '1110', creditPaise: 5_000 }],
        postedBy: actor.userId, postedByName: actor.userName,
      });
      return matchLine(SID, String(chargeLine!._id), String(je._id), actor);
    });
    ok('a voucher that never touches this account is refused', /does not touch/.test(wrongAccount), wrongAccount);

    // Book the charge properly, then tie it by hand.
    const chargeJe = await postJournal(SID, {
      voucherType: 'PAYMENT', entryDate: daysAgo(5), narration: 'Quarterly bank charges',
      lines: [{ accountCode: '5180', debitPaise: 5_000 }, { accountCode: BANK, creditPaise: 5_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    const handMatched = await matchLine(SID, String(chargeLine!._id), String(chargeJe._id), actor);
    eq('a hand match on equal amounts is accepted', handMatched.status, 'MATCHED');
    eq('...and records who did it', handMatched.matchedByName, actor.userName);

    const afterHand = await reconciliation(SID, { accountCode: BANK });
    eq('booking the charge removes it from the statement column', afterHand.unmatchedOnStatement.length, 0);
    eq('...and the book balance drops by the charge', afterHand.bookBalancePaise, -175_000);
    eq('...and the arithmetic still ties',
      afterHand.bookBalancePaise - afterHand.booksOnlyNetPaise + afterHand.statementOnlyNetPaise,
      afterHand.statementBalancePaise);

    const unmatched = await unmatchLine(SID, String(chargeLine!._id), actor);
    eq('a match can be undone', unmatched.status, 'UNMATCHED');
    eq('...clearing the voucher link', unmatched.matchedJournalEntryId, undefined);
    // `$unset`, not null: the sparse unique index still indexes nulls, so a second
    // unmatched line would collide. Prove two can coexist.
    await unmatchLine(SID, String(liftLine!._id), actor);
    eq('...and two lines can be unmatched at once',
      await BankStatementLine.countDocuments({ societyId, accountCode: BANK, status: 'UNMATCHED' }), 2);
    await matchLine(SID, String(liftLine!._id), String(lift._id), actor);

    const ignored = await ignoreLine(SID, String(chargeLine!._id), actor);
    eq('an unmatched line can be ignored', ignored.status, 'IGNORED');
    const afterIgnore = await reconciliation(SID, { accountCode: BANK });
    eq('an ignored line leaves the statement balance', afterIgnore.statementBalancePaise, -50_000);
    eq('...and both reconciling columns', afterIgnore.unmatchedOnStatement.length, 0);
    eq('...and is counted as ignored', afterIgnore.counts.ignored, 1);
    // The charge voucher is now in the books with nothing on the bank to meet it,
    // so it joins the books-only column — and the sum must still tie.
    eq('...while its voucher becomes a books-only item', afterIgnore.unmatchedInBooks.length, 2);
    eq('...and the arithmetic ties even so',
      afterIgnore.bookBalancePaise - afterIgnore.booksOnlyNetPaise + afterIgnore.statementOnlyNetPaise,
      afterIgnore.statementBalancePaise);
    eq('...with no difference', afterIgnore.differencePaise, 0);

    const ignoreMatched = await refuses(() => ignoreLine(SID, String(liftLine!._id), actor));
    ok('a matched line cannot be ignored without unmatching it', /Unmatch this line/.test(ignoreMatched), ignoreMatched);

    // ------------------------------------------------------ FE⇄BE contract
    // The page consumes this payload as `any`, so a renamed field would surface as
    // a blank column in front of a treasurer, not as a compile error.
    console.log('\nFrontend contract');
    const has = (o: any, path: string) => path.split('.').every((p, i, a) => {
      const v = a.slice(0, i + 1).reduce((x: any, k) => x?.[k], o);
      return v !== undefined;
    });
    const paths = [
      'accountCode', 'accountName', 'asOf', 'bookBalancePaise', 'statementBalancePaise',
      'unmatchedInBooks', 'unmatchedOnStatement', 'booksOnlyNetPaise', 'statementOnlyNetPaise',
      'differencePaise', 'reconciled', 'counts.statementLines', 'counts.matched', 'counts.unmatched',
      'counts.ignored', 'counts.bookEntries',
    ];
    const missing = paths.filter(p => !has(afterIgnore, p));
    ok('the reconciliation returns every field the page reads', missing.length === 0, `missing: ${missing.join(', ')}`);
    ok('books-only rows carry what the column renders', afterIgnore.unmatchedInBooks.every((i: any) =>
      i.journalEntryId !== undefined && i.voucherNumber !== undefined && i.entryDate !== undefined && i.netPaise !== undefined));
    ok('statement rows carry what the column renders', afterIgnore.counts.unmatched === 0
      || afterIgnore.unmatchedOnStatement.every((i: any) =>
        i._id !== undefined && i.txnDate !== undefined && i.description !== undefined && i.netPaise !== undefined));
    ok('the picker returns what the dropdown reads', accounts.every(a => !!a.code && !!a.name && !!a.accountId));
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
