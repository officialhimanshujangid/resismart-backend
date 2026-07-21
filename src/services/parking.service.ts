import mongoose, { ClientSession } from 'mongoose';
import { ParkingZone, IParkingZone, ParkingZoneKind } from '../models/parking-zone.model';
import {
  ParkingSlot, IParkingSlot, SlotVehicleKind, SlotSize, SlotStatus,
} from '../models/parking-slot.model';
import { ParkingAllocation, IParkingAllocation, AllocationKind } from '../models/parking-allocation.model';
import { ParkingRequest, IParkingRequest } from '../models/parking-request.model';
import { ResidentVehicle } from '../models/resident-vehicle.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { ChargeHead, IChargeHead } from '../models/charge-head.model';
import { SocietyOpsPolicy, ISocietyOpsPolicy, OpsModule } from '../models/society-ops-policy.model';
import { createChargeHead, updateChargeHead } from './charge-head.service';
import { getOrCreateOpsPolicy, resolveOpsModules } from './ops-policy.service';
import { planAllows } from './entitlement.service';
import { getEffectiveLimits } from './subscription-lifecycle.service';
import { logger } from '../utils/logger.util';

/**
 * Parking: an inventory of slots, who holds each one, and — the entire point —
 * a bill that agrees with both.
 *
 * Before this, "parking" meant two things that never met in code: a free-text
 * slot label on a vehicle row, and a hand-typed number on the flat that
 * PER_QUANTITY billing multiplied by a rate. A flat with five cars and a typed
 * "2" was billed for two, forever, and nothing anywhere raised a flag. Every
 * `allocate` and every `release` in this file recomputes that number **inside
 * the same transaction**, so the count is derived from the allocations and a
 * human can no longer be wrong about it.
 *
 * The other rule worth stating out loud: one live allocation per slot is
 * enforced by a partial unique index on `ParkingAllocation`, not by a check
 * here. Two committee members allotting B1-14 from two browsers at the same
 * second would both read "free"; only the database can refuse the second write.
 * This file's job is to turn that refusal into a sentence.
 */

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class ParkingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/** The office acting for somebody, versus a resident acting for themselves. */
export interface ParkingActorOpts { onBehalf?: boolean }

/**
 * The two `Flat.quantities` keys parking owns.
 *
 * They are strings agreed with the charge head (`quantityKey`), not an enum —
 * that is how `PER_QUANTITY` works, and a society can already bill anything
 * countable by agreeing on a key. Named here so the recompute and the wizard
 * that creates the head cannot drift apart on a typo.
 */
export const CAR_QUANTITY_KEY = 'parkingSlots';
export const BIKE_QUANTITY_KEY = 'twoWheelerSlots';

/**
 * A slot's kind decides which bill line it lands on.
 *
 * EV and ANY count as cars. An EV is a car that plugs in, and ANY means the
 * society never distinguished — billing has to choose one, and the car rate is
 * the choice a committee can defend to a resident. A society that wants bikes
 * billed separately marks the bike rows BIKE, which is the one thing the wizard
 * asks about.
 */
const quantityKeyFor = (kind: SlotVehicleKind): string =>
  kind === 'BIKE' ? BIKE_QUANTITY_KEY : CAR_QUANTITY_KEY;

const labelOf = (flat: any): string => `${flat?.blockName || ''} ${flat?.number || ''}`.trim();

/** Mongo's duplicate-key error, however the driver version chose to wrap it. */
const isDuplicate = (e: any) => e?.code === 11000 || e?.errorResponse?.code === 11000;

// ------------------------------------------------------------------ billing

export interface BilledCounts { cars: number; bikes: number }

/**
 * Recompute what this flat is billed for, from what it actually holds.
 *
 * Always called with the caller's session, so the count and the allocation that
 * changed it commit or roll back together. A recompute outside the transaction
 * would leave the exact failure this module exists to remove: a release that
 * succeeded and a bill that still says two.
 *
 * It OVERWRITES whatever a human typed. That is deliberate and it is the
 * feature — the hand-typed number is the thing that has been quietly wrong in
 * every society running on a spreadsheet. `reconcile()` below reports the
 * disagreement before anybody switches this on, so nobody is surprised.
 *
 * Zero is written rather than the key being removed. `0` is a fact — this flat
 * holds no slots — and an absent key is only indistinguishable from it until
 * somebody restores a backup.
 */
async function syncFlatBilling(
  societyId: string, flatId: any, session: ClientSession,
): Promise<BilledCounts> {
  const live = await ParkingAllocation.find(
    { societyId: oid(societyId), flatId: oid(flatId), status: 'ACTIVE', chargeable: true },
    { slotKind: 1 },
  ).session(session).lean();

  let cars = 0, bikes = 0;
  for (const row of live) {
    if (quantityKeyFor(row.slotKind as SlotVehicleKind) === BIKE_QUANTITY_KEY) bikes++;
    else cars++;
  }

  await Flat.updateOne(
    { _id: oid(flatId), societyId: oid(societyId) },
    { $set: { [`quantities.${CAR_QUANTITY_KEY}`]: cars, [`quantities.${BIKE_QUANTITY_KEY}`]: bikes } },
  ).session(session);

  return { cars, bikes };
}

// ------------------------------------------------------------- the wizard

/**
 * The codes the wizard owns.
 *
 * A code rather than only an id, because the id can go missing — a society
 * restored from a backup, a head deleted by hand in a support session — and the
 * wizard must then ADOPT the head that is already there instead of creating a
 * second one and billing every flat twice. The stored id is tried first; the
 * code is the safety net; creating is the last resort.
 */
const CAR_HEAD_CODE = 'PARKING';
const BIKE_HEAD_CODE = 'PARKING-2W';

/** Already seeded by the chart of accounts. Named, not looked up by category, so a re-categorised head cannot move the money. */
const PARKING_INCOME_ACCOUNT_CODE = '4120';

/**
 * ₹50,000 for one slot for one period. Anything above this is a rupees/paise
 * mix-up, and the flat that discovers it discovers it on an invoice.
 */
const MAX_SLOT_RATE_PAISE = 50_00_000;

/** The wizard's five questions, in the wizard's own words. */
export interface ParkingWizardInput {
  /** Step 1 — "Do you manage parking in your society?" */
  manage: boolean;
  /** Step 2 — "Is parking free or chargeable?" */
  chargeable?: boolean;
  /** Step 3 — "How do you collect it?" */
  billingFrequency?: 'MONTHLY' | 'YEARLY';
  /** Step 4b — "Which month do you raise it?" 1–12, April unless they say otherwise. */
  annualBillingMonth?: number;
  /** Step 4 — the amount for one slot, for one period. */
  perSlotPaise?: number;
  /** Step 5 — "Charge two-wheelers differently?" Absent means "no, the same". */
  twoWheelerPaise?: number | null;
}

export interface ParkingHeadSummary {
  _id: string;
  code: string;
  name: string;
  quantityKey?: string;
  perUnitRatePaise?: number;
  billingFrequency: 'MONTHLY' | 'YEARLY';
  annualBillingMonth?: number;
  incomeAccountCode: string;
  isActive: boolean;
}

export interface ParkingSettings {
  /** Whether the module is switched on at all — step 1's answer, read back from `modules`. */
  managed: boolean;
  chargeable: boolean;
  billingFrequency: 'MONTHLY' | 'YEARLY';
  annualBillingMonth: number;
  perSlotPaise: number;
  twoWheelerPaise?: number;
  /** The heads the wizard maintains, so a screen can show what is actually being billed. */
  carHead?: ParkingHeadSummary;
  bikeHead?: ParkingHeadSummary;
}

const headSummary = (head: IChargeHead | null | undefined): ParkingHeadSummary | undefined => (head ? {
  _id: String(head._id),
  code: head.code,
  name: head.name,
  quantityKey: head.quantityKey,
  perUnitRatePaise: head.perUnitRatePaise,
  billingFrequency: head.billingFrequency || 'MONTHLY',
  annualBillingMonth: head.annualBillingMonth,
  incomeAccountCode: head.incomeAccountCode,
  isActive: head.isActive,
} : undefined);

interface HeadSpec {
  code: string;
  name: string;
  quantityKey: string;
  ratePaise: number;
  billingFrequency: 'MONTHLY' | 'YEARLY';
  annualBillingMonth: number;
  storedId?: mongoose.Types.ObjectId;
}

/**
 * Create or edit ONE ordinary charge head — never a parallel billing path.
 *
 * This is the single most important line in the module. Everything downstream —
 * the invoice PDF, GST and the ₹7,500 exemption test, the 4120 ledger account,
 * defaulter notices, collection reports, the resident's My Bills screen — is
 * already written against `ChargeHead`. A parking-shaped billing table here
 * would have been quicker to write and would then have had to be taught every
 * one of those things separately, and badly, for ever.
 *
 * `annualBillingMonth` is written even on a MONTHLY head. It is the society's
 * answer to "which month", not a billing instruction: `generateInvoicesForSociety`
 * only reads it for a head whose `billingFrequency` is YEARLY, so a leftover
 * month bills nothing — and keeping it means switching monthly → yearly → monthly
 * does not lose the answer the admin gave.
 */
async function upsertParkingHead(
  societyId: string, spec: HeadSpec, actor: Actor,
): Promise<IChargeHead> {
  let existing = spec.storedId
    ? await ChargeHead.findOne({ _id: spec.storedId, societyId: oid(societyId) })
    : null;
  // The stored id was dangling, or this society had a parking head before the
  // wizard existed. Adopting it is the only way a re-run stays idempotent —
  // creating would hit the unique {society, code} index, and working around
  // THAT with a suffixed code is how a society ends up billed twice.
  if (!existing) existing = await ChargeHead.findOne({ societyId: oid(societyId), code: spec.code });

  const body = {
    name: spec.name,
    category: 'PARKING',
    pricingMode: 'PER_QUANTITY',
    quantityKey: spec.quantityKey,
    perUnitRatePaise: spec.ratePaise,
    incomeAccountCode: PARKING_INCOME_ACCOUNT_CODE,
    isRecurring: true,
    billingFrequency: spec.billingFrequency,
    annualBillingMonth: spec.annualBillingMonth,
    // Switching back on after a spell of free parking re-activates the same
    // head, so last year's invoices and this year's still name the same thing.
    isActive: true,
  };

  if (existing) return updateChargeHead(societyId, String(existing._id), body, actor);
  return createChargeHead(societyId, {
    ...body,
    code: spec.code,
    description: 'Maintained by the parking settings wizard.',
    applicability: { occupancy: ['ALL'] },
  }, actor);
}

/**
 * Stop billing — and stop there.
 *
 * **Never deleted.** A deleted head takes the explanation of every invoice it
 * ever produced with it: last April's bill would still show ₹6,000 of parking
 * and nothing in the system would be able to say what that was. Deactivating
 * removes it from `generateInvoicesForSociety` (which filters on `isActive`)
 * and leaves the history readable.
 *
 * A flat `updateMany` rather than `updateChargeHead`, deliberately: switching
 * parking off must not be refusable because a head is half-configured. The one
 * thing this call has to be able to do is stop the money.
 */
async function deactivateParkingHeads(societyId: string, policy: ISocietyOpsPolicy): Promise<void> {
  const ids = [policy.parking?.chargeHeadId, policy.parking?.twoWheelerChargeHeadId].filter(Boolean);
  await ChargeHead.updateMany(
    {
      societyId: oid(societyId),
      // By id AND by code: a society whose stored ids were lost still gets its
      // billing stopped, which is the half of this that costs residents money.
      $or: [
        ...(ids.length ? [{ _id: { $in: ids } }] : []),
        { code: { $in: [CAR_HEAD_CODE, BIKE_HEAD_CODE] } },
      ],
    },
    { $set: { isActive: false } },
  );
}

/**
 * Add or remove PARKING from the society's module list.
 *
 * Starts from `resolveOpsModules` rather than from `policy.modules` because
 * that field is legitimately undefined for a society that has never chosen —
 * and writing `['PARKING']` over an unset list would switch the gate, complaints
 * and staff OFF as a side effect of turning parking on. Clearing
 * `modulesInferredAt` is the other half: from here on this is a CHOICE, and the
 * inference must never revisit it and quietly drop parking again.
 */
async function setParkingModule(
  societyId: string, policy: ISocietyOpsPolicy, on: boolean,
): Promise<OpsModule[]> {
  const current = await resolveOpsModules(societyId);
  const next = on
    ? [...new Set<OpsModule>([...current, 'PARKING'])]
    : current.filter(m => m !== 'PARKING');
  policy.modules = next;
  policy.modulesInferredAt = undefined;
  return next;
}

/**
 * The settings wizard, in five plain questions.
 *
 * Re-running it is safe and is expected to be the normal case: a committee
 * raises the rate every April, and the whole flow is a form that is submitted
 * complete each time rather than a patch. So an absent two-wheeler rate means
 * "no, the same as cars" and not "leave whatever was there" — the alternative is
 * a screen whose blank field silently keeps last year's separate bike rate.
 *
 * What it does NOT do is bill anything itself. It creates and maintains two
 * ordinary charge heads and stores their ids, and every rupee after that is
 * moved by the same invoicing code that has always moved them.
 */
export async function configureParking(
  societyId: string, input: ParkingWizardInput, actor: Actor,
): Promise<ParkingSettings> {
  /**
   * Gate 1 first: you cannot switch on what the plan does not sell.
   *
   * Every other parking route sits behind `requireModule('PARKING')`, which
   * consults the plan — but this one deliberately does not, because the switch
   * must stay reachable while the module is off. That exemption left a hole:
   * on a plan with `max_parking_slots: 0` the wizard answered 200 and reported
   * itself managed, while every screen it enables still 404'd. An admin would
   * have configured a rate, told their residents, and found nothing worked.
   *
   * Switching parking OFF is always allowed — a society whose plan lapsed must
   * still be able to stop billing for it.
   */
  if (input.manage) {
    const { limits } = await getEffectiveLimits(societyId);
    if (!planAllows(limits, 'max_parking_slots')) {
      throw new ParkingError('Parking is not part of your plan. Ask your ResiSmart contact to add it.', 402);
    }
  }

  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);

  // ---------------------------------------------------------- step 1: no
  //
  // "Parking will be hidden. Your slots and allocations are kept safely and come
  // back if you switch this on again." Nothing in this branch touches a zone, a
  // slot or an allocation — the module disappears from the menu and the API, and
  // the inventory is exactly where it was if they change their mind.
  if (!input.manage) {
    await deactivateParkingHeads(societyId, policy);
    policy.parking.chargeable = false;
    await setParkingModule(societyId, policy, false);
    policy.updatedBy = oid(actor.userId);
    policy.updatedByName = actor.userName;
    await policy.save();
    logger.info(`Society ${societyId}: parking switched off by ${actor.userName} — data kept, charge heads deactivated`);
    return readSettings(societyId, policy, false);
  }

  await setParkingModule(societyId, policy, true);

  // ---------------------------------------------------- step 2: free of charge
  //
  // Free still gives the society the whole module — slots, the map, allocations,
  // the waiting list. Many societies allot parking carefully and charge nothing
  // for it. The rate the society last entered is kept, so turning charging back
  // on does not mean typing it again.
  if (input.chargeable === false || input.chargeable === undefined) {
    await deactivateParkingHeads(societyId, policy);
    policy.parking.chargeable = false;
    policy.updatedBy = oid(actor.userId);
    policy.updatedByName = actor.userName;
    await policy.save();
    logger.info(`Society ${societyId}: parking is managed and free — charge heads deactivated by ${actor.userName}`);
    return readSettings(societyId, policy, true);
  }

  // --------------------------------------------- steps 3, 4 and 5: the money
  const perSlotPaise = Math.round(Number(input.perSlotPaise || 0));
  if (!(perSlotPaise > 0)) {
    throw new ParkingError('How much is one slot? Enter an amount, or say parking is free.');
  }
  if (perSlotPaise > MAX_SLOT_RATE_PAISE) {
    throw new ParkingError('That is more than ₹50,000 for one slot. Amounts are in paise — check the figure.');
  }

  const billingFrequency = input.billingFrequency === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
  // April, and only April, unless the society says otherwise — the start of the
  // Indian financial year, which is when most societies raise annual levies.
  const annualBillingMonth = billingFrequency === 'YEARLY'
    ? (input.annualBillingMonth ?? 4)
    : (policy.parking.annualBillingMonth ?? 4);
  if (annualBillingMonth < 1 || annualBillingMonth > 12) {
    throw new ParkingError('Which month do you raise it? Pick one of the twelve.');
  }

  const twoWheelerPaise = input.twoWheelerPaise === null || input.twoWheelerPaise === undefined
    ? undefined
    : Math.round(Number(input.twoWheelerPaise));
  if (twoWheelerPaise !== undefined && !(twoWheelerPaise >= 0 && twoWheelerPaise <= MAX_SLOT_RATE_PAISE)) {
    throw new ParkingError('That two-wheeler amount does not look right. Amounts are in paise.');
  }

  const car = await upsertParkingHead(societyId, {
    code: CAR_HEAD_CODE,
    name: 'Parking',
    quantityKey: CAR_QUANTITY_KEY,
    ratePaise: perSlotPaise,
    billingFrequency, annualBillingMonth,
    storedId: policy.parking.chargeHeadId,
  }, actor);

  /**
   * The two-wheeler head is maintained even when the society did NOT ask for a
   * separate bike rate, and that is not an oversight.
   *
   * `PER_QUANTITY` bills exactly one key of `Flat.quantities`, and this module
   * counts bike slots under `twoWheelerSlots` because a committee needs to see
   * them apart. Without a head reading that key a two-wheeler bay would be
   * allotted, shown on the map, counted in occupancy — and billed nothing at
   * all, silently. "Absent means two-wheelers are billed at the car rate" is
   * what the policy promises, so absent means a second head at the car rate.
   */
  const bike = await upsertParkingHead(societyId, {
    code: BIKE_HEAD_CODE,
    name: twoWheelerPaise === undefined ? 'Parking (two-wheeler)' : 'Two-wheeler parking',
    quantityKey: BIKE_QUANTITY_KEY,
    ratePaise: twoWheelerPaise === undefined ? perSlotPaise : twoWheelerPaise,
    billingFrequency, annualBillingMonth,
    storedId: policy.parking.twoWheelerChargeHeadId,
  }, actor);

  policy.parking.chargeable = true;
  policy.parking.billingFrequency = billingFrequency;
  policy.parking.annualBillingMonth = annualBillingMonth;
  policy.parking.perSlotPaise = perSlotPaise;
  // `.set()` rather than assignment: dropping the separate bike rate has to
  // actually REMOVE the field, or "no, the same as cars" would read back next
  // year as last year's separate rate and the screen would lie about the bill.
  policy.set('parking.twoWheelerPaise', twoWheelerPaise);
  // The ids are what make a re-run an EDIT. Without them the second run creates
  // a second head and every flat is billed twice for the same bay.
  policy.parking.chargeHeadId = car._id as mongoose.Types.ObjectId;
  policy.parking.twoWheelerChargeHeadId = bike._id as mongoose.Types.ObjectId;
  policy.updatedBy = oid(actor.userId);
  policy.updatedByName = actor.userName;
  await policy.save();

  logger.info(
    `Society ${societyId}: parking billed ${billingFrequency.toLowerCase()}`
    + `${billingFrequency === 'YEARLY' ? ` in month ${annualBillingMonth}` : ''}`
    + ` at ${perSlotPaise} paise per slot, set by ${actor.userName}`,
  );

  return {
    managed: true,
    chargeable: true,
    billingFrequency, annualBillingMonth, perSlotPaise, twoWheelerPaise,
    carHead: headSummary(car),
    bikeHead: headSummary(bike),
  };
}

/** The wizard's own answers, read back — what the settings screen opens on. */
export async function getParkingSettings(societyId: string): Promise<ParkingSettings> {
  const policy = await SocietyOpsPolicy.findOne({ societyId: oid(societyId) });
  if (!policy) {
    // No policy yet is not "off with a rate of zero" — it is a society that has
    // never been asked. The defaults below are the same ones the schema carries,
    // so the screen opens on step 1 rather than on an empty form.
    return { managed: false, chargeable: false, billingFrequency: 'MONTHLY', annualBillingMonth: 4, perSlotPaise: 0 };
  }
  const modules = await resolveOpsModules(societyId);
  return readSettings(societyId, policy, modules.includes('PARKING'));
}

async function readSettings(
  societyId: string, policy: ISocietyOpsPolicy, managed: boolean,
): Promise<ParkingSettings> {
  const ids = [policy.parking?.chargeHeadId, policy.parking?.twoWheelerChargeHeadId].filter(Boolean);
  const heads = ids.length
    ? await ChargeHead.find({ societyId: oid(societyId), _id: { $in: ids } })
    : [];
  const byId = new Map(heads.map(h => [String(h._id), h]));

  return {
    managed,
    chargeable: !!policy.parking?.chargeable,
    billingFrequency: policy.parking?.billingFrequency || 'MONTHLY',
    annualBillingMonth: policy.parking?.annualBillingMonth ?? 4,
    perSlotPaise: policy.parking?.perSlotPaise ?? 0,
    twoWheelerPaise: policy.parking?.twoWheelerPaise,
    carHead: headSummary(byId.get(String(policy.parking?.chargeHeadId))),
    bikeHead: headSummary(byId.get(String(policy.parking?.twoWheelerChargeHeadId))),
  };
}

// -------------------------------------------------------------------- zones

export interface ZoneInput {
  name: string;
  kind?: ParkingZoneKind;
  blockId?: string;
  levelIndex?: number;
  rows?: number;
  cols?: number;
  sortOrder?: number;
}

export async function createZone(societyId: string, input: ZoneInput, actor: Actor): Promise<IParkingZone> {
  const name = String(input.name || '').trim();
  if (!name) throw new ParkingError('Give the area a name — "Basement 1", "Open compound".');

  let blockName: string | undefined;
  if (input.blockId) {
    // Checked rather than trusted: a zone scoped to a wing that belongs to
    // another society would put that society's name on this society's map.
    const flat = await Flat.findOne({ societyId: oid(societyId), blockId: oid(input.blockId) })
      .select('blockName').lean();
    if (!flat) throw new ParkingError('That wing does not belong to this society.');
    blockName = flat.blockName;
  }

  try {
    return await ParkingZone.create({
      societyId: oid(societyId),
      name,
      kind: input.kind || 'BASEMENT',
      blockId: input.blockId ? oid(input.blockId) : undefined,
      blockName,
      levelIndex: input.levelIndex ?? 0,
      layout: { rows: input.rows ?? 10, cols: input.cols ?? 10 },
      sortOrder: input.sortOrder ?? 0,
      isActive: true,
      createdBy: oid(actor.userId), createdByName: actor.userName,
      updatedBy: oid(actor.userId), updatedByName: actor.userName,
    });
  } catch (e: any) {
    if (isDuplicate(e)) throw new ParkingError(`You already have an area called "${name}".`, 409);
    throw e;
  }
}

export async function listZones(societyId: string, includeRetired = false) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (!includeRetired) filter.isActive = true;
  return ParkingZone.find(filter).sort({ sortOrder: 1, levelIndex: 1, name: 1 }).lean();
}

export async function updateZone(
  societyId: string, id: string, input: Partial<ZoneInput> & { isActive?: boolean }, actor: Actor,
): Promise<IParkingZone> {
  const zone = await ParkingZone.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!zone) throw new ParkingError('That parking area could not be found.', 404);

  if (input.name !== undefined) zone.name = String(input.name).trim();
  if (input.kind !== undefined) zone.kind = input.kind;
  if (input.levelIndex !== undefined) zone.levelIndex = input.levelIndex;
  if (input.sortOrder !== undefined) zone.sortOrder = input.sortOrder;
  if (input.rows !== undefined || input.cols !== undefined) {
    const rows = input.rows ?? zone.layout.rows;
    const cols = input.cols ?? zone.layout.cols;
    // Shrinking a grid below the slots already drawn on it would hide them
    // rather than delete them, which is worse: the slot still bills, still
    // shows in the allocation list, and simply cannot be found on the map.
    const outside = await ParkingSlot.countDocuments({
      zoneId: zone._id, isActive: true, $or: [{ row: { $gt: rows } }, { col: { $gt: cols } }],
    });
    if (outside) {
      throw new ParkingError(
        `${outside} slot${outside > 1 ? 's are' : ' is'} outside a ${rows} × ${cols} grid. Move or retire them first.`,
      );
    }
    zone.layout = { rows, cols };
  }
  if (input.isActive !== undefined) {
    if (input.isActive === false) {
      const held = await ParkingAllocation.countDocuments({
        societyId: oid(societyId), zoneId: zone._id, status: 'ACTIVE',
      });
      if (held) throw new ParkingError(`${held} slot${held > 1 ? 's are' : ' is'} still allotted here. Release them first.`, 409);
    }
    zone.isActive = input.isActive;
  }

  zone.updatedBy = oid(actor.userId);
  zone.updatedByName = actor.userName;
  try {
    await zone.save();
  } catch (e: any) {
    if (isDuplicate(e)) throw new ParkingError('You already have an area with that name.', 409);
    throw e;
  }
  return zone;
}

// -------------------------------------------------------------------- slots

export interface BulkSlotInput {
  zoneId: string;
  /** "B1-" → B1-01, B1-02… */
  prefix: string;
  startNumber?: number;
  count: number;
  /** Pad the number so codes sort as a human reads them. B1-09 before B1-10. */
  padTo?: number;
  /** Where on the grid the block of slots begins. */
  startRow?: number;
  startCol?: number;
  /** How many slots per row before wrapping. Defaults to the zone's width. */
  perRow?: number;
  vehicleKind?: SlotVehicleKind;
  size?: SlotSize;
  isAccessible?: boolean;
  hasEvCharger?: boolean;
}

/** Anything above this is a typo, not a basement. Two zones if it truly is one. */
const MAX_BULK_SLOTS = 500;

/**
 * Generate a whole level in one step.
 *
 * Nobody will hand-create 200 slots, and a module that asks them to is a module
 * that never gets its inventory filled in — which is precisely how the free-text
 * slot label survived this long. The wizard is therefore not a convenience; it
 * is the thing that makes the rest of the module reachable.
 *
 * Clashes are checked BEFORE writing and reported by code, not swallowed. A
 * partial run that created 140 of 200 slots and failed would leave a society
 * unable to re-run it and unable to tell what is missing.
 */
export async function bulkCreateSlots(
  societyId: string, input: BulkSlotInput, actor: Actor,
): Promise<{ created: number; codes: string[] }> {
  const zone = await ParkingZone.findOne({ _id: oid(input.zoneId), societyId: oid(societyId), isActive: true }).lean();
  if (!zone) throw new ParkingError('That parking area could not be found.', 404);

  const count = Number(input.count || 0);
  if (count < 1) throw new ParkingError('How many slots? Enter at least one.');
  if (count > MAX_BULK_SLOTS) {
    throw new ParkingError(`${count} slots in one go is more than any single level holds. Do up to ${MAX_BULK_SLOTS} at a time.`);
  }

  const prefix = String(input.prefix || '').trim().toUpperCase();
  if (!prefix) throw new ParkingError('What do the slots start with? "B1-", "S-", "P".');

  const startNumber = input.startNumber ?? 1;
  const padTo = input.padTo ?? String(startNumber + count - 1).length;
  const perRow = Math.max(1, Math.min(input.perRow ?? zone.layout.cols, zone.layout.cols));
  const startRow = Math.max(1, input.startRow ?? 1);
  const startCol = Math.max(1, input.startCol ?? 1);

  const planned = Array.from({ length: count }, (_, i) => {
    const offset = (startCol - 1) + i;
    return {
      code: `${prefix}${String(startNumber + i).padStart(padTo, '0')}`,
      row: startRow + Math.floor(offset / perRow),
      col: (offset % perRow) + 1,
    };
  });

  const overflow = planned.filter(p => p.row > zone.layout.rows || p.col > zone.layout.cols);
  if (overflow.length) {
    throw new ParkingError(
      `That many slots does not fit in a ${zone.layout.rows} × ${zone.layout.cols} grid. Make the area bigger, or create fewer.`,
    );
  }

  const codes = planned.map(p => p.code);
  const clashes = await ParkingSlot.find(
    { societyId: oid(societyId), isActive: true, code: { $in: codes } }, { code: 1 },
  ).lean();
  if (clashes.length) {
    const shown = clashes.slice(0, 5).map(c => c.code).join(', ');
    throw new ParkingError(
      `${clashes.length} of these already exist (${shown}${clashes.length > 5 ? '…' : ''}). Start the numbering after them.`,
      409,
    );
  }

  const occupied = await ParkingSlot.find(
    { zoneId: zone._id, isActive: true, row: { $gte: startRow } }, { row: 1, col: 1 },
  ).lean();
  const taken = new Set(occupied.map(s => `${s.row}:${s.col}`));
  const overlap = planned.filter(p => taken.has(`${p.row}:${p.col}`));
  if (overlap.length) {
    throw new ParkingError(
      `${overlap.length} of those positions already have a slot on them. Start from a lower row, or a different column.`,
      409,
    );
  }

  const docs = planned.map(p => ({
    societyId: oid(societyId),
    zoneId: zone._id,
    zoneName: zone.name,
    code: p.code, row: p.row, col: p.col,
    vehicleKind: input.vehicleKind || 'CAR',
    size: input.size || 'STANDARD',
    isAccessible: !!input.isAccessible,
    hasEvCharger: !!input.hasEvCharger,
    status: 'AVAILABLE' as SlotStatus,
    isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  }));

  try {
    await ParkingSlot.insertMany(docs, { ordered: true });
  } catch (e: any) {
    // Two wizards run at the same moment. The pre-check above cannot see the
    // other one's writes; the unique index can.
    if (isDuplicate(e)) throw new ParkingError('Somebody created some of those slots a moment ago. Reload and try again.', 409);
    throw e;
  }

  logger.info(`Society ${societyId}: ${docs.length} parking slots created in ${zone.name} by ${actor.userName}`);
  return { created: docs.length, codes };
}

export async function listSlots(
  societyId: string, filters: { zoneId?: string; status?: SlotStatus; includeRetired?: boolean } = {},
) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (!filters.includeRetired) filter.isActive = true;
  if (filters.zoneId) filter.zoneId = oid(filters.zoneId);
  if (filters.status) filter.status = filters.status;
  return ParkingSlot.find(filter).sort({ zoneName: 1, row: 1, col: 1 }).limit(2000).lean();
}

export interface SlotUpdateInput {
  status?: SlotStatus;
  vehicleKind?: SlotVehicleKind;
  size?: SlotSize;
  isAccessible?: boolean;
  hasEvCharger?: boolean;
  code?: string;
  isActive?: boolean;
}

export async function updateSlot(
  societyId: string, id: string, input: SlotUpdateInput, actor: Actor,
): Promise<IParkingSlot> {
  const slot = await ParkingSlot.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!slot) throw new ParkingError('That slot could not be found.', 404);

  const held = await ParkingAllocation.exists({
    societyId: oid(societyId), slotId: slot._id, status: 'ACTIVE',
  });

  if (input.vehicleKind !== undefined && input.vehicleKind !== slot.vehicleKind && held) {
    // The allocation copied this kind when it was made, and the flat is being
    // billed a car rate or a bike rate because of it. Changing the slot under a
    // live allocation would silently make the bill and the map disagree — the
    // exact drift this module exists to end. Release, change, re-allot.
    throw new ParkingError('This slot is allotted. Release it before changing what it takes — the flat is billed on that.', 409);
  }

  if (input.status !== undefined) {
    // ALLOCATED is a consequence, never a choice. Letting it be set by hand
    // makes the map claim a holder the allocation collection has never heard
    // of, and nothing bills for it.
    if (input.status === 'ALLOCATED') {
      throw new ParkingError('Allot the slot to a flat instead — the map follows the allocation, not the other way round.');
    }
    if (held && input.status !== slot.status) {
      throw new ParkingError('This slot is allotted. Release it first.', 409);
    }
    slot.status = input.status;
  }

  if (input.vehicleKind !== undefined) slot.vehicleKind = input.vehicleKind;
  if (input.size !== undefined) slot.size = input.size;
  if (input.isAccessible !== undefined) slot.isAccessible = input.isAccessible;
  if (input.hasEvCharger !== undefined) slot.hasEvCharger = input.hasEvCharger;
  if (input.code !== undefined) slot.code = String(input.code).trim().toUpperCase();
  if (input.isActive === false) {
    if (held) throw new ParkingError('This slot is allotted. Release it before retiring it.', 409);
    slot.isActive = false;
    slot.status = 'OUT_OF_SERVICE';
  } else if (input.isActive === true) {
    slot.isActive = true;
  }

  slot.updatedBy = oid(actor.userId);
  slot.updatedByName = actor.userName;
  try {
    await slot.save();
  } catch (e: any) {
    if (isDuplicate(e)) throw new ParkingError('Another slot already uses that code.', 409);
    throw e;
  }
  return slot;
}

// -------------------------------------------------------------- allocations

export interface AllocateInput {
  slotId: string;
  flatId: string;
  vehicleId?: string;
  kind?: AllocationKind;
  chargeable?: boolean;
  startDate?: Date | string;
}

/**
 * The shared body of every allocation — direct, from the waiting list, or the
 * second half of a transfer.
 *
 * Takes a session rather than opening one, because a request approved into a
 * slot has to be one atomic act: nesting `withTransaction` calls would let the
 * request be marked APPROVED against an allocation that then rolled back.
 */
async function allocateWithin(
  societyId: string, input: AllocateInput, actor: Actor, session: ClientSession,
): Promise<IParkingAllocation> {
  const slot = await ParkingSlot.findOne({
    _id: oid(input.slotId), societyId: oid(societyId), isActive: true,
  }).session(session);
  if (!slot) throw new ParkingError('That slot could not be found.', 404);
  if (slot.status === 'BLOCKED' || slot.status === 'OUT_OF_SERVICE') {
    throw new ParkingError(`${slot.code} is marked out of use. Put it back in service first.`, 409);
  }

  const flat = await Flat.findOne({ _id: oid(input.flatId), societyId: oid(societyId) })
    .select('number blockName blockId').session(session).lean();
  if (!flat) throw new ParkingError('That flat could not be found.', 404);

  let vehicleId: mongoose.Types.ObjectId | undefined;
  if (input.vehicleId) {
    // Scoped to the flat as well as the society. Attaching a neighbour's car to
    // this allocation would put their plate on this flat's slot popover, which
    // is the "whose car is this?" lookup the gate module already refuses.
    const vehicle = await ResidentVehicle.findOne({
      _id: oid(input.vehicleId), societyId: oid(societyId), flatId: flat._id, isActive: true,
    }).select('_id').session(session).lean();
    if (!vehicle) throw new ParkingError('That vehicle is not registered to this flat.');
    vehicleId = vehicle._id as mongoose.Types.ObjectId;
  }

  let allocation: IParkingAllocation;
  try {
    const [created] = await ParkingAllocation.create([{
      societyId: oid(societyId),
      slotId: slot._id, slotCode: slot.code, zoneId: slot.zoneId, slotKind: slot.vehicleKind,
      flatId: flat._id, flatLabel: labelOf(flat), blockId: flat.blockId,
      vehicleId,
      kind: input.kind || 'PERMANENT',
      startDate: input.startDate ? new Date(input.startDate) : new Date(),
      status: 'ACTIVE',
      chargeable: input.chargeable !== false,
      allocatedBy: oid(actor.userId), allocatedByName: actor.userName,
      createdBy: oid(actor.userId), createdByName: actor.userName,
      updatedBy: oid(actor.userId), updatedByName: actor.userName,
    }], { session });
    allocation = created;
  } catch (e: any) {
    // The partial unique index refusing a second live allocation. This is the
    // race being caught, not a validation failure — say what happened.
    if (isDuplicate(e)) throw new ParkingError(`${slot.code} is already allotted to another flat.`, 409);
    throw e;
  }

  await ParkingSlot.updateOne(
    { _id: slot._id },
    {
      $set: {
        status: 'ALLOCATED', currentAllocationId: allocation._id,
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      },
    },
  ).session(session);

  if (vehicleId) {
    // `parkingSlot` is kept in step as the display caption every existing gate
    // screen already reads. See the note on the model.
    await ResidentVehicle.updateOne(
      { _id: vehicleId },
      { $set: { slotId: slot._id, parkingSlot: slot.code } },
    ).session(session);
  }

  await syncFlatBilling(societyId, flat._id, session);
  return allocation;
}

export async function allocate(
  societyId: string, input: AllocateInput, actor: Actor,
): Promise<IParkingAllocation> {
  const session = await mongoose.startSession();
  try {
    let out!: IParkingAllocation;
    await session.withTransaction(async () => {
      out = await allocateWithin(societyId, input, actor, session);
    });
    logger.info(`Society ${societyId}: ${out.slotCode} allotted to ${out.flatLabel} by ${actor.userName}`);
    return out;
  } finally {
    await session.endSession();
  }
}

/**
 * The other half, and the half that used to be free.
 *
 * Ending never deletes: the row stays, stamped with when and why, because "that
 * slot was ours until 2023" is a claim the software has to be able to settle.
 * The billing recompute is in the same transaction for the same reason as on
 * allocate — a release that succeeds while the bill still says two is the
 * failure everybody currently has.
 */
export async function release(
  societyId: string, allocationId: string, reason: string | undefined, actor: Actor,
): Promise<{ allocation: IParkingAllocation; billed: BilledCounts }> {
  const session = await mongoose.startSession();
  try {
    let out!: { allocation: IParkingAllocation; billed: BilledCounts };
    await session.withTransaction(async () => {
      const allocation = await ParkingAllocation.findOne({
        _id: oid(allocationId), societyId: oid(societyId), status: 'ACTIVE',
      }).session(session);
      if (!allocation) throw new ParkingError('That allocation could not be found, or it has already ended.', 404);

      allocation.status = 'ENDED';
      allocation.endDate = new Date();
      allocation.endReason = reason?.trim();
      allocation.endedBy = oid(actor.userId);
      allocation.endedByName = actor.userName;
      allocation.updatedBy = oid(actor.userId);
      allocation.updatedByName = actor.userName;
      await allocation.save({ session });

      // Only a slot that was ALLOCATED goes back to AVAILABLE. One somebody
      // marked BLOCKED while it was held must stay blocked — releasing the
      // holder is not the same as saying the pillar has been removed.
      await ParkingSlot.updateOne(
        { _id: allocation.slotId, status: 'ALLOCATED' },
        {
          $set: { status: 'AVAILABLE', updatedBy: oid(actor.userId), updatedByName: actor.userName },
          $unset: { currentAllocationId: '' },
        },
      ).session(session);
      await ParkingSlot.updateOne(
        { _id: allocation.slotId, status: { $ne: 'ALLOCATED' } },
        { $unset: { currentAllocationId: '' } },
      ).session(session);

      // Scoped to slots pointing HERE. A resident who was re-allotted elsewhere
      // in the meantime must not have their new slot wiped by an old release.
      await ResidentVehicle.updateMany(
        { societyId: oid(societyId), slotId: allocation.slotId },
        { $unset: { slotId: '', parkingSlot: '' } },
      ).session(session);

      const billed = await syncFlatBilling(societyId, allocation.flatId, session);
      out = { allocation, billed };
    });
    return out;
  } finally {
    await session.endSession();
  }
}

export interface TransferInput {
  toFlatId?: string;
  toSlotId?: string;
  vehicleId?: string;
  reason?: string;
  chargeable?: boolean;
}

/**
 * Move a slot to another flat, or a flat to another slot.
 *
 * Two rows, never an edit. Changing `flatId` in place would be one line and
 * would erase the fact that 102 held B1-14 for three years — and with it the
 * only explanation for three years of parking charges on 102's ledger.
 *
 * Both flats are recomputed, which is the bit an in-place edit would also have
 * got wrong: the flat losing the slot stops being billed for it in the same
 * transaction the flat gaining it starts.
 */
export async function transfer(
  societyId: string, allocationId: string, input: TransferInput, actor: Actor,
): Promise<IParkingAllocation> {
  if (!input.toFlatId && !input.toSlotId) {
    throw new ParkingError('Say what is moving — to which flat, or to which slot.');
  }

  const session = await mongoose.startSession();
  try {
    let out!: IParkingAllocation;
    await session.withTransaction(async () => {
      const current = await ParkingAllocation.findOne({
        _id: oid(allocationId), societyId: oid(societyId), status: 'ACTIVE',
      }).session(session);
      if (!current) throw new ParkingError('That allocation could not be found, or it has already ended.', 404);

      const fromFlatId = current.flatId;

      current.status = 'ENDED';
      current.endDate = new Date();
      current.endReason = input.reason?.trim() || 'Transferred';
      current.endedBy = oid(actor.userId);
      current.endedByName = actor.userName;
      current.updatedBy = oid(actor.userId);
      current.updatedByName = actor.userName;
      await current.save({ session });

      // Freed FIRST, in the same transaction, so the new allocation can take
      // the same slot without the unique index seeing two live rows on it.
      await ParkingSlot.updateOne(
        { _id: current.slotId },
        { $set: { status: 'AVAILABLE' }, $unset: { currentAllocationId: '' } },
      ).session(session);
      await ResidentVehicle.updateMany(
        { societyId: oid(societyId), slotId: current.slotId },
        { $unset: { slotId: '', parkingSlot: '' } },
      ).session(session);

      out = await allocateWithin(societyId, {
        slotId: String(input.toSlotId || current.slotId),
        flatId: String(input.toFlatId || current.flatId),
        vehicleId: input.vehicleId,
        kind: current.kind,
        chargeable: input.chargeable ?? current.chargeable,
      }, actor, session);

      // The flat that gave it up. `allocateWithin` has already recomputed the
      // one that received it; doing this unconditionally would be harmless but
      // reads as though the two were the same act, and they are not.
      if (String(fromFlatId) !== String(out.flatId)) {
        await syncFlatBilling(societyId, fromFlatId, session);
      }
    });
    return out;
  } finally {
    await session.endSession();
  }
}

/**
 * End everything a flat holds, in one transaction.
 *
 * **`flat-lifecycle.service.ts` should call this** when a flat is sold and its
 * allocations are not being transferred, and when a tenancy ends. That hook is
 * not wired here on purpose — the lifecycle service owns the FlatEvent timeline
 * and the ordering of everything else that happens on a sale, and a parking
 * module reaching into it would put the same decision in two files.
 *
 * `societyId` is a parameter rather than being read from the flat, because
 * every other query in this file is society-scoped and a helper that takes a
 * bare id is exactly where a cross-society write eventually slips in.
 */
export async function releaseAllocationsForFlat(
  societyId: string, flatId: string, reason: string, actor?: Actor,
  opts: { session?: mongoose.ClientSession } = {},
): Promise<{ released: number; billed: BilledCounts }> {
  /**
   * The body, run against whichever session is in charge.
   *
   * Split out because a sale is ONE transaction. `flat-lifecycle` already holds
   * a session open across the ownership change, the tenure close and the
   * FlatEvent it writes; if this opened its own, MongoDB would reject the
   * nesting — and had it somehow succeeded it would have been worse, because a
   * lifecycle rollback would have left the bays released and the sale undone.
   * Called on its own, it still opens and owns a transaction as before.
   */
  const body = async (session: mongoose.ClientSession) => {
    const live = await ParkingAllocation.find({
      societyId: oid(societyId), flatId: oid(flatId), status: 'ACTIVE',
    }).session(session);

    for (const allocation of live) {
      allocation.status = 'ENDED';
      allocation.endDate = new Date();
      allocation.endReason = reason;
      if (actor) {
        allocation.endedBy = oid(actor.userId);
        allocation.endedByName = actor.userName;
        allocation.updatedBy = oid(actor.userId);
        allocation.updatedByName = actor.userName;
      }
      await allocation.save({ session });
    }

    const slotIds = live.map(a => a.slotId);
    if (slotIds.length) {
      await ParkingSlot.updateMany(
        { _id: { $in: slotIds }, status: 'ALLOCATED' },
        { $set: { status: 'AVAILABLE' }, $unset: { currentAllocationId: '' } },
      ).session(session);
      await ResidentVehicle.updateMany(
        { societyId: oid(societyId), slotId: { $in: slotIds } },
        { $unset: { slotId: '', parkingSlot: '' } },
      ).session(session);
    }

    const billed = await syncFlatBilling(societyId, flatId, session);
    return { released: live.length, billed };
  };

  const announce = (out: { released: number }) => {
    if (out.released) {
      logger.info(`Society ${societyId}: released ${out.released} parking allocation(s) for flat ${flatId} — ${reason}`);
    }
  };

  // A caller already inside a transaction hands us theirs; we join it.
  if (opts.session) {
    const out = await body(opts.session);
    announce(out);
    return out;
  }

  const session = await mongoose.startSession();
  try {
    let out!: { released: number; billed: BilledCounts };
    await session.withTransaction(async () => { out = await body(session); });
    announce(out);
    return out;
  } finally {
    await session.endSession();
  }
}

export async function listAllocations(
  societyId: string,
  filters: { flatId?: string; zoneId?: string; status?: 'ACTIVE' | 'ENDED'; blockIds?: string[] } = {},
) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (filters.flatId) filter.flatId = oid(filters.flatId);
  if (filters.zoneId) filter.zoneId = oid(filters.zoneId);
  if (filters.status) filter.status = filters.status;
  if (filters.blockIds) {
    // A wing-scoped committee member. Rows with no wing stay visible, matching
    // `allowsBlock`: "A and B wing" has never meant "nothing society-wide".
    filter.$or = [
      { blockId: { $in: filters.blockIds.map(oid) } },
      { blockId: { $exists: false } },
      { blockId: null },
    ];
  }
  return ParkingAllocation.find(filter).sort({ status: 1, startDate: -1 }).limit(2000).lean();
}

// ---------------------------------------------------------------------- map

export interface MapOptions {
  /** PARKING_VIEW. Without it the map is free/taken and nothing else. */
  detailed?: boolean;
  /** The caller's own flats — they always see their own slot in full. */
  ownFlatIds?: string[];
}

export interface MapSlot {
  _id: string;
  code: string;
  row: number;
  col: number;
  vehicleKind: SlotVehicleKind;
  size: SlotSize;
  isAccessible: boolean;
  hasEvCharger: boolean;
  status: SlotStatus;
  isMine: boolean;
  holder?: {
    allocationId: string;
    flatLabel?: string;
    residentName?: string;
    plate?: string;
    /** "White Maruti" — how a person standing next to the car recognises it. */
    vehicleDescription?: string;
    since: Date;
    kind: AllocationKind;
    chargeable: boolean;
  };
}

/**
 * One zone, drawn.
 *
 * The privacy rule is enforced HERE rather than in the controller, because the
 * map is the one screen in the product that would otherwise hand every resident
 * a directory of who owns which car. A resident gets colours; somebody holding
 * PARKING_VIEW gets the names. The only thing a resident sees in full is their
 * own flat's slot, which is theirs to know.
 */
export async function listMap(
  societyId: string, zoneId: string, opts: MapOptions = {},
): Promise<{ zone: any; slots: MapSlot[] }> {
  const zone = await ParkingZone.findOne({ _id: oid(zoneId), societyId: oid(societyId) }).lean();
  if (!zone) throw new ParkingError('That parking area could not be found.', 404);

  const slots = await ParkingSlot.find({ societyId: oid(societyId), zoneId: zone._id, isActive: true })
    .sort({ row: 1, col: 1 }).lean();

  const live = await ParkingAllocation.find(
    { societyId: oid(societyId), zoneId: zone._id, status: 'ACTIVE' },
  ).lean();
  const bySlot = new Map(live.map(a => [String(a.slotId), a]));

  const mine = new Set((opts.ownFlatIds || []).map(String));

  // Names and plates are fetched only when somebody is entitled to read them.
  // Fetching them regardless and filtering on the way out is how they end up in
  // a log line, an error payload or the next person's `res.json(rows)`.
  const needsDetail = opts.detailed || mine.size > 0;
  const flatIds = needsDetail ? [...new Set(live.map(a => String(a.flatId)))] : [];
  const [residents, vehicles] = needsDetail && flatIds.length
    ? await Promise.all([
      Resident.find(
        { societyId: oid(societyId), flatId: { $in: flatIds.map(oid) }, isActive: true },
        { flatId: 1, 'person.name': 1 },
      ).lean(),
      ResidentVehicle.find(
        { societyId: oid(societyId), slotId: { $in: slots.map(s => s._id) }, isActive: true },
        // Make and colour too: a guard or manager looking at the map is usually
        // trying to match a bay to a car they are standing next to, and "white
        // Maruti" identifies it faster than a plate read at an angle. Carried
        // under the same `detailed` gate as the plate — a resident still sees
        // occupied-or-free and nothing about whose car it is.
        { slotId: 1, displayNumber: 1, make: 1, colour: 1 },
      ).lean(),
    ])
    : [[], []];

  const nameOfFlat = new Map<string, string>();
  for (const r of residents as any[]) {
    if (!nameOfFlat.has(String(r.flatId))) nameOfFlat.set(String(r.flatId), r.person?.name || '');
  }
  const plateOfSlot = new Map((vehicles as any[]).map(v => [String(v.slotId), v.displayNumber]));
  const carOfSlot = new Map((vehicles as any[]).map(v => [
    String(v.slotId),
    [v.colour, v.make].filter(Boolean).join(' ') || undefined,
  ]));

  const rows: MapSlot[] = slots.map(s => {
    const allocation = bySlot.get(String(s._id));
    const isMine = !!allocation && mine.has(String(allocation.flatId));
    const base: MapSlot = {
      _id: String(s._id),
      code: s.code, row: s.row, col: s.col,
      vehicleKind: s.vehicleKind, size: s.size,
      isAccessible: s.isAccessible, hasEvCharger: s.hasEvCharger,
      status: s.status,
      isMine,
    };
    if (!allocation || (!opts.detailed && !isMine)) return base;
    return {
      ...base,
      holder: {
        allocationId: String(allocation._id),
        flatLabel: allocation.flatLabel,
        residentName: nameOfFlat.get(String(allocation.flatId)) || undefined,
        plate: plateOfSlot.get(String(s._id)),
        vehicleDescription: carOfSlot.get(String(s._id)),
        since: allocation.startDate,
        kind: allocation.kind,
        chargeable: allocation.chargeable,
      },
    };
  });

  return { zone, slots: rows };
}

/** A resident's own slots — the whole of what `parkingViewOwn` offers. */
export async function myAllocations(societyId: string, userId: string) {
  const homes = await Resident.find(
    { societyId: oid(societyId), userId: oid(userId), isActive: true }, { flatId: 1 },
  ).lean();
  if (!homes.length) return { flatIds: [], active: [], history: [] };

  const flatIds = homes.map(h => h.flatId);
  const rows = await ParkingAllocation.find({ societyId: oid(societyId), flatId: { $in: flatIds } })
    .sort({ status: 1, startDate: -1 }).limit(200).lean();

  return {
    flatIds: flatIds.map(String),
    active: rows.filter(r => r.status === 'ACTIVE'),
    history: rows.filter(r => r.status === 'ENDED'),
  };
}

// ----------------------------------------------------------------- requests

/** A resident may only queue for their own flat. Mirrors `gate-depth`. */
async function assertLivesThere(societyId: string, flatId: any, actor: Actor, opts: ParkingActorOpts) {
  if (opts.onBehalf) return;
  const lives = await Resident.exists({
    societyId: oid(societyId), flatId, userId: oid(actor.userId), isActive: true,
  });
  if (!lives) {
    throw new ParkingError('That flat is not yours. Only the society office can ask for a slot on another flat.', 403);
  }
}

export interface RequestInput {
  flatId: string;
  vehicleKind?: SlotVehicleKind;
  note?: string;
}

export async function raiseRequest(
  societyId: string, input: RequestInput, actor: Actor, opts: ParkingActorOpts = {},
): Promise<IParkingRequest> {
  const flat = await Flat.findOne({ _id: oid(input.flatId), societyId: oid(societyId) })
    .select('number blockName blockId').lean();
  if (!flat) throw new ParkingError('That flat could not be found.', 404);

  await assertLivesThere(societyId, flat._id, actor, opts);

  const vehicleKind = input.vehicleKind || 'CAR';
  // One pending ask per flat per kind. Without this a resident who reloads the
  // form joins the queue twice, and a queue whose order can be gamed by asking
  // repeatedly is worse than the register it replaced.
  const already = await ParkingRequest.findOne({
    societyId: oid(societyId), flatId: flat._id, vehicleKind, status: 'PENDING',
  }).lean();
  if (already) {
    throw new ParkingError('You are already on the waiting list for this. The committee will come back to you.', 409);
  }

  return ParkingRequest.create({
    societyId: oid(societyId),
    flatId: flat._id, flatLabel: labelOf(flat), blockId: flat.blockId,
    requestedByUserId: oid(actor.userId), requestedByName: actor.userName,
    vehicleKind, note: input.note?.trim(),
    status: 'PENDING', queuedAt: new Date(),
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function listRequests(
  societyId: string, filters: { status?: string; flatId?: string; blockIds?: string[] } = {},
) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (filters.status) filter.status = filters.status;
  if (filters.flatId) filter.flatId = oid(filters.flatId);
  if (filters.blockIds) {
    filter.$or = [
      { blockId: { $in: filters.blockIds.map(oid) } },
      { blockId: { $exists: false } },
      { blockId: null },
    ];
  }
  // Oldest first. See the index comment: any other order invites serving the
  // loudest rather than the earliest.
  return ParkingRequest.find(filter).sort({ status: 1, queuedAt: 1 }).limit(1000).lean();
}

export interface DecisionInput {
  decision: 'APPROVE' | 'REJECT';
  slotId?: string;
  note?: string;
  chargeable?: boolean;
  vehicleId?: string;
}

/**
 * Approve into a slot, or turn it down with a reason.
 *
 * Approving allots in the SAME transaction as the decision. Two steps would
 * mean a request marked approved with no slot behind it — which is how a
 * resident ends up told they have parking, by software, and finds somebody
 * else's car in it.
 */
export async function decideRequest(
  societyId: string, id: string, input: DecisionInput, actor: Actor,
): Promise<IParkingRequest> {
  if (input.decision === 'APPROVE' && !input.slotId) {
    throw new ParkingError('Pick the slot you are giving them.');
  }

  const session = await mongoose.startSession();
  try {
    let out!: IParkingRequest;
    await session.withTransaction(async () => {
      const req = await ParkingRequest.findOne({
        _id: oid(id), societyId: oid(societyId), status: 'PENDING',
      }).session(session);
      if (!req) throw new ParkingError('That request could not be found, or it has already been decided.', 404);

      if (input.decision === 'APPROVE') {
        const allocation = await allocateWithin(societyId, {
          slotId: String(input.slotId),
          flatId: String(req.flatId),
          vehicleId: input.vehicleId,
          chargeable: input.chargeable,
        }, actor, session);
        req.status = 'APPROVED';
        req.allocationId = allocation._id as mongoose.Types.ObjectId;
      } else {
        if (!input.note?.trim()) throw new ParkingError('Say why. The resident is told this, and "no" on its own is what starts arguments.');
        req.status = 'REJECTED';
      }

      req.decidedBy = oid(actor.userId);
      req.decidedByName = actor.userName;
      req.decidedAt = new Date();
      req.decisionNote = input.note?.trim();
      req.updatedBy = oid(actor.userId);
      req.updatedByName = actor.userName;
      await req.save({ session });
      out = req;
    });
    return out;
  } finally {
    await session.endSession();
  }
}

export async function withdrawRequest(
  societyId: string, id: string, actor: Actor, opts: ParkingActorOpts = {},
): Promise<IParkingRequest> {
  const req = await ParkingRequest.findOne({
    _id: oid(id), societyId: oid(societyId), status: 'PENDING',
  });
  if (!req) throw new ParkingError('That request could not be found, or it has already been decided.', 404);

  await assertLivesThere(societyId, req.flatId, actor, opts);

  req.status = 'WITHDRAWN';
  req.decidedAt = new Date();
  req.updatedBy = oid(actor.userId);
  req.updatedByName = actor.userName;
  await req.save();
  return req;
}

// ------------------------------------------------------------------ reports

export interface ReconciliationRow {
  flatId: string;
  flatLabel: string;
  billedCars: number;
  allocatedCars: number;
  billedBikes: number;
  allocatedBikes: number;
}

/**
 * Where the bill and the map disagree.
 *
 * On day one this finds real money in every society that has been running on a
 * spreadsheet — a flat billed for one slot holding two, or billed for two
 * having given one back years ago. It reads `Flat.quantities` exactly as
 * `invoicing.service` does, so a row here is a rupee difference on the next
 * invoice and not a modelling curiosity.
 *
 * It reports and does not fix. A report a committee reads and acts on is worth
 * more than a silent correction that changes somebody's bill with no
 * explanation anybody can produce afterwards.
 */
export async function reconcile(societyId: string): Promise<{
  mismatches: ReconciliationRow[];
  flatsChecked: number;
  slotsAllotted: number;
}> {
  const sid = oid(societyId);

  const [flats, live] = await Promise.all([
    Flat.find({ societyId: sid }, { number: 1, blockName: 1, quantities: 1 }).lean(),
    ParkingAllocation.find(
      { societyId: sid, status: 'ACTIVE', chargeable: true }, { flatId: 1, slotKind: 1 },
    ).lean(),
  ]);

  const allocated = new Map<string, BilledCounts>();
  for (const a of live) {
    const key = String(a.flatId);
    const row = allocated.get(key) || { cars: 0, bikes: 0 };
    if (quantityKeyFor(a.slotKind as SlotVehicleKind) === BIKE_QUANTITY_KEY) row.bikes++;
    else row.cars++;
    allocated.set(key, row);
  }

  const mismatches: ReconciliationRow[] = [];
  for (const flat of flats as any[]) {
    // `quantities` is a Map on the schema and a plain object once `.lean()` has
    // been through it — read both ways rather than trusting either.
    const q = flat.quantities instanceof Map
      ? Object.fromEntries(flat.quantities)
      : (flat.quantities || {});
    const billedCars = Number(q[CAR_QUANTITY_KEY] || 0);
    const billedBikes = Number(q[BIKE_QUANTITY_KEY] || 0);
    const held = allocated.get(String(flat._id)) || { cars: 0, bikes: 0 };

    if (billedCars !== held.cars || billedBikes !== held.bikes) {
      mismatches.push({
        flatId: String(flat._id),
        flatLabel: labelOf(flat),
        billedCars, allocatedCars: held.cars,
        billedBikes, allocatedBikes: held.bikes,
      });
    }
  }

  return { mismatches, flatsChecked: flats.length, slotsAllotted: live.length };
}

/** How full the place is, by zone — the number a committee opens the page for. */
export async function occupancyReport(societyId: string) {
  const sid = oid(societyId);
  const [zones, slots, flats, allocatedFlats] = await Promise.all([
    ParkingZone.find({ societyId: sid, isActive: true }).sort({ sortOrder: 1, levelIndex: 1 }).lean(),
    ParkingSlot.find({ societyId: sid, isActive: true }, { zoneId: 1, status: 1, vehicleKind: 1 }).lean(),
    Flat.countDocuments({ societyId: sid }),
    ParkingAllocation.distinct('flatId', { societyId: sid, status: 'ACTIVE' }),
  ]);

  const byZone = zones.map(z => {
    const own = slots.filter(s => String(s.zoneId) === String(z._id));
    const allotted = own.filter(s => s.status === 'ALLOCATED').length;
    const usable = own.filter(s => s.status !== 'BLOCKED' && s.status !== 'OUT_OF_SERVICE').length;
    return {
      zoneId: String(z._id), name: z.name, kind: z.kind,
      total: own.length,
      allotted,
      available: own.filter(s => s.status === 'AVAILABLE').length,
      reserved: own.filter(s => s.status === 'RESERVED' || s.status === 'VISITOR').length,
      outOfUse: own.length - usable,
      // Against USABLE slots, not total. Counting a bay with a pillar in it as
      // spare capacity is how a society concludes it has room and takes on
      // another car it cannot park.
      occupancy: usable ? Math.round((allotted / usable) * 1000) / 10 : null,
    };
  });

  return {
    byZone,
    totals: {
      slots: slots.length,
      allotted: slots.filter(s => s.status === 'ALLOCATED').length,
      flats,
      flatsWithASlot: allocatedFlats.length,
      flatsWithout: Math.max(0, flats - allocatedFlats.length),
    },
  };
}
