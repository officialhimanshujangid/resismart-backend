import { AdSetting, IAdSetting } from '../models/ad-setting.model';

/**
 * In-process TTL cache for the singleton marketplace config. AdSetting is read on every
 * boost checkout and radius query but changes rarely, so a short cache avoids a DB round
 * trip on the hot path. Swap-ready for Redis when the app goes multi-instance.
 */
let cached: { doc: IAdSetting; at: number } | null = null;
const TTL_MS = 60_000;

/** Returns the singleton marketplace config, creating it with defaults on first access. */
export const getAdSetting = async (force = false): Promise<IAdSetting> => {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.doc;

  let doc = await AdSetting.findOne();
  if (!doc) doc = await AdSetting.create({});
  cached = { doc, at: Date.now() };
  return doc;
};

/** Invalidate the cache after an owner writes new settings. */
export const invalidateAdSettingCache = (): void => {
  cached = null;
};
