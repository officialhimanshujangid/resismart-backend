import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as setupService from '../services/finance-setup.service';
import { SETUP_SECTIONS, SetupError } from '../services/finance-setup.service';
import { LedgerAccount } from '../models/ledger-account.model';
import { Vendor } from '../models/vendor.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Flat } from '../models/flat.model';
import { UserRole } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * Setup state plus everything the screen needs to ask its questions — the
 * accounts to put balances against, the vendors to owe money to, and how far
 * the society already is. Returned together so the wizard is one request, not
 * five, on a page whose whole job is to be finished quickly.
 */
export const getSetup = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [state, accounts, vendors, flatCount, invoiceCount] = await Promise.all([
      setupService.resolveSetup(societyId),
      LedgerAccount.find({ societyId: oid(societyId), isActive: true })
        .select('code name type normalBalance')
        .sort({ code: 1 })
        .lean(),
      Vendor.find({ societyId: oid(societyId), isActive: true }).select('name phone').sort({ name: 1 }).lean(),
      Flat.countDocuments({ societyId: oid(societyId) }),
      MaintenanceInvoice.countDocuments({ societyId: oid(societyId) }),
    ]);

    res.json({
      success: true,
      data: {
        ...state,
        sections: SETUP_SECTIONS,
        accounts,
        vendors,
        progress: { flats: flatCount, invoices: invoiceCount },
        // Committee members can read this screen but not finish it. Without
        // telling them, they fill the whole form and meet a 403 at the end,
        // with no way forward and no explanation.
        canComplete: req.user?.activeRole === UserRole.SOCIETY_ADMIN,
      },
    });
  } catch (e: any) {
    logger.error(`getSetup failed: ${e.message}`);
    res.status(500).json({ success: false, message: 'Could not load setup status' });
  }
};

export const completeSetup = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const result = await setupService.completeSetup(
      societyId,
      String(req.user!.userId),
      String(req.user!.userName || 'Admin'),
      {
        entryDate: req.body.entryDate ? new Date(req.body.entryDate) : undefined,
        bankCash: req.body.bankCash,
        vendorDues: req.body.vendorDues,
        funds: req.body.funds,
        deposits: req.body.deposits,
        declaredEmpty: req.body.declaredEmpty,
      },
    );

    auditFinance(req, 'FINANCE_SETUP_COMPLETE', 'FinancePolicy', societyId, {
      newValues: { declaredEmpty: req.body.declaredEmpty, totalPaise: result.totalPaise },
    });

    res.json({ success: true, data: result, message: 'Opening position recorded. Finance is now open.' });
  } catch (e: any) {
    if (e instanceof SetupError) return res.status(400).json({ success: false, message: e.message });
    // Deliberately generic. The raw message here carries Mongoose cast errors
    // with field paths, BSON internals and deployment topology ("transaction
    // numbers are only allowed on a replica set member"). Anything the user
    // genuinely needs to act on should be thrown as a SetupError above.
    logger.error(`completeSetup failed: ${e.message}`);
    res.status(500).json({ success: false, message: 'Could not complete setup' });
  }
};

export const reopenSetup = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    await setupService.reopenSetup(societyId, String(req.user!.userId), String(req.user!.userName || 'Admin'));
    auditFinance(req, 'FINANCE_SETUP_REOPEN', 'FinancePolicy', societyId);
    res.json({ success: true, message: 'Setup reopened.' });
  } catch (e: any) {
    if (e instanceof SetupError) return res.status(400).json({ success: false, message: e.message });
    logger.error(`reopenSetup failed: ${e.message}`);
    res.status(500).json({ success: false, message: 'Could not reopen setup' });
  }
};
