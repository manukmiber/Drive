// A share link's QR with the Zeiko mark in the middle (ADR-059). Error correction H restores up to
// 30% of the codewords; the mark and its white tile cover at most `LOGO_SHARE` of the code's area, so
// a scanner still reads it. One plan feeds both outputs: the SVG download and the pixels of the PNG
// (and the image on screen), so what is tested is what people get.
import QRCode from 'qrcode';

/** Quiet zone, in modules (the share dialog's old margin). */
export const QR_MARGIN = 2;
/**
 * The tile's share of the code's area (modules only, quiet zone excluded). 12% already left some
 * versions (13, 18) unreadable; at 9% every link length from 20 to 600 characters decodes.
 */
export const LOGO_SHARE = 0.09;

const MARK_FILL = '#4338ca';
const MARK_RGB = [0x43, 0x38, 0xca] as const;
// The Z of the favicon (viewBox 0 0 64 64), as a polygon.
const GLYPH: readonly (readonly [number, number])[] = [
  [18, 20],
  [46, 20],
  [46, 26],
  [28, 40],
  [46, 40],
  [46, 46],
  [18, 46],
  [18, 40],
  [36, 26],
  [18, 26],
];

export interface QrPlan {
  /** Modules across, quiet zone included. */
  side: number;
  /** Whether the module at column x, row y (quiet zone included) is dark. */
  dark(x: number, y: number): boolean;
  /** The white tile over the centre, in modules from the top-left (quiet zone included); null without a logo. */
  tile: { at: number; size: number } | null;
}

/** Largest odd tile side whose area stays within LOGO_SHARE of the code. */
export function tileModules(size: number): number {
  let n = Math.floor(Math.sqrt(LOGO_SHARE) * size);
  if (n % 2 === 0) n -= 1;
  return Math.max(n, 0);
}

export function qrPlan(text: string, logo = true): QrPlan {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: logo ? 'H' : 'M' });
  const size = modules.size;
  const side = size + QR_MARGIN * 2;
  const n = tileModules(size);
  const tile = logo && n >= 5 ? { at: QR_MARGIN + (size - n) / 2, size: n } : null;
  return {
    side,
    tile,
    dark(x, y) {
      const mx = x - QR_MARGIN;
      const my = y - QR_MARGIN;
      if (mx < 0 || my < 0 || mx >= size || my >= size) return false;
      if (
        tile &&
        x >= tile.at &&
        y >= tile.at &&
        x < tile.at + tile.size &&
        y < tile.at + tile.size
      )
        return false;
      return Boolean(modules.get(my, mx));
    },
  };
}

/** The mark's square inside the tile: one module of white around it. */
function markBox(tile: { at: number; size: number }) {
  const at = tile.at + 1;
  const size = tile.size - 2;
  return { at, size, radius: size / 4 };
}

const f = (n: number) => Number(n.toFixed(3));

function roundRectPath(at: number, size: number, r: number): string {
  const e = at + size;
  return (
    `M${f(at + r)} ${f(at)}H${f(e - r)}A${f(r)} ${f(r)} 0 0 1 ${f(e)} ${f(at + r)}V${f(e - r)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(e - r)} ${f(e)}H${f(at + r)}A${f(r)} ${f(r)} 0 0 1 ${f(at)} ${f(e - r)}` +
    `V${f(at + r)}A${f(r)} ${f(r)} 0 0 1 ${f(at + r)} ${f(at)}Z`
  );
}

/** The QR as an SVG document, in module units. */
export function qrSvg(text: string, logo = true): string {
  const plan = qrPlan(text, logo);
  let d = '';
  for (let y = 0; y < plan.side; y++) {
    let x = 0;
    while (x < plan.side) {
      if (!plan.dark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < plan.side && plan.dark(x, y)) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  let mark = '';
  if (plan.tile) {
    const m = markBox(plan.tile);
    const k = m.size / 64;
    const glyph = GLYPH.map(
      ([gx, gy], i) => `${i ? 'L' : 'M'}${f(m.at + gx * k)} ${f(m.at + gy * k)}`,
    );
    mark =
      `<path d="${roundRectPath(m.at, m.size, m.radius)}" fill="${MARK_FILL}"/>` +
      `<path d="${glyph.join('')}Z" fill="#fff"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.side} ${plan.side}">` +
    `<rect width="${plan.side}" height="${plan.side}" fill="#fff"/>` +
    `<path d="${d}" fill="#000" shape-rendering="crispEdges"/>${mark}</svg>`
  );
}

function inRoundRect(px: number, py: number, at: number, size: number, r: number): boolean {
  const e = at + size;
  if (px < at || py < at || px > e || py > e) return false;
  const cx = px < at + r ? at + r : px > e - r ? e - r : px;
  const cy = py < at + r ? at + r : py > e - r ? e - r : py;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function inGlyph(px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = GLYPH.length - 1; i < GLYPH.length; j = i++) {
    const [xi, yi] = GLYPH[i]!;
    const [xj, yj] = GLYPH[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The QR as RGBA pixels, `scale` pixels a module. Modules are sharp; the tile is sampled 4×4 per
 * pixel so the mark's edges are smooth.
 */
export function qrRaster(
  text: string,
  scale: number,
  logo = true,
): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const plan = qrPlan(text, logo);
  const px = plan.side * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < plan.side; y++)
    for (let x = 0; x < plan.side; x++) {
      if (!plan.dark(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y * scale + dy) * px + x * scale) * 4;
        for (let dx = 0; dx < scale; dx++) {
          const i = row + dx * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
  if (plan.tile) {
    const tile = plan.tile;
    const m = markBox(tile);
    const k = m.size / 64;
    const S = 4;
    const from = Math.floor(m.at * scale);
    const to = Math.ceil((m.at + m.size) * scale);
    for (let y = from; y < to; y++)
      for (let x = from; x < to; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < S; sy++)
          for (let sx = 0; sx < S; sx++) {
            const mx = (x + (sx + 0.5) / S) / scale;
            const my = (y + (sy + 0.5) / S) / scale;
            const onMark =
              inRoundRect(mx, my, m.at, m.size, m.radius) &&
              !inGlyph((mx - m.at) / k, (my - m.at) / k);
            r += onMark ? MARK_RGB[0] : 255;
            g += onMark ? MARK_RGB[1] : 255;
            b += onMark ? MARK_RGB[2] : 255;
          }
        const i = (y * px + x) * 4;
        rgba[i] = r / (S * S);
        rgba[i + 1] = g / (S * S);
        rgba[i + 2] = b / (S * S);
      }
  }
  return { width: px, height: px, rgba };
}
