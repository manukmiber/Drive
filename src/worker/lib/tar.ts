// POSIX tar (ustar + PAX extended headers) streamed from R2 (SPEC §7.2 TAR.ZST). The Worker builds
// the tar; Container `archiver` only compresses it. Sizes are known up front, so the total length is
// exact. PAX records carry names that don't fit ustar (long or non-ASCII) and sizes ≥ 8 GiB.
import type { ZipEntry } from './zip';

const enc = new TextEncoder();
const BLOCK = 512;
const USTAR_MAX_SIZE = 0o77777777777; // 11 octal digits

const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

function octal(value: number, width: number): string {
  return (
    value
      .toString(8)
      .padStart(width - 1, '0')
      .slice(-(width - 1)) + '\0'
  );
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/** Splits into ustar prefix/name when possible (ASCII, name ≤ 100, prefix ≤ 155). */
function ustarName(path: string): { name: string; prefix: string } | null {
  if (!isAscii(path)) return null;
  if (path.length <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return null;
}

/** One PAX record: "<len> key=value\n", where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).length;
  const digits = String(bodyLen).length;
  // The length field counts its own digits; adding them can roll over to one more digit.
  const len = String(bodyLen + digits).length > digits ? bodyLen + digits + 1 : bodyLen + digits;
  return `${len}${body}`;
}

function header(o: {
  name: string;
  prefix: string;
  size: number;
  mtime: number;
  type: '0' | '5' | 'x';
  mode: number;
}): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(o.name, 0, 100);
  put(octal(o.mode, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(Math.min(o.size, USTAR_MAX_SIZE), 12), 124, 12);
  put(octal(Math.max(0, Math.floor(o.mtime / 1000)), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces)
  put(o.type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(o.prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + ' ', 148, 8);
  return h;
}

/** Header block(s) for one entry: optional PAX header + data, then the ustar header. */
export function entryHeader(e: ZipEntry): Uint8Array {
  const dir = e.key === null;
  const path = dir && !e.path.endsWith('/') ? `${e.path}/` : e.path;
  const fit = ustarName(path);
  const records: string[] = [];
  if (!fit) records.push(paxRecord('path', path));
  if (e.size > USTAR_MAX_SIZE) records.push(paxRecord('size', String(e.size)));
  const main = header({
    name: fit?.name ?? path.slice(-100).replace(/[^\x20-\x7e]/g, '_'),
    prefix: fit?.prefix ?? '',
    size: dir ? 0 : e.size,
    mtime: e.mtime,
    type: dir ? '5' : '0',
    mode: dir ? 0o755 : 0o644,
  });
  if (!records.length) return main;
  const data = enc.encode(records.join(''));
  const pax = header({
    name: 'PaxHeader',
    prefix: '',
    size: data.length,
    mtime: e.mtime,
    type: 'x',
    mode: 0o644,
  });
  const out = new Uint8Array(BLOCK + data.length + pad(data.length) + BLOCK);
  out.set(pax, 0);
  out.set(data, BLOCK);
  out.set(main, BLOCK + data.length + pad(data.length));
  return out;
}

export function tarSize(entries: ZipEntry[]): number {
  let total = 2 * BLOCK; // end-of-archive marker
  for (const e of entries) {
    total += entryHeader(e).length;
    if (e.key) total += e.size + pad(e.size);
  }
  return total;
}

/** Streams the tar: header, R2 object body, padding … then two zero blocks. */
export function tarStream(bucket: R2Bucket, entries: ZipEntry[]): ReadableStream<Uint8Array> {
  let i = 0;
  let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let tail = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (body) {
          const { done, value } = await body.read();
          if (!done) return controller.enqueue(value);
          body = null;
          if (tail) {
            const zeros = new Uint8Array(tail);
            tail = 0;
            return controller.enqueue(zeros);
          }
          continue;
        }
        if (i >= entries.length) {
          controller.enqueue(new Uint8Array(2 * BLOCK));
          return controller.close();
        }
        const e = entries[i++]!;
        controller.enqueue(entryHeader(e));
        if (!e.key || e.size === 0) return;
        const obj = await bucket.get(e.key);
        if (!obj) throw new Error(`object missing: ${e.key}`);
        body = obj.body.getReader();
        tail = pad(e.size);
        return;
      }
    },
    async cancel(reason) {
      await body?.cancel(reason);
    },
  });
}
