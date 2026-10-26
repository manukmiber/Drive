import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { LOGO_SHARE, qrPlan, qrRaster, qrSvg, tileModules } from '../../src/shared/qr';

const SHARE = 'https://drive.zeiko.biz.id/';
const LINKS = [
  'https://zeiko.biz.id/x',
  `${SHARE}${'a'.repeat(22)}/${'b'.repeat(32)}`,
  `${SHARE}${'A1b2C3d4'.repeat(8)}/${'Zz09'.repeat(8)}/Laporan%20Keuangan%20Q3%202026.pdf`,
  `${SHARE}${'k'.repeat(64)}/${'s'.repeat(32)}/${encodeURIComponent('Foto liburan keluarga — Bali (Agustus) 🌴 sangat panjang sekali.zip')}`,
  `${SHARE}${'q'.repeat(400)}`,
];

describe('QR with the logo (ADR-059)', () => {
  it.each(LINKS)('decodes %s', (text) => {
    for (const scale of [3, 6]) {
      const { width, height, rgba } = qrRaster(text, scale);
      const read = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
      expect(read?.data).toBe(text);
    }
  });

  it('keeps the tile within the share of the area and centred', () => {
    for (const text of LINKS) {
      const plan = qrPlan(text);
      const size = plan.side - 4;
      expect(plan.tile).not.toBeNull();
      expect(plan.tile!.size ** 2 / size ** 2).toBeLessThanOrEqual(LOGO_SHARE);
      expect(plan.tile!.at * 2 + plan.tile!.size).toBe(plan.side);
    }
    expect(tileModules(21) % 2).toBe(1);
  });

  it('clears the tile in the SVG too, and draws the mark', () => {
    const text = LINKS[2]!;
    const plan = qrPlan(text);
    const svg = qrSvg(text);
    expect(svg).toContain(`viewBox="0 0 ${plan.side} ${plan.side}"`);
    expect(svg).toContain('#4338ca');
    const t = plan.tile!;
    // No module run starts inside the tile.
    for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h/g))
      expect(
        Number(x) >= t.at &&
          Number(x) < t.at + t.size &&
          Number(y) >= t.at &&
          Number(y) < t.at + t.size,
      ).toBe(false);
  });

  it('draws no logo when asked not to', () => {
    expect(qrPlan('https://zeiko.biz.id/x', false).tile).toBeNull();
    expect(qrSvg('https://zeiko.biz.id/x', false)).not.toContain('#4338ca');
  });
});
