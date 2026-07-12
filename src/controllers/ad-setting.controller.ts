import { Request, Response, NextFunction } from 'express';
import { AdSetting } from '../models/ad-setting.model';
import { updateAdSettingSchema } from '../validators/marketplace.validator';
import { getAdSetting, invalidateAdSettingCache } from '../services/ad-setting.service';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';

const serialize = (s: any) => ({
  _id: s._id,
  listingsEnabled: s.listingsEnabled,
  baseRadiusKm: s.baseRadiusKm,
  maxRadiusKm: s.maxRadiusKm,
  currency: s.currency,
  listingExpiryDays: s.listingExpiryDays,
  boostPackages: (s.boostPackages || []).map((p: any) => ({
    _id: p._id,
    label: p.label,
    pricePaise: p.pricePaise,
    durationDays: p.durationDays,
    radiusKm: p.radiusKm,
    topPlacement: p.topPlacement,
    isActive: p.isActive,
  })),
  updatedAt: s.updatedAt,
});

export class AdSettingController {
  /** SYSTEM_OWNER: read the singleton marketplace configuration (created on first access). */
  static async get(_req: Request, res: Response, next: NextFunction) {
    try {
      const setting = await getAdSetting();
      return res.status(200).json({ success: true, settings: serialize(setting) });
    } catch (error) {
      next(error);
    }
  }

  /** SYSTEM_OWNER: update radius caps, boost packages, expiry and the master switch. */
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = updateAdSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
      }
      const data = parsed.data;

      let setting = await AdSetting.findOne();
      if (!setting) setting = new AdSetting({});

      // Guard package radii against the *effective* max (incoming value or the stored one).
      const effectiveMax = data.maxRadiusKm ?? setting.maxRadiusKm;
      const effectiveBase = data.baseRadiusKm ?? setting.baseRadiusKm;
      if (effectiveBase > effectiveMax) {
        return res.status(400).json({ success: false, message: 'Base radius cannot exceed the maximum radius' });
      }
      if (data.boostPackages) {
        const offending = data.boostPackages.find((p) => p.radiusKm > effectiveMax);
        if (offending) {
          return res.status(400).json({ success: false, message: `Package "${offending.label}" radius exceeds the maximum radius (${effectiveMax} km)` });
        }
      }

      if (data.listingsEnabled !== undefined) setting.listingsEnabled = data.listingsEnabled;
      if (data.baseRadiusKm !== undefined) setting.baseRadiusKm = data.baseRadiusKm;
      if (data.maxRadiusKm !== undefined) setting.maxRadiusKm = data.maxRadiusKm;
      if (data.listingExpiryDays !== undefined) setting.listingExpiryDays = data.listingExpiryDays;
      if (data.boostPackages) {
        // Replace the catalog; Mongoose preserves _id when the client echoes it back,
        // and mints a fresh _id for new packages.
        setting.boostPackages = data.boostPackages as any;
      }

      await setting.save();
      invalidateAdSettingCache();

      AuditService.log({
        userId: req.user?.userId || 'system',
        userName: req.user?.userName || 'system',
        tenantId: null,
        tenantType: TenantType.SYSTEM,
        action: 'MARKETPLACE_SETTINGS_UPDATE',
        resource: 'AdSetting',
        resourceId: setting._id.toString(),
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        newValues: {
          listingsEnabled: setting.listingsEnabled,
          baseRadiusKm: setting.baseRadiusKm,
          maxRadiusKm: setting.maxRadiusKm,
          listingExpiryDays: setting.listingExpiryDays,
          packageCount: setting.boostPackages.length,
        },
      });

      return res.status(200).json({ success: true, message: 'Marketplace settings updated', settings: serialize(setting) });
    } catch (error) {
      next(error);
    }
  }
}

export default AdSettingController;
