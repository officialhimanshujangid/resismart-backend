import { Request, Response } from 'express';
import * as vendors from '../services/vendor.service';
import { VendorError } from '../services/vendor.service';
import { auditFinance } from '../utils/finance-audit.util';

const ctx = (req: Request) => ({
  societyId: req.user?.activeTenantId,
  actor: { userId: req.user!.userId, userName: req.user!.userName || 'Admin' },
});

/** Vendor errors carry their own status; a duplicate name is a 409, not a 500. */
const fail = (res: Response, e: any) => {
  if (e instanceof VendorError) { res.status(e.status).json({ error: e.message }); return; }
  if (e?.code === 11000) { res.status(409).json({ error: 'A vendor with this name already exists' }); return; }
  res.status(400).json({ error: e.message });
};

/** GET /finance/society/vendors — searchable, paginated list with payables. */
export const list = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId } = ctx(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const q = req.query as any;
    const result = await vendors.listVendors(societyId, {
      search: q.search,
      isActive: q.isActive === undefined || q.isActive === '' ? undefined : q.isActive === 'true',
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });

    // One aggregate for the whole page rather than a query per row.
    const payables = await vendors.vendorPayables(societyId);
    res.json({
      ...result,
      vendors: result.vendors.map(v => ({ ...v, outstandingPayablePaise: payables.get(v._id) || 0 })),
    });
  } catch (e: any) { fail(res, e); }
};

/** GET /finance/society/vendors/:id — the vendor, its payable and its ledger. */
export const detail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId } = ctx(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const q = req.query as any;
    const data = await vendors.vendorLedger(societyId, req.params.id, {
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    res.json(data);
  } catch (e: any) { fail(res, e); }
};

export const create = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId, actor } = ctx(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const vendor = await vendors.createVendor(societyId, req.body, actor);
    auditFinance(req, 'FINANCE_CREATE_VENDOR', 'Vendor', vendor._id, { newValues: { name: vendor.name } });
    res.json(vendor);
  } catch (e: any) { fail(res, e); }
};

export const update = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId, actor } = ctx(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const vendor = await vendors.updateVendor(societyId, req.params.id, req.body, actor);
    auditFinance(req, 'FINANCE_UPDATE_VENDOR', 'Vendor', vendor._id, { newValues: { name: vendor.name } });
    res.json(vendor);
  } catch (e: any) { fail(res, e); }
};

/** DELETE /finance/society/vendors/:id — deletes only if nothing references it. */
export const remove = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId, actor } = ctx(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await vendors.deleteVendor(societyId, req.params.id, actor);
    auditFinance(req, result.deleted ? 'FINANCE_DELETE_VENDOR' : 'FINANCE_DEACTIVATE_VENDOR', 'Vendor', req.params.id);
    res.json(result);
  } catch (e: any) { fail(res, e); }
};
