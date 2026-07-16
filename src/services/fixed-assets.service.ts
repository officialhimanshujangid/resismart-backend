import mongoose from 'mongoose';
import { FixedAsset, IFixedAsset, DepreciationMethod } from '../models/fixed-asset.model';
import { DepreciationRun } from '../models/depreciation-run.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { postJournal, reverseJournal, PostLineInput } from './ledger.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class AssetError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** The 15xx heads an asset's cost may sit in. 1590 is the contra, not a home for cost. */
export const ASSET_ACCOUNT_CODES = ['1500', '1510', '1520', '1530', '1540'] as const;

const DAY_MS = 86_400_000;

/**
 * Whole days between two dates.
 *
 * Rounded, not floored: the process runs in Asia/Kolkata (see `config/timezone`)
 * where there is no DST, but dates arriving from the client can carry a stray
 * time component, and a floor would silently drop a day from every span.
 */
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

export interface DepreciationRow {
  assetId: string;
  name: string;
  assetAccountCode: string;
  method: DepreciationMethod;
  ratePercent: number;
  costPaise: number;
  salvageValuePaise: number;
  /** Accumulated *before* this run. */
  accumulatedDepreciationPaise: number;
  /** Book value before this run: cost − accumulated. */
  openingNetBookValuePaise: number;
  /** Start of the un-charged span — the day after the last run, or purchase. */
  fromDate: Date;
  toDate: Date;
  days: number;
  /** What this run would charge. Whole paise, capped at the remaining depreciable amount. */
  depreciationPaise: number;
  /** Book value after this run. */
  closingNetBookValuePaise: number;
  /** Why nothing is charged, when nothing is charged — the preview shows this verbatim. */
  skipReason?: string;
}

/**
 * What one asset would be charged for the span ending `upTo`.
 *
 * The span starts at `lastDepreciationUpTo` (not at purchase) — charging from
 * purchase every time is exactly the double-charge this register has to avoid.
 * Pure: computes, never writes. `runDepreciation` and `depreciationPreview` share
 * it, so the number a user previews is the number that posts.
 */
function computeDepreciation(asset: IFixedAsset, upTo: Date): DepreciationRow {
  const openingNbv = asset.costPaise - asset.accumulatedDepreciationPaise;
  const from = asset.lastDepreciationUpTo ? new Date(asset.lastDepreciationUpTo) : new Date(asset.purchaseDate);
  const base: DepreciationRow = {
    assetId: String(asset._id),
    name: asset.name,
    assetAccountCode: asset.assetAccountCode,
    method: asset.method,
    ratePercent: asset.ratePercent,
    costPaise: asset.costPaise,
    salvageValuePaise: asset.salvageValuePaise,
    accumulatedDepreciationPaise: asset.accumulatedDepreciationPaise,
    openingNetBookValuePaise: openingNbv,
    fromDate: from,
    toDate: upTo,
    days: 0,
    depreciationPaise: 0,
    closingNetBookValuePaise: openingNbv,
  };

  if (asset.disposedOn) return { ...base, skipReason: 'Disposed' };
  if (!asset.isActive) return { ...base, skipReason: 'Inactive' };

  // Everything already written off down to the salvage floor. An asset a society
  // still uses stays on the books at its salvage value; it does not go to zero.
  const remaining = asset.costPaise - asset.salvageValuePaise - asset.accumulatedDepreciationPaise;
  if (remaining <= 0) return { ...base, skipReason: 'Fully depreciated' };

  const days = daysBetween(from, upTo);
  if (days <= 0) return { ...base, days: Math.max(0, days), skipReason: 'Already charged up to this date' };

  // SLM writes off the same slice of (cost − salvage) every year; WDV charges the
  // rate on what is left on the books, so the charge tapers and never quite
  // reaches zero on its own — which is why the salvage cap below still applies.
  const depreciableBase = asset.method === 'SLM'
    ? asset.costPaise - asset.salvageValuePaise
    : asset.costPaise - asset.accumulatedDepreciationPaise;

  const raw = depreciableBase * (asset.ratePercent / 100) * (days / 365);
  // Money is integer paise. Round once, here, and cap at what is left to write
  // off so the final part-period cannot take the asset below salvage.
  const depreciationPaise = Math.min(Math.max(0, Math.round(raw)), remaining);

  return {
    ...base,
    days,
    depreciationPaise,
    closingNetBookValuePaise: openingNbv - depreciationPaise,
  };
}

function parseUpTo(upToDate?: string | Date): Date {
  const d = upToDate ? new Date(upToDate) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error('upToDate is not a valid date');
  return d;
}

export interface DepreciationPreview {
  upToDate: Date;
  rows: DepreciationRow[];
  /** Assets this run would actually charge. */
  chargeable: number;
  /** Assets with nothing to charge — each row carries its own `skipReason`. */
  skipped: number;
  totalPaise: number;
}

/**
 * What a depreciation run *would* post, without posting it.
 *
 * Depreciation is the one entry a society books that nobody asked for and no
 * document backs, so it has to be inspectable before it hits the ledger — same
 * contract as the invoice dry-run: preview and post share one code path, so the
 * preview cannot drift from what actually posts.
 */
export async function depreciationPreview(
  societyId: string,
  opts: { upToDate?: string | Date } = {},
): Promise<DepreciationPreview> {
  const upTo = parseUpTo(opts.upToDate);
  const assets = await FixedAsset.find({ societyId }).sort({ purchaseDate: 1 });
  const rows = assets.map((a) => computeDepreciation(a, upTo));
  return {
    upToDate: upTo,
    rows,
    chargeable: rows.filter((r) => r.depreciationPaise > 0).length,
    skipped: rows.filter((r) => r.depreciationPaise === 0).length,
    totalPaise: rows.reduce((s, r) => s + r.depreciationPaise, 0),
  };
}

export interface DepreciationRunResult {
  upToDate: Date;
  posted: boolean;
  journalEntryId?: string;
  voucherNumber?: string;
  assetsCharged: number;
  totalPaise: number;
  rows: DepreciationRow[];
}

/**
 * Charge depreciation up to a date and post it to the ledger.
 *
 * ONE voucher for the whole run (Dr Depreciation / Cr Accumulated Depreciation),
 * not one per asset — that is how it appears in a society's books, and the
 * per-asset detail lives on the assets themselves.
 *
 * Idempotent per period: each asset only charges the span after its own
 * `lastDepreciationUpTo`, so a second run for the same date charges nothing and
 * posts nothing. The date is advanced only for assets that were actually
 * charged — advancing it on a zero charge would silently swallow a span whose
 * depreciation rounded down to nothing.
 */
export async function runDepreciation(
  societyId: string,
  opts: { upToDate?: string | Date } = {},
  actor: Actor = { userId: '', userName: '' },
): Promise<DepreciationRunResult> {
  const upTo = parseUpTo(opts.upToDate);
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  const session = await mongoose.startSession();
  try {
    let out!: DepreciationRunResult;
    await session.withTransaction(async () => {
      const assets = await FixedAsset.find({ societyId }).sort({ purchaseDate: 1 }).session(session);
      const rows = assets.map((a) => computeDepreciation(a, upTo));
      const charged = rows.filter((r) => r.depreciationPaise > 0);
      const totalPaise = charged.reduce((s, r) => s + r.depreciationPaise, 0);

      // Nothing to charge — most often a re-run of a period already booked.
      // Return quietly rather than throw: postJournal rejects a zero voucher, and
      // "you already ran this" is not an error the caller needs to handle.
      if (totalPaise === 0) {
        out = { upToDate: upTo, posted: false, assetsCharged: 0, totalPaise: 0, rows };
        return;
      }

      const lines: PostLineInput[] = [
        { accountCode: ACCOUNT_CODES.DEPRECIATION, debitPaise: totalPaise, description: `Depreciation for ${charged.length} asset(s)` },
        { accountCode: ACCOUNT_CODES.ACCUMULATED_DEPRECIATION, creditPaise: totalPaise, description: 'Accumulated depreciation' },
      ];
      const je = await postJournal(societyId, {
        voucherType: 'JOURNAL',
        entryDate: upTo,
        narration: `Depreciation up to ${upTo.toLocaleDateString('en-IN')}`,
        lines,
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      const byId = new Map(assets.map((a) => [String(a._id), a]));
      // Capture each asset's through-date BEFORE moving it — a reversal has to
      // put it back exactly, and once the asset is saved that value is gone.
      const runLines = charged.map((r) => ({
        assetId: byId.get(r.assetId)!._id as mongoose.Types.ObjectId,
        assetName: byId.get(r.assetId)!.name,
        depreciationPaise: r.depreciationPaise,
        previousLastDepreciationUpTo: byId.get(r.assetId)!.lastDepreciationUpTo,
      }));

      for (const r of charged) {
        const asset = byId.get(r.assetId)!;
        asset.accumulatedDepreciationPaise += r.depreciationPaise;
        asset.lastDepreciationUpTo = upTo;
        await asset.save({ session });
      }

      await DepreciationRun.create([{
        societyId,
        upToDate: upTo,
        totalPaise,
        lines: runLines,
        journalEntryId: je._id,
        voucherNumber: je.voucherNumber,
        status: 'POSTED',
        postedBy: actor.userId,
        postedByName: actor.userName,
      }], { session });

      out = {
        upToDate: upTo,
        posted: true,
        journalEntryId: String(je._id),
        voucherNumber: je.voucherNumber,
        assetsCharged: charged.length,
        totalPaise,
        rows,
      };
    });
    return out;
  } finally {
    session.endSession();
  }
}

export interface AssetView {
  _id: string;
  name: string;
  description?: string;
  assetAccountCode: string;
  assetAccountName?: string;
  purchaseDate: Date;
  costPaise: number;
  salvageValuePaise: number;
  method: DepreciationMethod;
  ratePercent: number;
  usefulLifeYears?: number;
  accumulatedDepreciationPaise: number;
  /** Derived, never stored: cost − accumulated. Two fields cannot disagree if only one exists. */
  netBookValuePaise: number;
  lastDepreciationUpTo?: Date;
  disposedOn?: Date;
  disposalProceedsPaise?: number;
  isActive: boolean;
}

const toView = (a: IFixedAsset): AssetView => ({
  _id: String(a._id),
  name: a.name,
  description: a.description,
  assetAccountCode: a.assetAccountCode,
  assetAccountName: a.assetAccountName,
  purchaseDate: a.purchaseDate,
  costPaise: a.costPaise,
  salvageValuePaise: a.salvageValuePaise,
  method: a.method,
  ratePercent: a.ratePercent,
  usefulLifeYears: a.usefulLifeYears,
  accumulatedDepreciationPaise: a.accumulatedDepreciationPaise,
  netBookValuePaise: a.costPaise - a.accumulatedDepreciationPaise,
  lastDepreciationUpTo: a.lastDepreciationUpTo,
  disposedOn: a.disposedOn,
  disposalProceedsPaise: a.disposalProceedsPaise,
  isActive: a.isActive,
});

export interface AssetListResult {
  assets: AssetView[];
  totals: { costPaise: number; accumulatedDepreciationPaise: number; netBookValuePaise: number; count: number };
}

/** The register: every asset with cost, what has been written off, and what is left. */
export async function listAssets(societyId: string, opts: { includeDisposed?: boolean } = {}): Promise<AssetListResult> {
  const query: any = { societyId };
  if (!opts.includeDisposed) query.disposedOn = { $exists: false };
  const assets = await FixedAsset.find(query).sort({ purchaseDate: -1 });
  const views = assets.map(toView);
  return {
    assets: views,
    totals: {
      costPaise: views.reduce((s, a) => s + a.costPaise, 0),
      accumulatedDepreciationPaise: views.reduce((s, a) => s + a.accumulatedDepreciationPaise, 0),
      netBookValuePaise: views.reduce((s, a) => s + a.netBookValuePaise, 0),
      count: views.length,
    },
  };
}

/**
 * Salvage is the floor an asset is never written below, so a salvage value at or
 * above cost means the asset can never depreciate at all. Almost always a
 * fat-fingered rupees/paise mix-up rather than an intention.
 */
function assertDepreciable(costPaise: number, salvageValuePaise: number) {
  if (salvageValuePaise >= costPaise) {
    throw new Error('Salvage value must be less than cost, otherwise the asset can never depreciate');
  }
}

export async function createAsset(societyId: string, body: any, actor: Actor): Promise<AssetView> {
  const costPaise = body.costPaise;
  const salvageValuePaise = body.salvageValuePaise || 0;
  assertDepreciable(costPaise, salvageValuePaise);

  if (!ASSET_ACCOUNT_CODES.includes(body.assetAccountCode)) {
    throw new Error(`Asset account must be one of ${ASSET_ACCOUNT_CODES.join(', ')}`);
  }
  // Snapshot the account name, the way an expense line snapshots its head — the
  // register must still read correctly if the account is renamed later.
  const acct = await LedgerAccount.findOne({ societyId, code: body.assetAccountCode }).select('name').lean();
  if (!acct) throw new Error(`Ledger account not found: ${body.assetAccountCode}`);

  const asset = await FixedAsset.create({
    societyId,
    name: body.name,
    description: body.description,
    assetAccountCode: body.assetAccountCode,
    assetAccountName: acct.name,
    purchaseDate: body.purchaseDate ? new Date(body.purchaseDate) : new Date(),
    costPaise,
    salvageValuePaise,
    method: body.method,
    ratePercent: body.ratePercent,
    usefulLifeYears: body.usefulLifeYears,
    accumulatedDepreciationPaise: 0,
    isActive: body.isActive ?? true,
    createdBy: actor.userId,
    createdByName: actor.userName,
  });
  return toView(asset);
}

/**
 * Edit an asset's descriptive and policy fields.
 *
 * `accumulatedDepreciationPaise` is deliberately not editable here — it is a
 * consequence of posted vouchers, and letting it be typed over would put the
 * register and the ledger's 1590 balance at odds with no trace of why. Cost and
 * salvage can move (a revision, a correction), but not to a point that would
 * leave the asset already written below its own floor.
 */
export async function updateAsset(societyId: string, id: string, body: any): Promise<AssetView> {
  const asset = await FixedAsset.findOne({ _id: id, societyId });
  if (!asset) throw new Error('Asset not found');

  const costPaise = body.costPaise ?? asset.costPaise;
  const salvageValuePaise = body.salvageValuePaise ?? asset.salvageValuePaise;
  assertDepreciable(costPaise, salvageValuePaise);
  if (asset.accumulatedDepreciationPaise > costPaise - salvageValuePaise) {
    throw new Error(
      `Depreciation of ${asset.accumulatedDepreciationPaise} paise has already been charged; `
      + 'cost and salvage cannot be revised to less than that.',
    );
  }

  if (body.assetAccountCode !== undefined) {
    if (!ASSET_ACCOUNT_CODES.includes(body.assetAccountCode)) {
      throw new Error(`Asset account must be one of ${ASSET_ACCOUNT_CODES.join(', ')}`);
    }
    const acct = await LedgerAccount.findOne({ societyId, code: body.assetAccountCode }).select('name').lean();
    if (!acct) throw new Error(`Ledger account not found: ${body.assetAccountCode}`);
    asset.assetAccountCode = body.assetAccountCode;
    asset.assetAccountName = acct.name;
  }

  for (const f of ['name', 'description', 'method', 'ratePercent', 'usefulLifeYears', 'isActive'] as const) {
    if (body[f] !== undefined) (asset as any)[f] = body[f];
  }
  if (body.purchaseDate !== undefined) asset.purchaseDate = new Date(body.purchaseDate);
  asset.costPaise = costPaise;
  asset.salvageValuePaise = salvageValuePaise;

  await asset.save();
  return toView(asset);
}

// ---------------------------------------------------------------- disposal

export interface DisposeInput {
  disposedOn?: string | Date;
  proceedsPaise?: number;
  /** Where the sale money landed. Ignored when there are no proceeds (scrapped). */
  receivedIn?: 'BANK' | 'CASH';
  note?: string;
}

/**
 * Sell or scrap an asset and take it off the books.
 *
 * Retires BOTH sides of the asset — its cost and the depreciation accumulated
 * against it — because the contra (1590) is a single pooled account across every
 * asset. Leaving this asset's share of it behind would understate assets forever,
 * and no report would show why.
 *
 *   Dr  1590 Accumulated Depreciation   (this asset's share)
 *   Dr  Bank/Cash                       (proceeds, if any)
 *   Dr  5195 Loss on Sale               (if it went for less than its book value)
 *       Cr  15xx Asset cost
 *       Cr  4220 Profit on Sale         (if it went for more)
 *
 * Depreciate up to the disposal date first if you want the final part-period
 * charged — this posts what the register says today and does not invent a charge.
 */
export async function disposeAsset(
  societyId: string,
  id: string,
  input: DisposeInput,
  actor: Actor,
): Promise<AssetView> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const disposedOn = input.disposedOn ? new Date(input.disposedOn) : new Date();
  const proceedsPaise = Math.max(0, Math.round(input.proceedsPaise || 0));

  const session = await mongoose.startSession();
  try {
    let out!: AssetView;
    await session.withTransaction(async () => {
      const asset = await FixedAsset.findOne({ _id: id, societyId }).session(session);
      if (!asset) throw new AssetError('Asset not found', 404);
      if (asset.disposedOn) throw new AssetError(`${asset.name} was already disposed on ${asset.disposedOn.toLocaleDateString('en-IN')}`);
      if (disposedOn < asset.purchaseDate) throw new AssetError('An asset cannot be disposed before it was bought');

      const accumulated = asset.accumulatedDepreciationPaise;
      const netBookValue = asset.costPaise - accumulated;
      const gain = proceedsPaise - netBookValue;

      const lines: PostLineInput[] = [];
      if (accumulated > 0) lines.push({ accountCode: ACCOUNT_CODES.ACCUMULATED_DEPRECIATION, debitPaise: accumulated, description: `Depreciation retired — ${asset.name}` });
      if (proceedsPaise > 0) lines.push({ accountCode: input.receivedIn === 'CASH' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK, debitPaise: proceedsPaise, description: `Sale proceeds — ${asset.name}` });
      if (gain < 0) lines.push({ accountCode: ACCOUNT_CODES.LOSS_ON_SALE, debitPaise: -gain, description: `Loss on sale — ${asset.name}` });
      lines.push({ accountCode: asset.assetAccountCode, creditPaise: asset.costPaise, description: `Cost retired — ${asset.name}` });
      if (gain > 0) lines.push({ accountCode: ACCOUNT_CODES.PROFIT_ON_SALE, creditPaise: gain, description: `Profit on sale — ${asset.name}` });

      // A fully-depreciated asset scrapped for nothing nets to zero on both
      // sides, so there is nothing to post — just retire the register entry.
      if (lines.some((l) => (l.debitPaise || 0) > 0)) {
        await postJournal(societyId, {
          voucherType: 'JOURNAL',
          entryDate: disposedOn,
          narration: `Disposal — ${asset.name}${input.note ? ` (${input.note})` : ''}`,
          lines,
          postedBy: actor.userId,
          postedByName: actor.userName,
          fyStartMonth: startMonth,
        }, session);
      }

      asset.disposedOn = disposedOn;
      asset.disposalProceedsPaise = proceedsPaise;
      asset.isActive = false;
      await asset.save({ session });
      out = toView(asset);
    });
    return out;
  } finally { session.endSession(); }
}

// ---------------------------------------------------------------- reversing a run

export async function listDepreciationRuns(societyId: string) {
  const runs = await DepreciationRun.find({ societyId }).sort({ upToDate: -1 }).lean();
  return runs.map((r) => ({
    _id: String(r._id),
    upToDate: r.upToDate,
    totalPaise: r.totalPaise,
    voucherNumber: r.voucherNumber,
    status: r.status,
    assetsCharged: r.lines.length,
    postedByName: r.postedByName,
    reversedOn: r.reversedOn,
    reversalReason: r.reversalReason,
  }));
}

/**
 * Undo a depreciation run — the voucher AND the register, together.
 *
 * Reversing only the journal would leave every asset's accumulated total and
 * through-date where the run put them: the register would claim the depreciation
 * was charged while the ledger said it wasn't, and the next run would skip the
 * span because `lastDepreciationUpTo` still covered it. So each asset is rolled
 * back to exactly what the run recorded before it touched them.
 */
export async function reverseDepreciationRun(
  societyId: string,
  runId: string,
  actor: Actor,
  reason?: string,
): Promise<{ reversed: true; voucherNumber: string; assetsRestored: number }> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  const session = await mongoose.startSession();
  try {
    let out!: { reversed: true; voucherNumber: string; assetsRestored: number };
    await session.withTransaction(async () => {
      const run = await DepreciationRun.findOne({ _id: runId, societyId }).session(session);
      if (!run) throw new AssetError('Depreciation run not found', 404);
      if (run.status === 'REVERSED') throw new AssetError('This run has already been reversed');

      const rev = await reverseJournal(societyId, run.journalEntryId, {
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
        narration: reason || 'Depreciation run reversed',
      }, session);

      for (const line of run.lines) {
        const asset = await FixedAsset.findOne({ _id: line.assetId, societyId }).session(session);
        if (!asset) continue; // deleted since the run — the voucher reversal still stands
        asset.accumulatedDepreciationPaise = Math.max(0, asset.accumulatedDepreciationPaise - line.depreciationPaise);
        asset.lastDepreciationUpTo = line.previousLastDepreciationUpTo;
        await asset.save({ session });
      }

      run.status = 'REVERSED';
      run.reversalJournalEntryId = rev._id;
      run.reversedOn = new Date();
      run.reversedByName = actor.userName;
      run.reversalReason = reason;
      await run.save({ session });

      out = { reversed: true, voucherNumber: rev.voucherNumber, assetsRestored: run.lines.length };
    });
    return out;
  } finally { session.endSession(); }
}
