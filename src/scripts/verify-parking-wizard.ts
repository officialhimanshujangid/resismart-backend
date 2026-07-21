/**
 * The parking settings wizard, and the duty roster behind it.
 *
 * Five things have to be true, and every one of them is a thing that costs a
 * resident money or a committee member their patience when it is not:
 *
 *   1. **The wizard creates a real charge head that the invoice generator
 *      actually bills.** Not a parking-shaped rate table read by parking-shaped
 *      code — an ordinary `ChargeHead`, so the invoice PDF, GST, the 4120
 *      ledger account, defaulter notices and My Bills keep working untouched.
 *      The assertion therefore runs `generateInvoicesForSociety` and reads the
 *      line item, rather than inspecting the head and hoping.
 *   2. **Re-running it does not create a second head.** A committee raises the
 *      rate every April; a wizard that is not idempotent bills every flat twice
 *      in year two and nobody notices until somebody adds up their own bill.
 *   3. **Switching to free DEACTIVATES rather than deletes.** A deleted head
 *      takes the explanation of every invoice it ever produced with it.
 *   4. **A yearly rate bills in exactly one month of twelve** — and re-running
 *      that month does not bill it twice.
 *   5. **The duty roster is consulted before the committee** for a visitor to a
 *      vacant flat. This is the rung that was a deliberate no-op, and the whole
 *      reason the ladder exists is that a society-wide committee broadcast
 *      about a flat none of them can speak for reads as surveillance.
 *
 *   npx tsx src/scripts/verify-parking-wizard.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import request from 'supertest';
import { appConfig } from '../config/appConfig';
import app from '../app';
import { User } from '../models/user.model';
import { Society } from '../models/society.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { ResidentVehicle } from '../models/resident-vehicle.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { OpsDutyRoster } from '../models/ops-duty-roster.model';
import { ParkingZone } from '../models/parking-zone.model';
import { ParkingSlot } from '../models/parking-slot.model';
import { ParkingAllocation } from '../models/parking-allocation.model';
import { ParkingRequest } from '../models/parking-request.model';
import { ChargeHead } from '../models/charge-head.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import * as parking from '../services/parking.service';
import * as opsPolicy from '../services/ops-policy.service';
import { shiftAt } from '../services/ops-policy.service';
import { whoToAsk } from '../services/gate-approval.service';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { buildInvoicePdf } from '../services/society-invoice.service';
import { pdfTextLines } from './lib/pdf-text';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole) =>
  generateAccessToken({
    userId: String(userId),
    activeTenantId: SID,
    activeTenantType: TenantType.SOCIETY,
    activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole, inSociety = true) => {
  const u = await User.create({
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: inSociety ? [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }] : [],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

/** One flat's bill for one period, read the way a resident reads it. */
const invoiceFor = async (flatId: any, period: string) =>
  MaintenanceInvoice.findOne({ societyId, flatId, billingPeriod: period }).lean();

const lineFor = (invoice: any, code: string) =>
  (invoice?.lineItems || []).find((l: any) => l.code === code);

const headsOf = () => ChargeHead.find({ societyId, category: 'PARKING' }).sort({ code: 1 }).lean();

/** The lines of text a resident actually sees on the downloaded PDF. */
const pdfLines = async (invoice: any): Promise<string[]> =>
  pdfTextLines(await buildInvoicePdf(invoice, 'Throwaway Society'));

/** The multiplication sign, as the PDF encodes it. */
const TIMES = '×';

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    ResidentVehicle.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    OpsDutyRoster.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    ParkingZone.deleteMany({ societyId }), ParkingSlot.deleteMany({ societyId }),
    ParkingAllocation.deleteMany({ societyId }), ParkingRequest.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }), LedgerAccount.deleteMany({ societyId }),
    JournalEntry.deleteMany({ societyId }), FinancePolicy.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  // Built explicitly rather than left to autoIndex: the duplicate-rota
  // assertion races a background index build otherwise, and an index that is
  // not there yet refuses nothing at all.
  await Promise.all([
    ParkingZone.syncIndexes(), ParkingSlot.syncIndexes(),
    ParkingAllocation.syncIndexes(), OpsDutyRoster.syncIndexes(),
  ]);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('WizAdmin', UserRole.SOCIETY_ADMIN);
    const owner101 = await mkUser('WizOwner101', UserRole.RESIDENT_OWNER);
    const dutyOfficer = await mkUser('WizDutyOfficer', UserRole.SOCIETY_COMMITTEE);
    const wingOfficer = await mkUser('WizWingOfficer', UserRole.SOCIETY_COMMITTEE);
    const committeeOnly = await mkUser('WizCommitteeOnly', UserRole.SOCIETY_COMMITTEE);
    // Deliberately NOT a member of this society — the reachability check.
    const stranger = await mkUser('WizStranger', UserRole.SOCIETY_COMMITTEE, false);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };
    const actor = { userId: String(admin), userName: 'Setup' };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat101 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: owner101,
    });
    // Vacant, and with NO owner on record on purpose: the ladder's first rung
    // must resolve to nobody so the roster rung is the one under test.
    const flatEmpty = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '404', status: FlatStatus.VACANT,
    });
    await Resident.create({
      ...audit, flatId: flat101._id, userId: owner101, person: { name: 'Owner 101' },
      relationship: 'OWNER', householdType: 'OWNER', isActive: true,
    });

    // The ordinary maintenance head every society has. It is here so the yearly
    // assertions can tell "the annual charge is not due" from "nothing billed
    // at all", which are the same number without it.
    await createChargeHead(SID, {
      code: 'MAINT', name: 'Maintenance', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
      incomeAccountCode: '4100',
    } as any, actor);

    // ============================================== step 1 — "no, we don't"
    console.log('Step 1 — a society that does not manage parking');
    const off = await parking.configureParking(SID, { manage: false }, actor);
    ok('the wizard answers "not managed"', off.managed === false);
    let modules = await opsPolicy.resolveOpsModules(SID);
    ok('...and PARKING is not in the module list', !modules.includes('PARKING'), modules.join(','));
    ok('...while the modules the society DOES use are untouched',
      modules.includes('GATE') && modules.includes('COMPLAINTS'), modules.join(','));

    // ================================================ steps 1–2 — on, free
    console.log('\nSteps 1 and 2 — managed, and free for residents');
    const free = await parking.configureParking(SID, { manage: true, chargeable: false }, actor);
    ok('parking is on', free.managed === true);
    ok('...and free', free.chargeable === false);
    modules = await opsPolicy.resolveOpsModules(SID);
    ok('...PARKING joined the module list', modules.includes('PARKING'), modules.join(','));
    ok('...and switching it on did not switch anything else off',
      modules.includes('GATE') && modules.includes('STAFF') && modules.includes('ASSETS'),
      modules.join(','));
    ok('...nothing is charging yet', (await headsOf()).every(h => !h.isActive));

    // ======================================= steps 3–5 — an ordinary head
    console.log('\nSteps 3 to 5 — ₹500 a slot, every month, bikes the same');
    const monthly = await parking.configureParking(SID, {
      manage: true, chargeable: true, billingFrequency: 'MONTHLY', perSlotPaise: 50_000,
    }, actor);

    const carHead = await ChargeHead.findOne({ societyId, code: 'PARKING' }).lean();
    const bikeHead = await ChargeHead.findOne({ societyId, code: 'PARKING-2W' }).lean();
    ok('the wizard created a charge head', !!carHead);
    ok('...an ORDINARY one — PARKING / PER_QUANTITY / parkingSlots',
      carHead?.category === 'PARKING' && carHead?.pricingMode === 'PER_QUANTITY'
      && carHead?.quantityKey === 'parkingSlots',
      JSON.stringify({ c: carHead?.category, p: carHead?.pricingMode, q: carHead?.quantityKey }));
    ok('...crediting 4120 Parking Charges, which was already seeded',
      carHead?.incomeAccountCode === '4120', carHead?.incomeAccountCode);
    ok('...at the rate that was typed', carHead?.perUnitRatePaise === 50_000);
    ok('...and recurring, monthly',
      carHead?.isRecurring === true && (carHead?.billingFrequency || 'MONTHLY') === 'MONTHLY');
    ok('a two-wheeler head exists on its own key',
      bikeHead?.quantityKey === 'twoWheelerSlots', bikeHead?.quantityKey);
    ok('...at the car rate, because no separate rate was given',
      bikeHead?.perUnitRatePaise === 50_000, String(bikeHead?.perUnitRatePaise));
    ok('the policy remembers both heads, so a re-run edits them',
      String(monthly.carHead?._id) === String(carHead?._id)
      && String(monthly.bikeHead?._id) === String(bikeHead?._id));

    // ================================ the invoice generator actually bills it
    console.log('\nThe bill — not a parallel path, the real invoice generator');
    const zone = await parking.createZone(SID, { name: 'Basement 1', rows: 4, cols: 6 }, actor);
    await parking.bulkCreateSlots(SID, {
      zoneId: String(zone._id), prefix: 'B1-', count: 2, vehicleKind: 'CAR',
    }, actor);
    await parking.bulkCreateSlots(SID, {
      zoneId: String(zone._id), prefix: 'BK-', count: 2, vehicleKind: 'BIKE', startRow: 3,
    }, actor);
    const b1 = (await ParkingSlot.findOne({ societyId, code: 'B1-1' }).lean())!;
    const bk1 = (await ParkingSlot.findOne({ societyId, code: 'BK-1' }).lean())!;
    await parking.allocate(SID, { slotId: String(b1._id), flatId: String(flat101._id) }, actor);
    await parking.allocate(SID, { slotId: String(bk1._id), flatId: String(flat101._id) }, actor);

    await generateInvoicesForSociety(SID, { period: '2026-06', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const june = await invoiceFor(flat101._id, '2026-06');
    const juneCar = lineFor(june, 'PARKING');
    const juneBike = lineFor(june, 'PARKING-2W');
    ok('the flat is billed for its parking', !!juneCar, JSON.stringify((june as any)?.lineItems?.map((l: any) => l.code)));
    ok('...one slot at ₹500', juneCar?.baseAmountPaise === 50_000, String(juneCar?.baseAmountPaise));
    // ...and the line SHOWS that it is one slot at ₹500, rather than only
    // totalling to it. `quantity`/`ratePaise` used to be filled in for METERED
    // lines alone, so parking arrived as a bare ₹500 with no working — and
    // "why has my bill gone up?" is exactly the question the working answers.
    ok('...and says so on the line: 1 × ₹500, not a bare ₹500',
      juneCar?.quantity === 1 && juneCar?.ratePaise === 50_000,
      JSON.stringify({ q: juneCar?.quantity, r: juneCar?.ratePaise }));
    ok('...the two-wheeler line shows its own count and rate too',
      juneBike?.quantity === 1 && juneBike?.ratePaise === 50_000,
      JSON.stringify({ q: juneBike?.quantity, r: juneBike?.ratePaise }));
    // A flat-rate head has no count to show, and must not invent one.
    ok('...while the flat-rate maintenance line carries no count or rate',
      lineFor(june, 'MAINT')?.quantity == null && lineFor(june, 'MAINT')?.ratePaise == null,
      JSON.stringify({ q: lineFor(june, 'MAINT')?.quantity, r: lineFor(june, 'MAINT')?.ratePaise }));
    ok('...the two-wheeler lands on its own line, not folded into the car one',
      juneBike?.baseAmountPaise === 50_000, String(juneBike?.baseAmountPaise));
    ok('...and the line credits 4120, so the ledger needs no teaching',
      juneCar?.incomeAccountCode === '4120');
    ok('the total is maintenance plus both slots',
      (june as any)?.totalPaise === 200_000, String((june as any)?.totalPaise));
    // The flat with no slots must not acquire a parking line out of nowhere.
    const juneEmpty = await invoiceFor(flatEmpty._id, '2026-06');
    ok('a flat holding no slot is billed no parking',
      (juneEmpty as any)?.totalPaise === 100_000, String((juneEmpty as any)?.totalPaise));

    /**
     * The count comes from the ALLOCATIONS, and the invoice is where that has
     * to be visible. A second bay is allotted and the next bill doubles; the
     * bay is given back and the one after that halves — with nobody having
     * typed a number anywhere. This is the whole reason the module exists.
     */
    const b2 = (await ParkingSlot.findOne({ societyId, code: 'B1-2' }).lean())!;
    const second = await parking.allocate(SID, { slotId: String(b2._id), flatId: String(flat101._id) }, actor);
    await generateInvoicesForSociety(SID, { period: '2026-05', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const mayCar = lineFor(await invoiceFor(flat101._id, '2026-05'), 'PARKING');
    ok('a second bay doubles the parking line, with nobody typing a count',
      mayCar?.baseAmountPaise === 100_000, String(mayCar?.baseAmountPaise));
    ok('...and the line reads 2 × ₹500, which is the answer to "why is it higher?"',
      mayCar?.quantity === 2 && mayCar?.ratePaise === 50_000,
      JSON.stringify({ q: mayCar?.quantity, r: mayCar?.ratePaise }));

    // ...and it survives as far as the document the resident downloads. The
    // template drew name/base/GST/total and nothing else, so the count and rate
    // stopped at the database — which is no use to the person querying the bill.
    const mayPdf = await pdfLines(await invoiceFor(flat101._id, '2026-05'));
    const working = mayPdf.filter((l) => l.includes(TIMES));
    ok('the PDF prints the working under the parking charge',
      working.some((l) => l.startsWith(`2 ${TIMES}`) && l.includes('500.00')),
      JSON.stringify(working));
    ok('...on the two-wheeler line as well',
      working.some((l) => l.startsWith(`1 ${TIMES}`) && l.includes('500.00')),
      JSON.stringify(working));
    // Two priced-by-count lines, two workings — the flat-rate maintenance line
    // must not acquire an invented one.
    ok('...and on nothing else — the flat-rate line stays a flat rate',
      working.length === 2, JSON.stringify(mayPdf.filter((l) => l.includes(TIMES))));

    await parking.release(SID, String(second._id), 'Sold the car', actor);
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const aprCar = lineFor(await invoiceFor(flat101._id, '2026-04'), 'PARKING');
    ok('...and giving it back halves it again, on the next bill',
      aprCar?.baseAmountPaise === 50_000, String(aprCar?.baseAmountPaise));
    ok('...with the count back down to 1, so the bill explains the drop as well',
      aprCar?.quantity === 1, String(aprCar?.quantity));

    // ====================================== re-running is an EDIT, not a copy
    console.log('\nRe-running the wizard edits; it never makes a second head');
    const raised = await parking.configureParking(SID, {
      manage: true, chargeable: true, billingFrequency: 'MONTHLY',
      perSlotPaise: 60_000, twoWheelerPaise: 20_000,
    }, actor);
    let heads = await headsOf();
    ok('there are still exactly two parking heads', heads.length === 2, `found ${heads.length}`);
    ok('...and they are the SAME two',
      String(raised.carHead?._id) === String(carHead?._id)
      && String(raised.bikeHead?._id) === String(bikeHead?._id));
    ok('...with the new rates on them',
      heads.find(h => h.code === 'PARKING')?.perUnitRatePaise === 60_000
      && heads.find(h => h.code === 'PARKING-2W')?.perUnitRatePaise === 20_000,
      JSON.stringify(heads.map(h => [h.code, h.perUnitRatePaise])));

    // A third and fourth run, changing nothing. This is the shape that bites:
    // an admin opening the settings screen and pressing Save.
    await parking.configureParking(SID, {
      manage: true, chargeable: true, billingFrequency: 'MONTHLY',
      perSlotPaise: 60_000, twoWheelerPaise: 20_000,
    }, actor);
    await parking.configureParking(SID, {
      manage: true, chargeable: true, billingFrequency: 'MONTHLY',
      perSlotPaise: 60_000, twoWheelerPaise: 20_000,
    }, actor);
    ok('...and pressing Save four times still leaves two heads',
      (await headsOf()).length === 2);

    // ================================== free again — deactivate, never delete
    console.log('\nGoing back to free stops the money and keeps the history');
    await parking.configureParking(SID, { manage: true, chargeable: false }, actor);
    heads = await headsOf();
    ok('both heads still EXIST', heads.length === 2, `found ${heads.length}`);
    ok('...and are switched off rather than removed',
      heads.every(h => h.isActive === false), JSON.stringify(heads.map(h => [h.code, h.isActive])));

    await generateInvoicesForSociety(SID, { period: '2026-07', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const july = await invoiceFor(flat101._id, '2026-07');
    ok('the next bill carries no parking charge', !lineFor(july, 'PARKING'));
    ok('...and everything else still bills', (july as any)?.totalPaise === 100_000, String((july as any)?.totalPaise));
    ok('last year\'s invoice still explains itself',
      !!lineFor(await invoiceFor(flat101._id, '2026-06'), 'PARKING'));

    // ==================================== a yearly rate, in one month of twelve
    console.log('\nOnce a year, in April — the start of the Indian financial year');
    const yearly = await parking.configureParking(SID, {
      manage: true, chargeable: true, billingFrequency: 'YEARLY',
      perSlotPaise: 600_000, twoWheelerPaise: 200_000,
    }, actor);
    ok('April is the default month nobody had to choose', yearly.annualBillingMonth === 4);
    ok('...the same heads came back on, rather than new ones',
      (await headsOf()).length === 2
      && String(yearly.carHead?._id) === String(carHead?._id));
    ok('...and they are active again', (await headsOf()).every(h => h.isActive === true));

    await generateInvoicesForSociety(SID, { period: '2027-03', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const march = await invoiceFor(flat101._id, '2027-03');
    ok('March — the annual charge is not due', !lineFor(march, 'PARKING'));
    ok('...but the monthly maintenance still is',
      (march as any)?.totalPaise === 100_000, String((march as any)?.totalPaise));

    await generateInvoicesForSociety(SID, { period: '2027-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const april = await invoiceFor(flat101._id, '2027-04');
    ok('April — it lands, exactly once',
      (april as any)?.totalPaise === 900_000, String((april as any)?.totalPaise));

    await generateInvoicesForSociety(SID, { period: '2027-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    ok('...and re-running April does not charge it twice',
      ((await invoiceFor(flat101._id, '2027-04')) as any)?.totalPaise === 900_000);

    await generateInvoicesForSociety(SID, { period: '2027-05', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    ok('May is back to normal',
      ((await invoiceFor(flat101._id, '2027-05')) as any)?.totalPaise === 100_000);

    // ======================================================== the duty roster
    console.log('\nA visitor to an empty flat gets a NAME, not the whole committee');

    // A serving committee, so the last rung has somebody on it to fall through
    // to — otherwise "the roster was consulted" would be indistinguishable from
    // "there was nobody else anyway".
    const term = await Committee.create({
      ...audit, name: 'Managing Committee', termStartDate: new Date('2026-01-01'), status: 'ACTIVE',
    });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: committeeOnly,
      memberSnapshot: { name: 'Committee Only' },
      designationKey: 'MEMBER', designationLabel: 'Member',
      startDate: new Date('2026-01-01'), status: 'ACTIVE',
    });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: dutyOfficer,
      memberSnapshot: { name: 'Duty Officer' },
      designationKey: 'SECRETARY', designationLabel: 'Secretary',
      startDate: new Date('2026-01-01'), status: 'ACTIVE',
    });

    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { 'gate.vacantFlat.handler': 'DUTY_ROSTER' } });

    // Nothing on the rota yet: the rung must fall THROUGH, not swallow the alert.
    const empty = await whoToAsk(SID, String(flatEmpty._id));
    ok('an empty rota falls through instead of silencing the alert',
      empty.via === 'VACANT_COMMITTEE', empty.via);

    const today = new Date().getDay();
    const otherShift = shiftAt(new Date()) === 'DAY' ? 'NIGHT' : 'DAY';

    // Somebody rostered for the OTHER half of the day. They must not be asked
    // now — a rota that ignores its own shifts is a rota nobody trusts.
    await opsPolicy.addDutyRosterEntry(SID, {
      userId: String(wingOfficer), weekday: today, shift: otherShift as any,
    }, actor);
    const wrongShift = await whoToAsk(SID, String(flatEmpty._id));
    ok('somebody on the other shift is not woken up',
      wrongShift.via === 'VACANT_COMMITTEE', wrongShift.via);

    const seat = await opsPolicy.addDutyRosterEntry(SID, {
      userId: String(dutyOfficer), weekday: today, shift: 'ALL_DAY',
    }, actor);
    ok('the rota entry names a real person', seat.memberName === 'WizDutyOfficer', seat.memberName);
    ok('...and picks up their committee seat for the notification body',
      seat.designationLabel === 'Secretary', seat.designationLabel);

    const asked = await whoToAsk(SID, String(flatEmpty._id));
    ok('the roster is consulted BEFORE the committee',
      asked.via === 'VACANT_DUTY_ROSTER', asked.via);
    ok('...and it is the duty officer who is asked',
      asked.userIds.length === 1 && asked.userIds[0] === String(dutyOfficer),
      JSON.stringify(asked.userIds));
    ok('...the rest of the committee is not told at all',
      !asked.userIds.includes(String(committeeOnly)));

    // The same person twice on one slot would notify them twice for one visitor.
    let duplicated = '';
    try {
      await opsPolicy.addDutyRosterEntry(SID, {
        userId: String(dutyOfficer), weekday: today, shift: 'ALL_DAY',
      }, actor);
    } catch (e: any) { duplicated = e.message; }
    ok('the same person cannot be rostered twice for one slot',
      duplicated.includes('already on duty'), duplicated);

    // A wing-scoped seat beats the society-wide one for a flat in that wing.
    await opsPolicy.addDutyRosterEntry(SID, {
      userId: String(wingOfficer), weekday: today, shift: 'ALL_DAY', blockId: String(wing._id),
    }, actor);
    const wingAsked = await whoToAsk(SID, String(flatEmpty._id));
    ok('a wing-scoped duty officer wins for a flat in that wing',
      wingAsked.userIds.length === 1 && wingAsked.userIds[0] === String(wingOfficer),
      JSON.stringify(wingAsked.userIds));

    // Somebody who has left the society is not a person who can be asked.
    await OpsDutyRoster.updateMany({ societyId }, { $set: { isActive: false } });
    await opsPolicy.addDutyRosterEntry(SID, {
      userId: String(committeeOnly), weekday: today, shift: 'ALL_DAY',
    }, actor);
    await User.updateOne({ _id: committeeOnly }, { $set: { memberships: [] } });
    const goneAway = await whoToAsk(SID, String(flatEmpty._id));
    ok('a rostered person who has left the society falls through',
      goneAway.via === 'VACANT_COMMITTEE', goneAway.via);

    let strangerRefused = '';
    try {
      await opsPolicy.addDutyRosterEntry(SID, {
        userId: String(stranger), weekday: today, shift: 'ALL_DAY',
      }, actor);
    } catch (e: any) { strangerRefused = e.message; }
    ok('somebody from another society cannot be put on this rota',
      strangerRefused.includes('not a member of this society'), strangerRefused);

    // Taking the last person off must not leave empty-flat callers unheard.
    await OpsDutyRoster.updateMany({ societyId }, { $set: { isActive: false } });
    const cleared = await whoToAsk(SID, String(flatEmpty._id));
    ok('clearing the rota falls back to the committee, not to silence',
      cleared.via === 'VACANT_COMMITTEE' && cleared.userIds.length > 0, cleared.via);

    // ============================================ the wizard over the wire
    console.log('\nOver HTTP — the settings screen must be reachable while parking is OFF');
    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    await request(app).put('/api/v1/parking/settings').set(auth(adminTk)).send({ manage: false });
    const goneZones = await request(app).get('/api/v1/parking/zones').set(auth(adminTk));
    ok('with parking off, the module still 404s', goneZones.status === 404, `got ${goneZones.status}`);

    const stillThere = await request(app).get('/api/v1/parking/settings').set(auth(adminTk));
    ok('...but the wizard itself is reachable — the lock is not inside the room',
      stillThere.status === 200, `got ${stillThere.status}`);
    ok('...and it reports the module as off', stillThere.body?.data?.managed === false);

    const switchedOn = await request(app).put('/api/v1/parking/settings').set(auth(adminTk)).send({
      manage: true, chargeable: true, billingFrequency: 'YEARLY', annualBillingMonth: 4,
      perSlotPaise: 600_000,
    });
    ok('the wizard switches parking on over HTTP', switchedOn.status === 200, `got ${switchedOn.status}`);
    ok('...and says so in the words the admin used',
      String(switchedOn.body?.message).includes('once a year, in April'), switchedOn.body?.message);
    const backOn = await request(app).get('/api/v1/parking/zones').set(auth(adminTk));
    ok('...after which the module is reachable again', backOn.status === 200, `got ${backOn.status}`);
    ok('...and the slots were waiting where they were left',
      await ParkingSlot.countDocuments({ societyId, isActive: true }) === 4);

    const noAmount = await request(app).put('/api/v1/parking/settings').set(auth(adminTk))
      .send({ manage: true, chargeable: true, billingFrequency: 'MONTHLY' });
    ok('"we charge for it" with no amount is refused at the door',
      noAmount.status === 400, `got ${noAmount.status}`);

    console.log('\nOver HTTP — the duty roster CRUD');
    const added = await request(app).post('/api/v1/gate/duty-roster').set(auth(adminTk))
      .send({ userId: String(dutyOfficer), weekday: today, shift: 'ALL_DAY' });
    ok('a duty entry can be added', added.status === 201, `got ${added.status}`);
    ok('...and the reply names the person, not a row id',
      String(added.body?.message).includes('WizDutyOfficer'), added.body?.message);

    const listed = await request(app).get('/api/v1/gate/duty-roster').set(auth(adminTk));
    ok('the rota can be read back', listed.status === 200 && listed.body?.data?.length === 1,
      `got ${listed.status} / ${listed.body?.data?.length}`);

    const edited = await request(app).put(`/api/v1/gate/duty-roster/${added.body?.data?._id}`)
      .set(auth(adminTk)).send({ shift: 'NIGHT' });
    ok('it can be edited', edited.status === 200 && edited.body?.data?.shift === 'NIGHT', `got ${edited.status}`);

    const dropped = await request(app).delete(`/api/v1/gate/duty-roster/${added.body?.data?._id}`)
      .set(auth(adminTk));
    ok('it can be taken off the rota', dropped.status === 200, `got ${dropped.status}`);
    ok('...as a deactivation, so the seat can be filled again by the same person',
      await OpsDutyRoster.countDocuments({ societyId, isActive: false }) > 0);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await mongoose.disconnect();
  process.exit(1);
});
