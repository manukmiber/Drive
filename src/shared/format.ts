// Display formatting. Numbers and rupiah keep Indonesian grouping (Rp1.000) in both languages;
// dates follow the UI language. GB = 2^30 (SPEC §0.2).
import { GIB, KIB, MIB } from './constants';

const id1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
const id0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

export function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${id0.format(bytes)} B`;
  if (bytes < MIB) return `${id1.format(bytes / KIB)} KB`;
  if (bytes < GIB) return `${id1.format(bytes / MIB)} MB`;
  if (bytes < 1024 * GIB) return `${id1.format(bytes / GIB)} GB`;
  return `${id1.format(bytes / (1024 * GIB))} TB`;
}

/** 12.345 (Indonesian grouping in both languages, like money). */
export function formatCount(n: number): string {
  return id0.format(n);
}

/** Rp1.000 style (no space, dot thousands separator). */
export function formatRupiah(idr: number): string {
  return `Rp${id0.format(idr)}`;
}

export function formatPercent(ratio: number): string {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  return `${pct < 10 && pct > 0 ? id1.format(pct) : id0.format(pct)}%`;
}

/** Usage meter text: "Terpakai xx% · Sisa xx%" (SPEC §8.1). */
export function usageRatios(used: number, limit: number): { used: number; free: number } {
  if (limit <= 0) return { used: used > 0 ? 1 : 0, free: 0 };
  const u = Math.min(1, used / limit);
  return { used: u, free: 1 - u };
}

const dateOpts: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Jakarta',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};
let dateFmt = new Intl.DateTimeFormat('id-ID', dateOpts);
let dateTimeFmt = new Intl.DateTimeFormat('id-ID', {
  ...dateOpts,
  hour: '2-digit',
  minute: '2-digit',
});

/** Month names in the UI language (the web app sets this once at start; ADR-036). */
export function setDateLocale(locale: string): void {
  dateFmt = new Intl.DateTimeFormat(locale, dateOpts);
  dateTimeFmt = new Intl.DateTimeFormat(locale, {
    ...dateOpts,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(ms: number): string {
  return dateFmt.format(ms);
}

export function formatDateTime(ms: number): string {
  return `${dateTimeFmt.format(ms)} WIB`;
}
