import { Request, Response } from 'express';
import {
  listAssets, createAsset, updateAsset, depreciationPreview, runDepreciation,
  disposeAsset, listDepreciationRuns, reverseDepreciationRun, AssetError,
} from '../services/fixed-assets.service';
import { auditFinance } from '../utils/finance-audit.util';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
const statusOf = (e: any) => (e instanceof AssetError ? e.status : 400);

export const listAssetsController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await listAssets(societyId, { includeDisposed: req.query.includeDisposed === 'true' });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const createAssetController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const asset = await createAsset(societyId, req.body, actorOf(req));
    auditFinance(req, 'FINANCE_CREATE_ASSET', 'FixedAsset', asset._id, { newValues: { name: asset.name, costPaise: asset.costPaise } });
    res.json(asset);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const updateAssetController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const asset = await updateAsset(societyId, req.params.id, req.body);
    auditFinance(req, 'FINANCE_UPDATE_ASSET', 'FixedAsset', asset._id, { newValues: { name: asset.name, costPaise: asset.costPaise } });
    res.json(asset);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const previewDepreciationController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const preview = await depreciationPreview(societyId, { upToDate: req.query.upToDate as string | undefined });
    res.json(preview);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const runDepreciationController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await runDepreciation(societyId, { upToDate: req.body.upToDate }, actorOf(req));
    if (result.posted) {
      auditFinance(req, 'FINANCE_RUN_DEPRECIATION', 'JournalEntry', result.journalEntryId!, {
        newValues: { totalPaise: result.totalPaise, assetsCharged: result.assetsCharged, upToDate: result.upToDate },
      });
    }
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const disposeAssetController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const asset = await disposeAsset(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'FINANCE_DISPOSE_ASSET', 'FixedAsset', asset._id, {
      newValues: { disposedOn: asset.disposedOn, proceedsPaise: asset.disposalProceedsPaise, costPaise: asset.costPaise },
    });
    res.json(asset);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};

export const listDepreciationRunsController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    res.json(await listDepreciationRuns(societyId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const reverseDepreciationRunController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await reverseDepreciationRun(societyId, req.params.id, actorOf(req), req.body?.reason);
    auditFinance(req, 'FINANCE_REVERSE_DEPRECIATION', 'DepreciationRun', req.params.id, {
      newValues: { voucherNumber: result.voucherNumber, assetsRestored: result.assetsRestored, reason: req.body?.reason },
    });
    res.json(result);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};
