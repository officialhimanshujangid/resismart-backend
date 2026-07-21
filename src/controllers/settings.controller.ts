import { Request, Response, NextFunction } from 'express';
import { GlobalSetting } from '../models/global-setting.model';
import { updateSettingsSchema } from '../validators/settings.validator';
import { ensureFreeTierPlan } from '../services/subscription-lifecycle.service';

const DEFAULT_CAPS = {
  max_staff_count: 5,
  max_flat_count: 5,
  max_member_count: 20,
  max_visitor_count: 50,
  max_tickets_count: 20,
  max_service_count: 5,
  max_active_listings: 5,
};

const serialize = (setting: any) => {
  const caps = setting.defaultTrialCapabilities;
  return {
    _id: setting._id,
    gracePeriodDays: setting.gracePeriodDays ?? 7,
    defaultTrialCapabilities: caps instanceof Map ? Object.fromEntries(caps) : caps,
    expiryReminderDays: setting.expiryReminderDays || [3, 1],
    updatedAt: setting.updatedAt,
  };
};

export class SettingsController {
  /** Returns the singleton global settings, creating it on first access. */
  static async getSettings(_req: Request, res: Response, next: NextFunction) {
    try {
      let setting = await GlobalSetting.findOne();
      if (!setting) {
        setting = await GlobalSetting.create({ gracePeriodDays: 7, defaultTrialCapabilities: DEFAULT_CAPS });
      }
      return res.status(200).json({ success: true, settings: serialize(setting) });
    } catch (error) {
      next(error);
    }
  }

  /** Updates grace/free-tier settings and keeps the internal Free plan in sync. */
  static async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = updateSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
      }

      let setting = await GlobalSetting.findOne();
      if (!setting) setting = new GlobalSetting({ gracePeriodDays: 7, defaultTrialCapabilities: DEFAULT_CAPS });

      if (parsed.data.gracePeriodDays !== undefined) setting.gracePeriodDays = parsed.data.gracePeriodDays;
      if (parsed.data.defaultTrialCapabilities) {
        /**
         * Merge, never replace.
         *
         * These capabilities are the free tier, and every value is
         * load-bearing: `0` means the module does not exist for the society,
         * `-1` or absent means unlimited, `N` is a cap. Replacing the whole map
         * with whatever a caller sent meant that any client which did not know
         * about a key dropped it — and a dropped key reads as UNLIMITED
         * everywhere downstream, so one save handed every unpaid society an
         * uncapped module for free. The old settings screen did exactly this
         * with `max_active_listings`.
         *
         * Merging costs the ability to delete a key. Nothing needs it: `-1`
         * and absent are read identically, so "no ceiling" is still one save
         * away.
         */
        const existing = setting.defaultTrialCapabilities instanceof Map
          ? Object.fromEntries(setting.defaultTrialCapabilities)
          : ((setting.defaultTrialCapabilities as any) || {});
        setting.defaultTrialCapabilities = new Map(
          Object.entries({ ...existing, ...parsed.data.defaultTrialCapabilities }),
        ) as any;
      }
      if (parsed.data.expiryReminderDays) {
        setting.expiryReminderDays = [...new Set(parsed.data.expiryReminderDays)].sort((a, b) => b - a);
      }
      await setting.save();

      // Keep the Free-tier plan's capabilities in sync with the configured limits.
      await ensureFreeTierPlan();

      return res.status(200).json({ success: true, message: 'Settings updated successfully', settings: serialize(setting) });
    } catch (error) {
      next(error);
    }
  }
}

export default SettingsController;
