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

// The Zeiko mark (proxychat/brand/zeiko, viewBox 0 0 64 64): a navy tile, four cream kawung
// petals and the amber dot in the middle.
const TILE_FILL = '#1f2639';
const PETAL_FILL = '#eee6d7';
const DOT_FILL = '#f0ae48';
const RGB = {
  tile: [0x1f, 0x26, 0x39],
  petal: [0xee, 0xe6, 0xd7],
  dot: [0xf0, 0xae, 0x48],
  white: [0xff, 0xff, 0xff],
} as const;
/** Each petal: centre, then its angle (degrees); every petal is 11 × 6.6 in radius. */
const PETALS: readonly (readonly [number, number, number])[] = [
  [21, 21, 45],
  [43, 43, 45],
  [43, 21, -45],
  [21, 43, -45],
];
const PETAL_RX = 11;
const PETAL_RY = 6.6;
const DOT = { cx: 32, cy: 32, r: 3.6 };

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
    const petals = PETALS.map(
      ([cx, cy, deg]) =>
        `<ellipse cx="${f(m.at + cx * k)}" cy="${f(m.at + cy * k)}" rx="${f(PETAL_RX * k)}" ry="${f(PETAL_RY * k)}" transform="rotate(${deg} ${f(m.at + cx * k)} ${f(m.at + cy * k)})"/>`,
    ).join('');
    mark =
      `<path d="${roundRectPath(m.at, m.size, m.radius)}" fill="${TILE_FILL}"/>` +
      `<g fill="${PETAL_FILL}">${petals}</g>` +
      `<circle cx="${f(m.at + DOT.cx * k)}" cy="${f(m.at + DOT.cy * k)}" r="${f(DOT.r * k)}" fill="${DOT_FILL}"/>`;
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

/** Which part of the mark a point (in the mark's 64-unit space) falls on. */
function markPart(x: number, y: number): 'dot' | 'petal' | 'tile' {
  if ((x - DOT.cx) ** 2 + (y - DOT.cy) ** 2 <= DOT.r ** 2) return 'dot';
  for (const [cx, cy, deg] of PETALS) {
    const a = (-deg * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * Math.cos(a) - dy * Math.sin(a);
    const v = dx * Math.sin(a) + dy * Math.cos(a);
    if ((u / PETAL_RX) ** 2 + (v / PETAL_RY) ** 2 <= 1) return 'petal';
  }
  return 'tile';
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
            const c = inRoundRect(mx, my, m.at, m.size, m.radius)
              ? RGB[markPart((mx - m.at) / k, (my - m.at) / k)]
              : RGB.white;
            r += c[0];
            g += c[1];
            b += c[2];
          }
        const i = (y * px + x) * 4;
        rgba[i] = r / (S * S);
        rgba[i + 1] = g / (S * S);
        rgba[i + 2] = b / (S * S);
      }
  }
  return { width: px, height: px, rgba };
}
