// Time helpers. Storage is UTC ms (ADR-008); billing, ads and display use Asia/Jakarta (WIB, UTC+7,
// no DST — so a fixed offset is exact).
import { DAY_MS, WIB_OFFSET_MS } from './constants';

/** Calendar date in WIB as YYYY-MM-DD. */
export function wibDate(ms: number): string {
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC ms of 00:00 WIB on the WIB calendar day containing `ms`. */
export function wibStartOfDay(ms: number): number {
  const shifted = ms + WIB_OFFSET_MS;
  return shifted - (shifted % DAY_MS) - WIB_OFFSET_MS;
}

/** UTC ms of 00:00 WIB for a YYYY-MM-DD WIB date. */
export function wibDateToMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`invalid date ${date}`);
  return ms - WIB_OFFSET_MS;
}

export function addDaysWib(date: string, days: number): string {
  return wibDate(wibDateToMs(date) + days * DAY_MS);
}

/** WIB year+month as YYYYMM (invoice numbers). */
export function wibYearMonth(ms: number): string {
  return wibDate(ms).slice(0, 7).replace('-', '');
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Next billing boundary: same WIB day-of-month `anchorDay` in the month after `fromMs`, clamped to
 * the month's last day (29–31 → end of month, SPEC §12.4). Keeps the WIB wall-clock time of `fromMs`.
 */
export function addBillingMonth(fromMs: number, anchorDay: number, months = 1): number {
  const wib = new Date(fromMs + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const day = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));
  const result = Date.UTC(
    targetYear,
    targetMonth,
    day,
    wib.getUTCHours(),
    wib.getUTCMinutes(),
    wib.getUTCSeconds(),
    wib.getUTCMilliseconds(),
  );
  return result - WIB_OFFSET_MS;
}

/** Whole days from `fromMs` to `toMs` (WIB calendar days, may be negative). */
export function wibDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((wibStartOfDay(toMs) - wibStartOfDay(fromMs)) / DAY_MS);
}
