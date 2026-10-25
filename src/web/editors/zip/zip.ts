// Reading a ZIP in the browser (ADR-051). The archive's own list (the central directory) is read here,
// so password-protected entries are known before anything is unpacked; fflate only inflates. Every
// file is checked against its CRC, and an entry never comes out bigger than the size the list gives
// it (fflate writes into a buffer of that size), so a lying ZIP can't fill the phone's memory.
import { inflate, inflateSync } from 'fflate';

export interface ZipEntry {
  /** The name as stored in the archive. */
  name: string;
  /** Folders and file name, cleaned: no "..", no absolute path, no control characters. */
  path: string[];
  dir: boolean;
  /** Unpacked size. */
  size: number;
  packed: number;
  method: number;
  encrypted: boolean;
  crc: number;
  /** Where the entry's local header starts. */
  offset: number;
}

export class ZipError extends Error {}

const STORED = 0;
const DEFLATED = 8;
// Small entries inflate here; bigger ones in fflate's worker, so the page doesn't freeze.
const SYNC_MAX = 512 * 1024;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** Names are UTF-8 when the entry says so, and usually when it doesn't; older tools wrote Latin. */
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
  return new TextDecoder().decode(bytes);
}

// The same cleaning the Worker does to names (worker/lib/names.ts), per folder, plus what makes a
// path leave its folder: "..", "/" at the start, a drive letter.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function safePath(name: string): string[] {
  return name
    .split(/[\\/]+/)
    .map((s) =>
      s
        .normalize('NFC')
        .replace(CONTROL, '')
        .trim()
        .replace(/[. ]+$/, ''),
    )
    .filter((s, i) => s !== '' && !(i === 0 && /^[a-z]:$/i.test(s)));
}

/** What other systems leave in archives: Mac resource forks and folder settings. */
export function isJunk(path: string[]): boolean {
  const last = path[path.length - 1] ?? '';
  return path[0] === '__MACOSX' || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(last);
}

export function listZip(zip: Uint8Array): ZipEntry[] {
  let end = zip.length - 22;
  const stop = Math.max(0, zip.length - 22 - 0xffff);
  while (end >= stop && u32(zip, end) !== 0x06054b50) end--;
  if (end < stop) throw new ZipError('not a zip');
  let count = u16(zip, end + 10);
  let at = u32(zip, end + 16);
  // ZIP64: the real count and position are in the ZIP64 end record.
  if (end >= 20 && u32(zip, end - 20) === 0x07064b50) {
    const z = u64(zip, end - 12);
    if (z + 56 <= zip.length && u32(zip, z) === 0x06064b50) {
      count = u64(zip, z + 32);
      at = u64(zip, z + 48);
    }
  }
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw new ZipError('bad directory');
    const flags = u16(zip, at + 8);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const name = decodeName(zip.subarray(at + 46, at + 46 + nameLen), (flags & 0x800) !== 0);
    let size = u32(zip, at + 24);
    let packed = u32(zip, at + 20);
    let offset = u32(zip, at + 42);
    // ZIP64 extra field: the 64-bit values, in this order, for the fields that are full.
    for (let x = at + 46 + nameLen; x + 4 <= at + 46 + nameLen + extraLen;) {
      const id = u16(zip, x);
      const len = u16(zip, x + 2);
      if (id === 0x0001) {
        let p = x + 4;
        if (size === 0xffffffff) {
          size = u64(zip, p);
          p += 8;
        }
        if (packed === 0xffffffff) {
          packed = u64(zip, p);
          p += 8;
        }
        if (offset === 0xffffffff) offset = u64(zip, p);
      }
      x += 4 + len;
    }
    out.push({
      name,
      path: safePath(name),
      dir: /[\\/]$/.test(name),
      size,
      packed,
      method: u16(zip, at + 10),
      encrypted: (flags & 1) !== 0,
      crc: u32(zip, at + 16),
      offset,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The worker gets its own copy of the entry, handed over: a view into the archive would copy all of it.
const inflateAsync = (data: Uint8Array, size: number) =>
  new Promise<Uint8Array>((resolve, reject) =>
    inflate(data.slice(), { size, consume: true }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

/** One entry's bytes, checked against its CRC. */
export async function readEntry(zip: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  if (e.encrypted) throw new ZipError('encrypted');
  const at = e.offset;
  if (at + 30 > zip.length || u32(zip, at) !== 0x04034b50) throw new ZipError('bad entry');
  const start = at + 30 + u16(zip, at + 26) + u16(zip, at + 28);
  const packed = zip.subarray(start, start + e.packed);
  if (packed.length !== e.packed) throw new ZipError('cut short');
  let data: Uint8Array;
  if (e.size === 0) data = new Uint8Array(0);
  else if (e.method === STORED) data = packed.slice();
  else if (e.method === DEFLATED)
    data =
      e.size <= SYNC_MAX
        ? inflateSync(packed, { out: new Uint8Array(e.size) })
        : await inflateAsync(packed, e.size);
  else throw new ZipError(`method ${e.method}`);
  if (data.length !== e.size || crc32(data) !== e.crc) throw new ZipError('damaged');
  return data;
}
