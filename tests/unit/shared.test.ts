import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/shared/config-defaults';
import { formatBytes, formatRupiah, usageRatios } from '../../src/shared/format';
import { addBillingMonth, wibDate, wibDateToMs, wibStartOfDay } from '../../src/shared/time';
import { mergeConfig } from '../../src/worker/services/config';

describe('time (WIB)', () => {
  it('maps UTC instants to WIB dates', () => {
    expect(wibDate(Date.parse('2026-10-21T16:59:59Z'))).toBe('2026-10-21');
    expect(wibDate(Date.parse('2026-10-21T17:00:00Z'))).toBe('2026-10-22');
    expect(wibStartOfDay(Date.parse('2026-10-21T20:00:00Z'))).toBe(
      Date.parse('2026-10-21T17:00:00Z'),
    );
    expect(wibDateToMs('2026-10-22')).toBe(Date.parse('2026-10-21T17:00:00Z'));
  });

  it('renews on the same day, clamping 29–31 to month end', () => {
    const jan31 = Date.parse('2027-01-31T03:00:00Z'); // 10:00 WIB
    const feb = addBillingMonth(jan31, 31);
    expect(new Date(feb).toISOString()).toBe('2027-02-28T03:00:00.000Z');
    expect(new Date(addBillingMonth(feb, 31)).toISOString()).toBe('2027-03-31T03:00:00.000Z');
    const dec15 = Date.parse('2026-12-15T00:00:00Z');
    expect(new Date(addBillingMonth(dec15, 15)).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('format', () => {
  it('uses binary GB and Indonesian separators', () => {
    expect(formatBytes(3 * 2 ** 30)).toBe('3 GB');
    expect(formatBytes(1.5 * 2 ** 20)).toBe('1,5 MB');
    expect(formatRupiah(25_000)).toBe('Rp25.000');
    expect(usageRatios(30, 120)).toEqual({ used: 0.25, free: 0.75 });
    expect(usageRatios(0, 0)).toEqual({ used: 0, free: 0 });
  });
});

describe('config', () => {
  it('falls back to defaults for unknown or invalid rows', () => {
    const cfg = mergeConfig([
      { key: 'usd_idr_rate', valueJson: '17500' },
      { key: 'upload_part_concurrency', valueJson: '"lots"' },
      { key: 'trash_retention_days', valueJson: '{bad json' },
      { key: 'not_a_key', valueJson: '1' },
    ]);
    expect(cfg.usd_idr_rate).toBe(17500);
    expect(cfg.upload_part_concurrency).toBe(CONFIG_DEFAULTS.upload_part_concurrency);
    expect(cfg.trash_retention_days).toBe(30);
    expect(cfg).not.toHaveProperty('not_a_key');
  });
});
