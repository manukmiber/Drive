// Display formatting for Indonesian users. GB = 2^30 (SPEC §0.2).
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

const dateFmt = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(ms: number): string {
  return dateFmt.format(ms);
}

export function formatDateTime(ms: number): string {
  return `${dateTimeFmt.format(ms)} WIB`;
}
