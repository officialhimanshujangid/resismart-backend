const SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'د.إ',
};

const LOCALES: Record<string, string> = {
  INR: 'en-IN',
  USD: 'en-US',
  EUR: 'en-IE',
  GBP: 'en-GB',
  AED: 'en-AE',
};

export const currencySymbol = (code = 'INR'): string => SYMBOLS[code?.toUpperCase()] || `${code} `;

/** Formats an amount given in the smallest unit (paise/cents) into a localized currency string. */
export const formatMoney = (minorUnits: number, code = 'INR'): string => {
  const upper = (code || 'INR').toUpperCase();
  const value = (minorUnits || 0) / 100;
  return `${currencySymbol(upper)}${value.toLocaleString(LOCALES[upper] || 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
