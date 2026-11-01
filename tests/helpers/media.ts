// Photo and video bytes for tests (D8, ADR-091): JPEG with EXIF, MP4 with mvhd/tkhd, built by hand.
export const enc = (s: string) => new TextEncoder().encode(s);
export function cat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const all = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export const u16be = (n: number) => [n >> 8, n & 255];
export const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A big-endian TIFF: IFD0 (orientation, a GPS pointer that must be ignored, Exif pointer) + Exif IFD. */
export function tiff(o: { orientation?: number; date?: string; offset?: string }): Uint8Array {
  const entries0: number[][] = [];
  const date = enc(`${o.date ?? ''}\0`);
  const off = enc(`${o.offset ?? ''}\0`);
  // Layout: header 8 · IFD0 at 8 (3 entries) · Exif IFD after · strings after that.
  const ifd0At = 8;
  const ifd0Len = 2 + 3 * 12 + 4;
  const exifAt = ifd0At + ifd0Len;
  const exifCount = (o.date ? 1 : 0) + (o.offset ? 1 : 0);
  const exifLen = 2 + exifCount * 12 + 4;
  const dateAt = exifAt + exifLen;
  const offAt = dateAt + date.length;
  entries0.push([...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(o.orientation ?? 1), 0, 0]);
  entries0.push([...u16be(0x8825), ...u16be(4), ...u32be(1), ...u32be(9999)]);
  entries0.push([...u16be(0x8769), ...u16be(4), ...u32be(1), ...u32be(exifAt)]);
  const exif: number[][] = [];
  if (o.date) exif.push([...u16be(0x9003), ...u16be(2), ...u32be(date.length), ...u32be(dateAt)]);
  if (o.offset) exif.push([...u16be(0x9011), ...u16be(2), ...u32be(off.length), ...u32be(offAt)]);
  return cat(
    enc('MM'),
    u16be(42),
    u32be(ifd0At),
    u16be(3),
    ...entries0,
    u32be(0),
    u16be(exifCount),
    ...exif,
    u32be(0),
    o.date ? date : [],
    o.offset ? off : [],
  );
}

export function jpeg(t: Uint8Array | null, w: number, h: number): Uint8Array {
  const app1 = t ? cat([0xff, 0xe1], u16be(t.length + 8), enc('Exif\0\0'), t) : new Uint8Array(0);
  const sof = cat([0xff, 0xc0], u16be(17), [8], u16be(h), u16be(w), [3], new Array(9).fill(0));
  return cat([0xff, 0xd8], app1, sof, [0xff, 0xda, 0, 2]);
}

export function box(type: string, ...payload: Array<Uint8Array | number[]>): Uint8Array {
  const body = cat(...payload);
  return cat(u32be(body.length + 8), enc(type), body);
}

/** An MP4 with mvhd (made at takenAt, durationMs long) and a 1920×1080 track turned to portrait. */
export function mp4(takenAt: number, durationMs: number): Uint8Array {
  const created = (takenAt / 1000 + 2_082_844_800) >>> 0;
  const mvhd = box(
    'mvhd',
    [0, 0, 0, 0],
    u32be(created),
    u32be(created),
    u32be(1000),
    u32be(durationMs),
    new Array(80).fill(0),
  );
  const matrix = cat(
    u32be(0),
    u32be(0x10000),
    u32be(0),
    u32be(0xffff0000),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0x40000000),
  );
  const tkhd = box(
    'tkhd',
    [0, 0, 0, 7],
    u32be(0),
    u32be(0),
    u32be(1),
    u32be(0),
    u32be(durationMs),
    new Array(8).fill(0),
    new Array(8).fill(0),
    matrix,
    u32be(1920 << 16),
    u32be(1080 << 16),
  );
  return cat(box('ftyp', enc('isom'), u32be(0)), box('moov', mvhd, box('trak', tkhd)));
}
