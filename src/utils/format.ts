/**
 * Persian number formatting (spec §1/§12) — the economy UI shows
 * Persian digits with Persian separators: ۱۲٬۰۰۰ and ۰٫۵.
 * Leaf module — no imports.
 */

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** Converts Latin digits of a string to Persian digits. */
export function toFaDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    out += ch >= '0' && ch <= '9' ? FA_DIGITS[ch.charCodeAt(0) - 48] : ch;
  }
  return out;
}

/**
 * Formats a number the Persian way: ۱۲٬۰۰۰ (group separator ٬) and
 * ۰٫۵ (decimal separator ٫). `decimals` rounds fixed (0 default).
 */
export function faNum(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return toFaDigits('0');
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const body = frac !== undefined ? `${grouped}٫${frac}` : grouped;
  return (value < 0 ? '−' : '') + toFaDigits(body);
}

/** Signed Persian number: +۲۴۰ / −۱۰۰ (the ledger's ±X lines). */
export function faSigned(value: number, decimals = 0): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + faNum(Math.abs(value), decimals);
}

/**
 * Population in Persian words of scale (spec §1 — NEVER «24M»):
 * 7_400_000 → «۷٫۴ میلیون نفر»; 24_000_000 → «۲۴ میلیون نفر».
 */
export function faPopulation(population: number): string {
  const millions = population / 1_000_000;
  const rounded = millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
  const text = faNum(rounded, rounded % 1 !== 0 ? 1 : 0);
  return `${text} میلیون نفر`;
}
