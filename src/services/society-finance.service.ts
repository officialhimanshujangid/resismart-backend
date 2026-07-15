import mongoose from 'mongoose';
import { SocietyFinanceSettings } from '../models/society-finance-settings.model';
import { SocietyBill } from '../models/society-bill.model';
import { FinanceLedgerEntry } from '../models/finance-ledger-entry.model';
import { Flat } from '../models/flat.model';
import { FlatSize } from '../models/flat-size.model';
import { User } from '../models/user.model';
import { IBillTemplate } from '../models/society-finance-settings.model';
import { seedChartOfAccounts } from './chart-of-accounts.seed';
import { logger } from '../utils/logger.util';
import RazorpayService from './razorpay.service';
import crypto from 'crypto';
import { appConfig } from '../config/appConfig';

/**
 * Encrypt bank account number using AES-256-GCM.
 */
function encryptBankAccount(text: string): { ciphertext: string, iv: string, tag: string } {
  // Use a proper 32-byte key derived from secret for AES-256
  const key = crypto.createHash('sha256').update(appConfig.jwtAccessSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex')
  };
}

/**
 * Decrypt bank account number.
 */
export function decryptBankAccount(ciphertext: string, ivHex: string, tagHex: string): string {
  const key = crypto.createHash('sha256').update(appConfig.jwtAccessSecret).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Whether a bill template applies to a flat given its occupancy status.
 * Maps template.applicableTo → Flat.status (VACANT | OWNER_OCCUPIED | RENTED).
 */
function isTemplateApplicable(tmpl: IBillTemplate, flatStatus?: string): boolean {
  switch (tmpl.applicableTo) {
    case 'ALL': return true;
    case 'OWNER_OCCUPIED': return flatStatus === 'OWNER_OCCUPIED';
    case 'RENTED': return flatStatus === 'RENTED';
    case 'VACANT': return flatStatus === 'VACANT';
    default: return true;
  }
}

export class SocietyFinanceService {
  
  /**
   * Lazily loads or creates finance settings for a society.
   */
  static async getOrCreateSettings(societyId: string, userId: string, userName: string) {
    let settings = await SocietyFinanceSettings.findOne({ societyId });
    if (!settings) {
      settings = await SocietyFinanceSettings.create({
        societyId,
        createdBy: userId,
        createdByName: userName,
        updatedBy: userId,
        updatedByName: userName,
        billTemplates: [],
      });
      // Seed the default chart of accounts the first time finance is set up so
      // that every downstream posting has accounts to reference (idempotent).
      try {
        await seedChartOfAccounts(societyId, userId, userName);
      } catch (e: any) {
        logger.error(`Failed to seed chart of accounts for society ${societyId}: ${e.message}`);
      }
    }
    return settings;
  }

  /**
   * Generates bills for a society based on active templates.
   */
  static async generateBillsForSociety(
    societyId: string, 
    opts?: { period?: string, templateIds?: string[], flatIds?: string[], dryRun?: boolean, triggeredByUserId?: string, triggeredByName?: string }
  ) {
    const settings = await SocietyFinanceSettings.findOne({ societyId });
    if (!settings) return { created: 0, skipped: 0, errors: ['Finance settings not found'] };
    
    // Determine billing period (default to current month YYYY-MM)
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const period = opts?.period || currentMonthStr;
    
    // Get templates
    let templates = settings.billTemplates.filter(t => t.isActive);
    if (opts?.templateIds && opts.templateIds.length > 0) {
      const allowedIds = new Set(opts.templateIds.map(id => id.toString()));
      templates = templates.filter(t => allowedIds.has(t._id.toString()));
    }
    if (templates.length === 0) return { created: 0, skipped: 0, errors: ['No active templates to generate'] };

    // Get active flats
    const flatQuery: any = { societyId, isArchived: { $ne: true } };
    if (opts?.flatIds && opts.flatIds.length > 0) {
      flatQuery._id = { $in: opts.flatIds };
    }
    // We select needed fields to construct the bill
    const flats = await Flat.find(flatQuery).lean();
    if (flats.length === 0) return { created: 0, skipped: 0, errors: ['No flats found'] };

    // Build denormalization lookups so bills carry the flat-size label + owner name
    // (needed for admin search and for resident emails to read correctly).
    const sizeIds = [...new Set(flats.map(f => f.size?.toString()).filter(Boolean))] as string[];
    const ownerIds = [...new Set(flats.map(f => f.ownerUserId?.toString()).filter(Boolean))] as string[];
    const sizeDocs = sizeIds.length ? await FlatSize.find({ _id: { $in: sizeIds } }).select('name').lean() : [];
    const ownerDocs = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select('name').lean() : [];
    const sizeLabelById = new Map(sizeDocs.map(s => [s._id.toString(), s.name]));
    const ownerNameById = new Map(ownerDocs.map(u => [u._id.toString(), u.name]));

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Due date
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + settings.billDueDays);
    // ensure time is at end of day
    dueDate.setHours(23, 59, 59, 999);

    if (opts?.dryRun) {
      // Just calculate counts
      // Actually, idempotency checks mean we need to check DB.
      // Doing a full dry-run check requires checking existing bills.
      const existingBills = await SocietyBill.find({ societyId, billingPeriod: period }).select('flatId billTemplateId').lean();
      const existingSet = new Set(existingBills.map(b => `${b.flatId.toString()}_${b.billTemplateId.toString()}`));
      
      let toCreate = 0;
      for (const flat of flats) {
        for (const tmpl of templates) {
          if (!isTemplateApplicable(tmpl, flat.status)) continue;
          if (existingSet.has(`${flat._id.toString()}_${tmpl._id.toString()}`)) {
            skipped++;
          } else {
            toCreate++;
          }
        }
      }
      return { created: toCreate, skipped, errors };
    }

    // Actual execution
    for (const flat of flats) {
      for (const tmpl of templates) {
        // Skip templates that don't apply to this flat's occupancy status.
        if (!isTemplateApplicable(tmpl, flat.status)) continue;
        try {
          // Calculate amount
          let amountPaise = tmpl.uniformAmountPaise || 0;
          if (tmpl.pricingMode === 'PER_FLAT_SIZE' && tmpl.perSizeAmounts && tmpl.perSizeAmounts.length > 0) {
            const sizeMatch = tmpl.perSizeAmounts.find(s => s.flatSizeId.toString() === flat.size?.toString());
            if (sizeMatch) {
              amountPaise = sizeMatch.amountPaise;
            } else {
              // Fallback to uniform if not matched
              amountPaise = tmpl.uniformAmountPaise || 0;
            }
          }
          
          if (amountPaise <= 0) {
            continue; // Skip 0 bills
          }

          // Atomically increment seq
          const seqResult = await SocietyFinanceSettings.findOneAndUpdate(
            { _id: settings._id },
            { $inc: { lastBillSequence: 1 } },
            { new: true }
          );
          const seq = seqResult?.lastBillSequence || 1;
          const billNumber = `${settings.billPrefix}-${period.replace('-', '')}-${String(seq).padStart(4, '0')}`;

          const billData = {
            societyId: settings.societyId,
            flatId: flat._id,
            flatNumber: flat.number,
            blockName: flat.blockName,
            flatSizeId: flat.size,
            flatSizeLabel: flat.size ? sizeLabelById.get(flat.size.toString()) : undefined,
            primaryOwnerUserId: flat.ownerUserId,
            primaryOwnerName: flat.ownerUserId ? ownerNameById.get(flat.ownerUserId.toString()) : undefined,
            billNumber,
            billTemplateId: tmpl._id,
            billTemplateName: tmpl.name,
            category: tmpl.category,
            billingPeriod: period,
            description: `${tmpl.name} — ${period}`,
            baseAmountPaise: amountPaise,
            totalAmountPaise: amountPaise,
            dueDate,
            generatedBy: opts?.triggeredByUserId ? 'MANUAL' : 'CRON',
            generatedByUserId: opts?.triggeredByUserId,
          };

          // Try insert
          try {
            const session = await mongoose.startSession();
            await session.withTransaction(async () => {
              const [bill] = await SocietyBill.create([billData], { session });
              
              await FinanceLedgerEntry.create([{
                societyId: settings.societyId,
                billId: bill._id,
                entryType: 'BILL_RAISED',
                description: bill.description,
                debitPaise: bill.totalAmountPaise,
                creditPaise: 0,
                flatId: bill.flatId,
                flatNumber: bill.flatNumber,
                billingPeriod: bill.billingPeriod,
                performedBy: opts?.triggeredByUserId || 'SYSTEM',
                performedByName: opts?.triggeredByName || 'System Cron',
              }], { session });
            });
            session.endSession();
            created++;
          } catch (e: any) {
            if (e.code === 11000) {
              // Duplicate bill exists
              skipped++;
            } else {
              throw e;
            }
          }

        } catch (err: any) {
          logger.error(`Error generating bill for flat ${flat._id}: ${err.message}`);
          errors.push(`Flat ${flat.number}: ${err.message}`);
        }
      }
    }

    return { created, skipped, errors };
  }

  /**
   * Update or setup bank details and initiate razorpay penny drop
   */
  static async setupBankDetails(
    societyId: string, 
    bankDetails: { accountName: string, accountNumber: string, ifsc: string, bankName: string },
    userId: string,
    userName: string
  ) {
    const settings = await this.getOrCreateSettings(societyId, userId, userName);
    const encrypted = encryptBankAccount(bankDetails.accountNumber);
    const last4 = bankDetails.accountNumber.slice(-4);
    
    // Assume Society name is available or fetched separately, here we mock it
    const societyName = "Society"; 

    try {
      // 1. Create Contact
      let contactId = settings.bankAccount?.razorpayContactId;
      if (!contactId) {
        try {
          const contact = await RazorpayService.createContact(societyId, societyName);
          contactId = contact.id;
        } catch (e: any) {
          throw new Error(`Failed to create Razorpay Contact: ${JSON.stringify(e)}`);
        }
      }

      // 2. Create Fund Account
      let fundAccount;
      try {
        fundAccount = await RazorpayService.createFundAccount(
          contactId as string,
          bankDetails.accountName,
          bankDetails.accountNumber,
          bankDetails.ifsc
        );
      } catch (e: any) {
        throw new Error(`Failed to create Razorpay Fund Account (contactId: ${contactId}): ${JSON.stringify(e)}`);
      }

      // 3. Create Validation
      let razorpayValidationId;
      let verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED" = 'PENDING';

      if (appConfig.razorpayBypassPennyDrop) {
        logger.info(`Bypassing Razorpay Penny Drop validation for society ${societyId} (RAZORPAY_BYPASS_PENNY_DROP is true)`);
        verificationStatus = 'VERIFIED';
        razorpayValidationId = 'val_mocked_bypass_' + Date.now();
      } else {
        try {
          const validation = await RazorpayService.validateFundAccount(fundAccount.id, bankDetails.accountNumber);
          razorpayValidationId = validation.id;
        } catch (e: any) {
          throw new Error(`Failed to validate Fund Account (fundAccountId: ${fundAccount.id}): ${JSON.stringify(e)}`);
        }
      }

      settings.bankAccount = {
        accountName: bankDetails.accountName,
        accountNumberEncrypted: encrypted.ciphertext,
        accountNumberIv: encrypted.iv,
        accountNumberTag: encrypted.tag,
        accountNumberLast4: last4,
        ifsc: bankDetails.ifsc,
        bankName: bankDetails.bankName,
        razorpayContactId: contactId,
        razorpayFundAccountId: fundAccount.id,
        razorpayValidationId,
        verificationStatus,
      };
      
      settings.updatedBy = new mongoose.Types.ObjectId(userId);
      settings.updatedByName = userName;
      await settings.save();
      
      return settings.bankAccount;
      
    } catch (error: any) {
      let errorMsg = 'Unknown error';
      if (error?.error?.description) {
        errorMsg = error.error.description;
      } else if (error?.response?.data?.error?.description) {
        errorMsg = error.response.data.error.description;
      } else if (error?.message) {
        errorMsg = error.message;
      } else if (typeof error === 'string') {
        errorMsg = error;
      } else if (error?.error?.message) {
        errorMsg = error.error.message;
      } else {
        errorMsg = JSON.stringify(error);
      }
      
      logger.error(`Razorpay bank setup failed for society ${societyId}: ${errorMsg}`);
      
      settings.bankAccount = {
        accountName: bankDetails.accountName,
        accountNumberEncrypted: encrypted.ciphertext,
        accountNumberIv: encrypted.iv,
        accountNumberTag: encrypted.tag,
        accountNumberLast4: last4,
        ifsc: bankDetails.ifsc,
        bankName: bankDetails.bankName,
        verificationStatus: 'FAILED',
        verificationFailureReason: errorMsg
      };
      await settings.save();
      throw new Error(`Bank verification failed: ${errorMsg}`);
    }
  }

  /**
   * Applies late fees to overdue bills.
   */
  static async applyLateFeesToSociety(societyId: string) {
    const settings = await SocietyFinanceSettings.findOne({ societyId });
    if (!settings || !settings.lateFeeEnabled || settings.lateFeePercent <= 0) return { applied: 0 };
    
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - settings.lateFeeGraceDays);
    
    // Find bills that are UNPAID or PARTIALLY_PAID and due before cutoff
    const query: any = {
      societyId,
      status: { $in: ['UNPAID', 'PARTIALLY_PAID'] },
      dueDate: { $lt: cutoff }
    };
    
    // Simple vs Compound logic
    if (settings.lateFeeMode === 'SIMPLE') {
      // Only apply if not already applied
      query.lateFeeAppliedAt = { $exists: false };
    } else {
      // For compound, we only apply once per month.
      // So if lateFeeAppliedAt is within this month, we skip.
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      query.$or = [
        { lateFeeAppliedAt: { $exists: false } },
        { lateFeeAppliedAt: { $lt: startOfMonth } }
      ];
    }
    
    const overdueBills = await SocietyBill.find(query);
    let applied = 0;
    
    for (const bill of overdueBills) {
      const outstanding = bill.totalAmountPaise - bill.paidAmountPaise;
      let lateFee = Math.round(outstanding * (settings.lateFeePercent / 100));
      
      if (settings.lateFeeCap && settings.lateFeeCap > 0) {
        lateFee = Math.min(lateFee, settings.lateFeeCap);
      }
      
      if (lateFee <= 0) continue;
      
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          bill.lateFeeAmountPaise += lateFee;
          bill.totalAmountPaise += lateFee;
          bill.lateFeeAppliedAt = now;
          await bill.save({ session });
          
          await FinanceLedgerEntry.create([{
            societyId,
            billId: bill._id,
            entryType: 'LATE_FEE_APPLIED',
            description: `Late fee for ${bill.billNumber}`,
            debitPaise: lateFee,
            creditPaise: 0,
            flatId: bill.flatId,
            flatNumber: bill.flatNumber,
            billingPeriod: bill.billingPeriod,
            performedBy: 'SYSTEM',
            performedByName: 'System Cron',
          }], { session });
        });
        applied++;
      } catch (err: any) {
        logger.error(`Failed to apply late fee to bill ${bill._id}: ${err.message}`);
      } finally {
        session.endSession();
      }
    }
    
    return { applied };
  }
}
