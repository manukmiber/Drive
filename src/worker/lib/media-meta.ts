// D8 (ADR-091): when a photo or video was taken, and its size and length, read from the first bytes
// of the file (and the last ones for a video whose `moov` is at the end). Our own small readers:
// EXIF in JPEG (APP1), PNG (eXIf), WebP (EXIF chunk) and HEIC/AVIF (the Exif item), image sizes
// from their headers, and MP4/MOV `mvhd` + `tkhd`. Only the capture time, orientation and size are
// read; GPS and everything else in EXIF is never looked at, let alone kept.

export interface MediaMeta {
  /** ms UTC; null when the file does not say. */
  takenAt: number | null;
  /** As shown (EXIF orientation applied); 0 = unknown. */
  width: number;
  height: number;
  /** Videos only; 0 otherwise. */
  durationMs: number;
}

/** Where more bytes are needed (HEIC keeps its EXIF item anywhere in the file). */
export interface MoreBytes {
  offset: number;
  length: number;
}

const WIB_MS = 7 * 3600_000;
/** Seconds from 1904-01-01 (MP4 time) to 1970-01-01. */
const MP4_EPOCH = 2_082_844_800;
/** Dates before this or after 2100 are camera clocks that were never set. */
const MIN_DATE = Date.UTC(1990, 0, 1);
const MAX_DATE = Date.UTC(2100, 0, 1);

const sane = (ms: number | null) => (ms !== null && ms >= MIN_DATE && ms < MAX_DATE ? ms : null);

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** "2024:05:01 13:45:10" with an optional "+07:00": ms UTC (no offset = WIB, see ADR-091). */
export function exifDate(value: string, offset: string | null): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!y || !mo || !d) return null;
  let shift = WIB_MS;
  const o = offset ? /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim()) : null;
  if (o) shift = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 3600_000 + Number(o[3]) * 60_000);
  return sane(Date.UTC(y, mo - 1, d, h, mi, s) - shift);
}

interface Tiff {
  takenAt: number | null;
  orientation: number;
  width: number;
  height: number;
}

/** The parts of a TIFF/EXIF block we read: capture time, its offset, orientation, pixel size. */
export function readTiff(b: Uint8Array, start = 0): Tiff {
  const out: Tiff = { takenAt: null, orientation: 1, width: 0, height: 0 };
  if (start + 8 > b.length) return out;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return out;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => (at + 2 <= b.length ? v.getUint16(at, le) : 0);
  const u32 = (at: number) => (at + 4 <= b.length ? v.getUint32(at, le) : 0);
  let date: string | null = null;
  let offset: string | null = null;
  const str = (entry: number) => {
    const count = u32(entry + 4);
    const at = count <= 4 ? entry + 8 : start + u32(entry + 8);
    return ascii(b, at, Math.min(count, 64)).replace(/\0.*$/, '');
  };
  const num = (entry: number) => (u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
  const walk = (ifd: number, depth: number) => {
    if (depth > 2 || ifd <= 0 || start + ifd + 2 > b.length) return;
    const n = Math.min(u16(start + ifd), 200);
    for (let i = 0; i < n; i++) {
      const e = start + ifd + 2 + i * 12;
      if (e + 12 > b.length) return;
      switch (u16(e)) {
        case 0x0112:
          out.orientation = u16(e + 8);
          break;
        case 0x8769: // Exif IFD
          walk(u32(e + 8), depth + 1);
          break;
        case 0x9003: // DateTimeOriginal
          date = str(e);
          break;
        case 0x9011: // OffsetTimeOriginal
          offset = str(e);
          break;
        case 0x0132: // DateTime (only if there is no original)
          if (!date) date = str(e);
          break;
        case 0xa002:
          out.width = num(e);
          break;
        case 0xa003:
          out.height = num(e);
          break;
        // 0x8825 (GPS) and the rest are deliberately not followed.
      }
    }
  };
  walk(u32(start + 4), 0);
  if (date) out.takenAt = exifDate(date, offset);
  return out;
}

function oriented(w: number, h: number, orientation: number): [number, number] {
  return orientation >= 5 && orientation <= 8 ? [h, w] : [w, h];
}

function jpegMeta(b: Uint8Array): MediaMeta {
  let tiff: Tiff | null = null;
  let w = 0;
  let h = 0;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && !tiff && ascii(b, i + 4, 6) === 'Exif\0\0') tiff = readTiff(b, i + 10);
    const sof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof && i + 9 <= b.length) {
      h = (b[i + 5]! << 8) | b[i + 6]!;
      w = (b[i + 7]! << 8) | b[i + 8]!;
      break;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  const [width, height] = oriented(
    w || tiff?.width || 0,
    h || tiff?.height || 0,
    tiff?.orientation ?? 1,
  );
  return { takenAt: tiff?.takenAt ?? null, width, height, durationMs: 0 };
}

function pngMeta(b: Uint8Array): MediaMeta {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = b.length >= 24 ? v.getUint32(16) : 0;
  const height = b.length >= 24 ? v.getUint32(20) : 0;
  let tiff: Tiff | null = null;
  for (let i = 8; i + 8 <= b.length;) {
    const len = v.getUint32(i);
    const type = ascii(b, i + 4, 4);
    if (type === 'eXIf') tiff = readTiff(b, i + 8);
    if (type === 'IDAT' || type === 'IEND' || tiff) break;
    i += 12 + len;
  }
  const [w, h] = oriented(width, height, tiff?.orientation ?? 1);
  return { takenAt: tiff?.takenAt ?? null, width: w, height: h, durationMs: 0 };
}

function webpMeta(b: Uint8Array): MediaMeta {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w = 0;
  let h = 0;
  let tiff: Tiff | null = null;
  for (let i = 12; i + 8 <= b.length;) {
    const type = ascii(b, i, 4);
    const len = v.getUint32(i + 4, true);
    const d = i + 8;
    if (type === 'VP8X' && d + 10 <= b.length) {
      w = 1 + (b[d + 4]! | (b[d + 5]! << 8) | (b[d + 6]! << 16));
      h = 1 + (b[d + 7]! | (b[d + 8]! << 8) | (b[d + 9]! << 16));
    } else if (type === 'VP8 ' && !w && d + 10 <= b.length) {
      w = v.getUint16(d + 6, true) & 0x3fff;
      h = v.getUint16(d + 8, true) & 0x3fff;
    } else if (type === 'VP8L' && !w && d + 5 <= b.length) {
      const bits = v.getUint32(d + 1, true);
      w = (bits & 0x3fff) + 1;
      h = ((bits >> 14) & 0x3fff) + 1;
    } else if (type === 'EXIF') {
      tiff = readTiff(b, ascii(b, d, 6) === 'Exif\0\0' ? d + 6 : d);
    }
    i = d + len + (len & 1);
  }
  const [width, height] = oriented(w, h, tiff?.orientation ?? 1);
  return { takenAt: tiff?.takenAt ?? null, width, height, durationMs: 0 };
}

interface Box {
  type: string;
  start: number;
  /** First byte of the payload. */
  data: number;
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  for (let i = from; i + 8 <= Math.min(to, b.length) && out.length < 500;) {
    let size = v.getUint32(i);
    const type = ascii(b, i + 4, 4);
    let data = i + 8;
    if (size === 1 && i + 16 <= b.length) {
      size = Number(v.getBigUint64(i + 8));
      data = i + 16;
    } else if (size === 0) size = to - i;
    if (size < 8) break;
    out.push({ type, start: i, data, end: i + size });
    i += size;
  }
  return out;
}

/** HEIC/AVIF: size from `ispe`, rotation from `irot`, and where the Exif item lies (from `iloc`). */
function heifMeta(b: Uint8Array): { meta: MediaMeta; exif: MoreBytes | null } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const meta: MediaMeta = { takenAt: null, width: 0, height: 0, durationMs: 0 };
  const top = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!top) return { meta, exif: null };
  const inner = boxes(b, top.data + 4, top.end);
  let exifId = -1;
  let rotate = false;
  const iinf = inner.find((x) => x.type === 'iinf');
  if (iinf) {
    const version = b[iinf.data]!;
    const first = iinf.data + 4 + (version === 0 ? 2 : 4);
    for (const e of boxes(b, first, iinf.end)) {
      if (e.type !== 'infe' || b[e.data]! < 2) continue;
      const big = b[e.data]! >= 3;
      const id = big ? v.getUint32(e.data + 4) : v.getUint16(e.data + 4);
      const typeAt = e.data + 4 + (big ? 4 : 2) + 2;
      if (ascii(b, typeAt, 4) === 'Exif') exifId = id;
    }
  }
  const iprp = inner.find((x) => x.type === 'iprp');
  const ipco = iprp ? boxes(b, iprp.data, iprp.end).find((x) => x.type === 'ipco') : undefined;
  if (ipco) {
    for (const p of boxes(b, ipco.data, ipco.end)) {
      if (p.type === 'ispe' && !meta.width && p.data + 12 <= b.length) {
        meta.width = v.getUint32(p.data + 4);
        meta.height = v.getUint32(p.data + 8);
      }
      if (p.type === 'irot' && (b[p.data]! & 3) % 2 === 1) rotate = true;
    }
  }
  if (rotate) [meta.width, meta.height] = [meta.height, meta.width];
  let exif: MoreBytes | null = null;
  const iloc = inner.find((x) => x.type === 'iloc');
  if (iloc && exifId >= 0) {
    const version = b[iloc.data]!;
    let at = iloc.data + 4;
    const sizes = (b[at]! << 8) | b[at + 1]!;
    const offSize = sizes >> 12;
    const lenSize = (sizes >> 8) & 15;
    const baseSize = (sizes >> 4) & 15;
    const idxSize = version >= 1 ? sizes & 15 : 0;
    at += 2;
    const read = (n: number) => {
      let x = 0;
      for (let k = 0; k < n; k++) x = x * 256 + (b[at + k] ?? 0);
      at += n;
      return x;
    };
    const count = version < 2 ? read(2) : read(4);
    for (let i = 0; i < count && at < iloc.end; i++) {
      const id = version < 2 ? read(2) : read(4);
      if (version >= 1) read(2);
      read(2); // data reference index
      const base = read(baseSize);
      const extents = read(2);
      for (let k = 0; k < extents; k++) {
        if (idxSize) read(idxSize);
        const off = read(offSize);
        const len = read(lenSize);
        if (id === exifId && !exif)
          exif = { offset: base + off, length: Math.min(len, 256 * 1024) };
      }
    }
  }
  return { meta, exif };
}

/** The Exif item of a HEIC: 4 bytes saying where the TIFF header starts, then EXIF. */
export function heifExif(bytes: Uint8Array): Tiff {
  if (bytes.length < 8) return readTiff(new Uint8Array(0));
  const skip = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return readTiff(bytes, 4 + Math.min(skip, bytes.length));
}

/** MP4/MOV: duration and capture time from `mvhd`, size from the first track `tkhd` that has one. */
export function mp4Meta(b: Uint8Array): MediaMeta | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let meta: MediaMeta | null = null;
  for (let i = 4; i + 32 < b.length; i++) {
    if (b[i] !== 0x6d || ascii(b, i, 4) !== 'mvhd') continue;
    const version = b[i + 4];
    const created = version === 1 ? Number(v.getBigUint64(i + 8)) : v.getUint32(i + 8);
    const scale = version === 1 ? v.getUint32(i + 24) : v.getUint32(i + 16);
    const duration =
      version === 1 && i + 36 <= b.length ? Number(v.getBigUint64(i + 28)) : v.getUint32(i + 20);
    meta = {
      takenAt: created ? sane((created - MP4_EPOCH) * 1000) : null,
      width: 0,
      height: 0,
      durationMs: scale ? Math.round((duration / scale) * 1000) : 0,
    };
    break;
  }
  if (!meta) return null;
  for (let i = 4; i + 8 < b.length; i++) {
    if (b[i] !== 0x74 || ascii(b, i, 4) !== 'tkhd') continue;
    const version = b[i + 4];
    const at = i + 4 + (version === 1 ? 88 : 76);
    if (at + 8 > b.length) break;
    const w = v.getUint32(at) >>> 16;
    const h = v.getUint32(at + 4) >>> 16;
    if (w && h) {
      // A 90°/270° display matrix (portrait phone video) swaps what is shown.
      const m0 = v.getInt32(i + 4 + (version === 1 ? 52 : 40));
      const turned = m0 === 0;
      meta.width = turned ? h : w;
      meta.height = turned ? w : h;
      break;
    }
  }
  return meta;
}

export type MediaKind = 'jpeg' | 'png' | 'webp' | 'heif' | 'mp4' | null;

export function mediaKind(head: Uint8Array): MediaKind {
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return 'png';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (/^(heic|heix|mif1|msf1|avif|avis|hevc|heim|heis)$/.test(brand)) return 'heif';
    return 'mp4';
  }
  return null;
}

/**
 * Everything the head says. For HEIC, `more` names the Exif item when it lies past the head; for a
 * video without `mvhd` in the head, `tail` asks for the end of the file.
 */
export function headMeta(head: Uint8Array): {
  meta: MediaMeta | null;
  more?: MoreBytes;
  tail?: boolean;
} {
  switch (mediaKind(head)) {
    case 'jpeg':
      return { meta: jpegMeta(head) };
    case 'png':
      return { meta: pngMeta(head) };
    case 'webp':
      return { meta: webpMeta(head) };
    case 'heif': {
      const { meta, exif } = heifMeta(head);
      if (exif && exif.offset + exif.length <= head.length) {
        const t = heifExif(head.subarray(exif.offset, exif.offset + exif.length));
        meta.takenAt = t.takenAt;
        return { meta };
      }
      return exif ? { meta, more: exif } : { meta };
    }
    case 'mp4': {
      const meta = mp4Meta(head);
      return meta ? { meta } : { meta: null, tail: true };
    }
    default:
      return { meta: null };
  }
}

/** Reads what a stored file says, with at most three ranged reads. */
export async function readMediaMeta(
  bucket: R2Bucket,
  key: string,
  size: number,
  window = 256 * 1024,
): Promise<MediaMeta | null> {
  const get = async (offset: number, length: number) => {
    const o = await bucket.get(key, { range: { offset, length } });
    return o && 'body' in o ? new Uint8Array(await o.arrayBuffer()) : null;
  };
  const head = await get(0, Math.min(size, window));
  if (!head) return null;
  const first = headMeta(head);
  if (first.more && first.meta) {
    const exif = await get(first.more.offset, first.more.length);
    if (exif) first.meta.takenAt = heifExif(exif).takenAt;
    return first.meta;
  }
  if (first.tail && size > window) {
    const tailLen = Math.min(size, 4 * 1024 * 1024);
    const tail = await get(size - tailLen, tailLen);
    return tail ? mp4Meta(tail) : null;
  }
  return first.meta;
}
