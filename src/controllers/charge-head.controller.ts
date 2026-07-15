import { Request, Response } from 'express';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { createChargeHead, updateChargeHead } from '../services/charge-head.service';

export const listChargeHeads = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { isActive } = req.query;
    const query: any = { societyId };
    if (isActive === 'true') query.isActive = true;
    if (isActive === 'false') query.isActive = false;

    const heads = await ChargeHead.find(query).sort({ sortOrder: 1, name: 1 });
    res.json(heads);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createChargeHeadController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const head = await createChargeHead(societyId, req.body, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
    res.json(head);
  } catch (error: any) {
    if (error.code === 11000) { res.status(409).json({ error: 'A charge head with this code already exists' }); return; }
    res.status(400).json({ error: error.message });
  }
};

export const updateChargeHeadController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const head = await updateChargeHead(societyId, req.params.id, req.body, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
    res.json(head);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteChargeHeadController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    // If the head has ever been used on an invoice, soft-deactivate instead of deleting.
    const used = await MaintenanceInvoice.exists({ societyId, 'lineItems.chargeHeadId': req.params.id });
    if (used) {
      const head = await ChargeHead.findOneAndUpdate({ _id: req.params.id, societyId }, { isActive: false }, { new: true });
      if (!head) { res.status(404).json({ error: 'Charge head not found' }); return; }
      res.json({ message: 'Charge head is in use — deactivated instead of deleted', head });
      return;
    }

    const deleted = await ChargeHead.findOneAndDelete({ _id: req.params.id, societyId });
    if (!deleted) { res.status(404).json({ error: 'Charge head not found' }); return; }
    res.json({ message: 'Charge head deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
