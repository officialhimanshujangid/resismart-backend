/**
 * Phase 5 — society staff, their wings, and what the agency actually bills for.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertions:
 *
 *   1. Routing walks primary → backup → society-wide and returns NULL rather
 *      than guessing. A complaint quietly handed to the wrong person is worse
 *      than one visibly handed to nobody, because the second gets noticed.
 *   2. `staffId` on an expense line ties back to the ledger. This field was
 *      deliberately held out of Phase 2 until the staff model existed, so it
 *      has to prove it is genuinely read and not just declared.
 *
 *   npx ts-node src/scripts/verify-staff.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { AccessRole } from '../models/access-role.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { Expense } from '../models/expense.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { UserRole } from '../constants/roles';
import { seedChartOfAccounts, ACCOUNT_CODES } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { completeSetup } from '../services/finance-setup.service';
import { createExpense, approveExpense, payExpense } from '../services/expenses.service';
import { listRoles, resolveAccess, deleteRole } from '../services/access-role.service';
import {
  createStaff, updateStaff, endEmployment, listStaff, getStaff,
  assign, unassign, findAssignee, findExpiringVerifications, agencyHeadcount, StaffError,
} from '../services/staff.service';
import * as bulkExpense from '../services/bulk-expense.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const guardUserId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Verifier' };
const SID = societyId.toString();
const OTHER = otherId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

const audit = (sid: mongoose.Types.ObjectId) => ({
  societyId: sid,
  createdBy: adminId, createdByName: actor.userName,
  updatedBy: adminId, updatedByName: actor.userName,
});

async function cleanup() {
  for (const s of [societyId, otherId]) {
    await Promise.all([
      SocietyStaff.deleteMany({ societyId: s }), StaffAssignment.deleteMany({ societyId: s }),
      AccessRole.deleteMany({ societyId: s }), Block.deleteMany({ societyId: s }),
      Vendor.deleteMany({ societyId: s }), Expense.deleteMany({ societyId: s }),
      LedgerAccount.deleteMany({ societyId: s }), JournalEntry.deleteMany({ societyId: s }),
      FinancePolicy.deleteMany({ societyId: s }), SequenceCounter.deleteMany({ societyId: s }),
    ]);
  }
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);
    await completeSetup(SID, actor.userId, actor.userName, {
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 10_000_000 }],
      declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });

    const [wingA, wingB, wingC] = await Block.create([
      { ...audit(societyId), name: 'A Wing' },
      { ...audit(societyId), name: 'B Wing' },
      { ...audit(societyId), name: 'C Wing' },
    ]);
    const agency = await Vendor.create({
      ...audit(societyId), name: 'SecureCo', phone: '9000000001', isActive: true,
    });

    // ================================================================= hiring
    console.log('Taking somebody on');
    const mali = await createStaff(SID, {
      name: 'Gangaram', phone: '9800000001', designation: 'GARDENER', employmentType: 'DIRECT',
    }, actor);
    ok('a staff code is allocated', /^SF\/\d{4}$/.test(mali.staffCode), mali.staffCode);
    eq('...they are active', mali.isActive, true);
    ok('...and carry NO salary field — payroll is not this software\'s job',
      !('salary' in (mali.toObject() as any)) && !('monthlyPaise' in (mali.toObject() as any)));
    ok('...nor an Aadhaar field, which cannot lawfully be demanded',
      !JSON.stringify(mali.toObject()).toLowerCase().includes('aadhaar'));

    const plumber = await createStaff(SID, {
      name: 'Vijay', phone: '9800000002', designation: 'PLUMBER', employmentType: 'CONTRACT',
    }, actor);
    const guard = await createStaff(SID, {
      name: 'Ramesh', phone: '9800000003', designation: 'SECURITY_GUARD',
      employmentType: 'AGENCY', vendorId: String(agency._id),
    }, actor);
    eq('an agency guard records who supplies them', guard.vendorName, 'SecureCo');
    ok('...and codes do not collide', new Set([mali.staffCode, plumber.staffCode, guard.staffCode]).size === 3);

    let noAgency = '';
    try { await createStaff(SID, { name: 'X', phone: '1', designation: 'HOUSEKEEPING', employmentType: 'AGENCY' }, actor); }
    catch (e: any) { noAgency = e.message; }
    ok('an agency post with no agency is refused', noAgency.includes('Which agency'), noAgency);

    let strangerAgency = '';
    const theirVendor = await Vendor.create({ ...audit(otherId), name: 'Someone Else', phone: '9', isActive: true });
    try {
      await createStaff(SID, {
        name: 'Y', phone: '1', designation: 'HOUSEKEEPING',
        employmentType: 'AGENCY', vendorId: String(theirVendor._id),
      }, actor);
    } catch (e: any) { strangerAgency = e.message; }
    ok('an agency from another society is refused', strangerAgency.includes('unknown to this society'), strangerAgency);

    // ============================================================== assignment
    console.log('\nWho covers which wing, for what');
    await assign(SID, { staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wingA._id), categories: ['PLUMBING'], rank: 'PRIMARY' }, actor);
    await assign(SID, { staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wingB._id), categories: ['PLUMBING'], rank: 'PRIMARY' }, actor);
    await assign(SID, { staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wingC._id), categories: ['PLUMBING'], rank: 'BACKUP' }, actor);
    await assign(SID, { staffId: String(mali._id), scope: 'SOCIETY', categories: ['GARDEN'], rank: 'PRIMARY' }, actor);

    const detail = await getStaff(SID, String(plumber._id));
    eq('one person can hold several assignments', detail.assignments.length, 3);

    let noCategory = '';
    try { await assign(SID, { staffId: String(mali._id), scope: 'SOCIETY', categories: [] }, actor); }
    catch (e: any) { noCategory = e.message; }
    ok('an assignment with no kind of work is refused', noCategory.includes('kind of work'), noCategory);

    let strangerWing = '';
    const theirWing = await Block.create({ ...audit(otherId), name: 'Their Wing' });
    try {
      await assign(SID, { staffId: String(mali._id), scope: 'BLOCK', blockId: String(theirWing._id), categories: ['GARDEN'] }, actor);
    } catch (e: any) { strangerWing = e.message; }
    ok('a wing from another society is refused', strangerWing.includes('does not belong'), strangerWing);

    // ============================================ THE routing assertion
    console.log('\nWork reaches the right person, or visibly nobody');
    const inA = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    eq('A wing plumbing finds the primary', inA?.staffName, 'Vijay');
    eq('...as a primary', inA?.via, 'BLOCK_PRIMARY');

    const inC = await findAssignee(SID, 'PLUMBING', String(wingC._id));
    eq('C wing falls through to the backup', inC?.via, 'BLOCK_BACKUP');
    eq('...still reaching somebody', inC?.staffName, 'Vijay');

    const garden = await findAssignee(SID, 'GARDEN', String(wingC._id));
    eq('garden work in any wing reaches the society-wide gardener', garden?.via, 'SOCIETY_WIDE');
    eq('...by name', garden?.staffName, 'Gangaram');

    const nobody = await findAssignee(SID, 'LIFT', String(wingA._id));
    ok('lift work reaches NOBODY rather than a plausible guess', nobody === null, JSON.stringify(nobody));

    const noWing = await findAssignee(SID, 'PLUMBING', null);
    eq('society-wide plumbing with no wing still resolves', noWing === null, true);

    // ===================================================== leaving ends the work
    console.log('\nLeaving takes the assignments with it');
    await endEmployment(SID, String(plumber._id), new Date(), actor);
    const after = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    ok('a departed plumber is no longer sent work', after === null, JSON.stringify(after));

    const gone = await SocietyStaff.findById(plumber._id).lean();
    ok('...but the record survives, because their name is on old history', Boolean(gone));
    eq('...marked inactive, not deleted', gone?.isActive, false);
    ok('...with the date they left', Boolean(gone?.leftOn));

    const stale = await StaffAssignment.countDocuments({ staffId: plumber._id, isActive: true });
    eq('...and no assignment is left pointing at them', stale, 0);

    let twice = '';
    try { await endEmployment(SID, String(plumber._id), new Date(), actor); }
    catch (e: any) { twice = e.message; }
    ok('ending it twice is refused', twice.includes('already left'), twice);

    // An assignment whose person is gone must not resurrect them. Force a stale
    // row back to active to prove the routing double-checks employment.
    await StaffAssignment.updateOne(
      { staffId: plumber._id, blockId: wingA._id }, { $set: { isActive: true } },
    );
    const zombie = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    ok('a stale assignment cannot resurrect somebody who has left', zombie === null, JSON.stringify(zombie));

    // ================================================== police verification
    console.log('\nVerifications that have lapsed, or are about to');
    const soon = await createStaff(SID, {
      name: 'Expiring Soon', phone: '9800000009', designation: 'HOUSEKEEPING',
      verification: {
        policeVerifiedOn: new Date(Date.now() - 700 * 86_400_000).toISOString(),
        expiresOn: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
    }, actor);
    const lapsing = await findExpiringVerifications(SID, 30);
    ok('a verification lapsing within a month is found', lapsing.some(s => String(s._id) === String(soon._id)));
    const far = await findExpiringVerifications(SID, 1);
    ok('...and is not raised a year early', !far.some(s => String(s._id) === String(soon._id)));
    ok('somebody with no verification date is not chased for one',
      !lapsing.some(s => String(s._id) === String(mali._id)));

    // ============================================== the agency bill, the whole point
    console.log('\nWhat the agency bills for, versus who is actually here');
    for (const n of ['Guard 2', 'Guard 3', 'Guard 4']) {
      await createStaff(SID, {
        name: n, phone: '98000001', designation: 'SECURITY_GUARD',
        employmentType: 'AGENCY', vendorId: String(agency._id),
      }, actor);
    }
    let head = await agencyHeadcount(SID);
    eq('the agency shows four on the roll', head[0]?.active, 4);

    await endEmployment(SID, String(guard._id), new Date(), actor);
    head = await agencyHeadcount(SID);
    eq('...three once one leaves', head[0]?.active, 3);
    eq('...and the one who left this month is counted separately', head[0]?.leftThisMonth, 1);
    eq('...against the right agency', head[0]?.vendorName, 'SecureCo');

    // =========================================== staffId on an expense line
    console.log('\n"How much did we pay Gangaram" comes from the ledger itself');
    const paid = await createExpense(SID, {
      description: 'July', paymentMode: 'BANK',
      lineItems: [
        { expenseAccountCode: '5200', amountPaise: 1_200_000, staffId: String(mali._id) },
        { expenseAccountCode: '5200', amountPaise: 800_000 },
      ],
    }, actor);
    eq('the line records who it paid', String(paid.lineItems[0].staffId), String(mali._id));
    eq('...and snapshots the name, so it reads years later', paid.lineItems[0].staffName, 'Gangaram');
    ok('...while an untagged line stays untagged', !paid.lineItems[1].staffId);

    let strangerStaff = '';
    const theirStaff = await createStaff(OTHER, { name: 'Theirs', phone: '1', designation: 'OTHER' }, actor);
    try {
      await createExpense(SID, {
        lineItems: [{ expenseAccountCode: '5200', amountPaise: 100, staffId: String(theirStaff._id) }],
      }, actor);
    } catch (e: any) { strangerStaff = e.message; }
    ok('a staff member from another society is refused', strangerStaff.includes('Staff member not found'), strangerStaff);

    // The figure has to agree with the books, or it is just a number on a page.
    await approveExpense(SID, String(paid._id), actor);
    await payExpense(SID, String(paid._id), actor, 'BANK');

    const perStaff = await Expense.aggregate([
      { $match: { societyId, status: 'PAID' } },
      { $unwind: '$lineItems' },
      { $match: { 'lineItems.staffId': mali._id } },
      { $group: { _id: null, total: { $sum: '$lineItems.amountPaise' } } },
    ]);
    eq('the per-staff total is what was paid', perStaff[0]?.total, 1_200_000);

    const staffAcct = await LedgerAccount.findOne({ societyId, code: '5200' }).lean();
    eq('...and the ledger carries the whole voucher, tagged and untagged alike',
      staffAcct?.currentBalancePaise, 2_000_000);

    // ============================================ bulk entry knows staff too
    console.log('\nThe spreadsheet can name a staff member');
    const csv = { csvText: `Head,Amount,Staff\nStaff Payments,500,${mali.staffCode}` };
    const preview = await bulkExpense.preview(SID, csv, { shape: 'PER_ROW' });
    eq('a staff code resolves', preview.totals.create, 1);
    eq('...with no errors', preview.totals.error, 0);

    const byName = await bulkExpense.preview(SID, { csvText: 'Head,Amount,Staff\nStaff Payments,500,Gangaram' }, { shape: 'PER_ROW' });
    eq('...and so does the name', byName.totals.create, 1);

    const unknown = await bulkExpense.preview(SID, { csvText: 'Head,Amount,Staff\nStaff Payments,500,Nobody' }, { shape: 'PER_ROW' });
    eq('an unknown staff member is a row error', unknown.totals.error, 1);
    ok('...naming them', unknown.rows[0].message?.includes('Nobody'), unknown.rows[0].message);

    const committed = await bulkExpense.commit(SID, csv, { shape: 'PER_ROW' }, actor);
    eq('and it commits', committed.vouchers, 1);
    const tagged = await Expense.findOne({ societyId, voucherNumber: { $exists: true }, 'lineItems.staffId': mali._id, grossPaise: 50_000 }).lean();
    ok('...with the staff tag surviving the import', Boolean(tagged));

    // ===================================================== roles for staff
    console.log('\nA staff member gets access the same way a committee member does');
    const roles = await listRoles(SID, actor.userId, actor.userName);
    const guardRole = roles.find(r => r.name === 'Security guard')!;
    const chairRole = roles.find(r => r.name === 'Chairman')!;

    const withLogin = await createStaff(SID, {
      name: 'Logged In Guard', phone: '9800000020', designation: 'SECURITY_GUARD',
      accessRoleId: String(guardRole._id),
    }, actor);
    await SocietyStaff.updateOne({ _id: withLogin._id }, { $set: { userId: guardUserId } });

    const access = await resolveAccess(SID, guardUserId.toString(), UserRole.SOCIETY_EMPLOYEE);
    eq('their role decides what they can do', access.permissions['GATE_CONSOLE'], 'FULL');
    eq('...and a guard still cannot read the resident directory', access.permissions['RESIDENTS_VIEW'], 'NONE');
    ok('...and is not an admin', !access.isAdmin);

    let committeeOnly = '';
    try {
      await createStaff(SID, {
        name: 'Wrong Role', phone: '9800000021', designation: 'MANAGER',
        accessRoleId: String(chairRole._id),
      }, actor);
    } catch (e: any) { committeeOnly = e.message; }
    ok('a committee-only role cannot be given to staff', committeeOnly.includes('committee seats'), committeeOnly);

    // A role held ONLY by staff must still be protected from deletion. Uses a
    // CUSTOM role: a seeded one is refused for being standard long before the
    // in-use check runs, so testing with one would prove nothing about it.
    const custom = await AccessRole.create({
      ...audit(societyId), name: 'Night gate only', appliesTo: 'STAFF',
      permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] }, isSystem: false, isActive: true,
    });
    ok('a custom role deletes cleanly while nobody holds it',
      await deleteRole(SID, String(custom._id)).then(() => true).catch(() => false));

    const custom2 = await AccessRole.create({
      ...audit(societyId), name: 'Night gate only', appliesTo: 'STAFF',
      permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] }, isSystem: false, isActive: true,
    });
    await updateStaff(SID, String(withLogin._id), { accessRoleId: String(custom2._id) }, actor);

    let held = '';
    try { await deleteRole(SID, String(custom2._id)); }
    catch (e: any) { held = e.message; }
    ok('...but not once a staff member holds it — no committee member involved',
      held.includes('staff member'), held);

    // ================================================================ listing
    console.log('\nThe list');
    const active = await listStaff(SID, {});
    ok('only current staff by default', active.every(s => s.isActive));
    const all = await listStaff(SID, { active: 'all' });
    ok('...and everyone when asked', all.length > active.length);

    console.log(`\n  (agency roll: ${head[0]?.active} on site, ${head[0]?.leftThisMonth} left this month)`);
    console.log(`  (Gangaram paid ${rupees(perStaff[0]?.total || 0)})`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
