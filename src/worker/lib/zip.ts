// Deterministic ZIP "store" archives streamed straight from R2 (SPEC §7.2). CRC32 and sizes are
// known from the scan, so headers are written up front: total length is computable, Range works,
// and the Worker does almost no CPU work. ZIP64 is used when sizes/offsets/entry counts need it.

export interface ZipEntry {
  /** Path inside the archive ("Folder/sub/file.txt"); directories end with "/". */
  path: string;
  size: number;
  crc32: number;
  /** ms epoch; stored as DOS time in WIB. */
  mtime: number;
  /** R2 key for file data; null for directories. */
  key: string | null;
}

type Segment =
  | { kind: 'bytes'; data: Uint8Array; offset: number }
  | { kind: 'object'; key: string; size: number; offset: number };

const enc = new TextEncoder();
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const WIB = 7 * 3600_000;

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms + WIB);
  const year = Math.max(1980, Math.min(2107, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

class Buf {
  private parts: number[] = [];
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 0x100000000);
    return this.u32(Math.floor(v / 0x100000000));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** Makes archive paths unique and safe (no "..", no leading "/", Windows-hostile chars replaced). */
export function uniquePaths(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Set<string>();
  return entries
    .map((e) => {
      const isDir = e.path.endsWith('/');
      const clean = e.path
        .split('/')
        .filter((p) => p && p !== '.' && p !== '..')
        .map((p) => p.replace(/[<>:"|?*\\]/g, '_'))
        .join('/');
      let path = isDir ? `${clean}/` : clean;
      if (!isDir) {
        const dot = path.lastIndexOf('.');
        const slash = path.lastIndexOf('/');
        const base = dot > slash + 1 ? path.slice(0, dot) : path;
        const ext = dot > slash + 1 ? path.slice(dot) : '';
        for (let n = 1; seen.has(path.toLowerCase()); n++) path = `${base} (${n})${ext}`;
      } else if (seen.has(path.toLowerCase())) {
        return null;
      }
      seen.add(path.toLowerCase());
      return { ...e, path };
    })
    .filter((e): e is ZipEntry => e !== null);
}

export interface ZipPlan {
  segments: Segment[];
  size: number;
}

export function planZip(input: ZipEntry[]): ZipPlan {
  const entries = uniquePaths(input);
  const segments: Segment[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const isDir = e.key === null;
    const { time, date } = dosDateTime(e.mtime);
    const needs64 = e.size >= MAX32 || offset >= MAX32;
    // Local header: ZIP64 extra carries both sizes when needed.
    const localExtra = needs64
      ? new Buf().u16(0x0001).u16(16).u64(e.size).u64(e.size).done()
      : new Uint8Array(0);
    const local = new Buf()
      .u32(0x04034b50)
      .u16(needs64 ? 45 : 20)
      .u16(0x0800) // UTF-8 names
      .u16(0) // stored
      .u16(time)
      .u16(date)
      .u32(e.crc32 >>> 0)
      .u32(needs64 ? MAX32 : e.size)
      .u32(needs64 ? MAX32 : e.size)
      .u16(name.length)
      .u16(localExtra.length)
      .bytes(name)
      .bytes(localExtra)
      .done();
    segments.push({ kind: 'bytes', data: local, offset });
    const localOffset = offset;
    offset += local.length;
    if (!isDir && e.size > 0) {
      segments.push({ kind: 'object', key: e.key!, size: e.size, offset });
      offset += e.size;
    }
    const cdExtra = needs64
      ? new Buf().u16(0x0001).u16(24).u64(e.size).u64(e.size).u64(localOffset).done()
      : new Uint8Array(0);
    central.push(
      new Buf()
        .u32(0x02014b50)
        .u16((3 << 8) | 45) // made by: Unix, spec 4.5
        .u16(needs64 ? 45 : 20)
        .u16(0x0800)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(e.crc32 >>> 0)
        .u32(needs64 ? MAX32 : e.size)
        .u32(needs64 ? MAX32 : e.size)
        .u16(name.length)
        .u16(cdExtra.length)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attrs
        .u32(isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0)
        .u32(needs64 ? MAX32 : localOffset)
        .bytes(name)
        .bytes(cdExtra)
        .done(),
    );
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    segments.push({ kind: 'bytes', data: c, offset });
    offset += c.length;
    cdSize += c.length;
  }
  const zip64 = entries.length >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
  const tail = new Buf();
  if (zip64) {
    const eocd64At = offset;
    tail
      .u32(0x06064b50)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(entries.length)
      .u64(entries.length)
      .u64(cdSize)
      .u64(cdStart)
      .u32(0x07064b50)
      .u32(0)
      .u64(eocd64At)
      .u32(1);
  }
  tail
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(zip64 ? MAX16 : entries.length)
    .u16(zip64 ? MAX16 : entries.length)
    .u32(zip64 ? MAX32 : cdSize)
    .u32(zip64 ? MAX32 : cdStart)
    .u16(0);
  const tailBytes = tail.done();
  segments.push({ kind: 'bytes', data: tailBytes, offset });
  offset += tailBytes.length;
  return { segments, size: offset };
}

/** Streams bytes [start, end] (inclusive) of the planned archive. */
export function zipStream(
  bucket: R2Bucket,
  plan: ZipPlan,
  start = 0,
  end = plan.size - 1,
): ReadableStream<Uint8Array> {
  const parts = plan.segments.filter((s) => {
    const len = s.kind === 'bytes' ? s.data.length : s.size;
    return s.offset + len > start && s.offset <= end;
  });
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          reader = null;
        }
        const seg = parts[i++];
        if (!seg) {
          controller.close();
          return;
        }
        const len = seg.kind === 'bytes' ? seg.data.length : seg.size;
        const from = Math.max(start, seg.offset) - seg.offset;
        const to = Math.min(end, seg.offset + len - 1) - seg.offset;
        if (seg.kind === 'bytes') {
          controller.enqueue(seg.data.subarray(from, to + 1));
          return;
        }
        const obj = await bucket.get(seg.key, { range: { offset: from, length: to - from + 1 } });
        if (!obj || !('body' in obj)) {
          controller.error(new Error(`object missing: ${seg.key}`));
          return;
        }
        reader = obj.body.getReader();
      }
    },
    async cancel() {
      await reader?.cancel();
    },
  });
}

/**
 * Wraps a stream so the platform sends Content-Length (Workers' FixedLengthStream); falls back to
 * the stream itself elsewhere (Node dev shims).
 */
export function withKnownLength(
  stream: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  const FLS = (
    globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }
  ).FixedLengthStream;
  if (!FLS) return stream;
  const fixed = new FLS(length);
  void stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

/**
 * "ZIP, Terkompres" streamed with CompressionStream('deflate-raw') + data descriptors (SPEC §7.2).
 * Sizes are unknown up front, so no Content-Length/Range; callers cap the input at
 * zip_deflate_stream_max_bytes (2 GB) which keeps every offset below 4 GiB (no ZIP64 needed).
 */
export function zipDeflateStream(bucket: R2Bucket, input: ZipEntry[]): ReadableStream<Uint8Array> {
  const entries = uniquePaths(input);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  void (async () => {
    let offset = 0;
    const central: Uint8Array[] = [];
    const write = async (b: Uint8Array) => {
      await w.write(b);
      offset += b.length;
    };
    for (const e of entries) {
      const name = enc.encode(e.path);
      const { time, date } = dosDateTime(e.mtime);
      const deflate = e.key !== null && e.size > 0;
      const flags = deflate ? 0x0808 : 0x0800;
      const localOffset = offset;
      await write(
        new Buf()
          .u32(0x04034b50)
          .u16(20)
          .u16(flags)
          .u16(deflate ? 8 : 0)
          .u16(time)
          .u16(date)
          .u32(deflate ? 0 : e.crc32 >>> 0)
          .u32(0)
          .u32(0)
          .u16(name.length)
          .u16(0)
          .bytes(name)
          .done(),
      );
      let csize = 0;
      if (deflate) {
        const obj = await bucket.get(e.key!);
        if (!obj || !('body' in obj)) throw new Error(`object missing: ${e.key}`);
        const reader = obj.body.pipeThrough(new CompressionStream('deflate-raw')).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          csize += value.length;
          await write(value);
        }
        await write(
          new Buf()
            .u32(0x08074b50)
            .u32(e.crc32 >>> 0)
            .u32(csize)
            .u32(e.size)
            .done(),
        );
      }
      central.push(
        new Buf()
          .u32(0x02014b50)
          .u16((3 << 8) | 20)
          .u16(20)
          .u16(flags)
          .u16(deflate ? 8 : 0)
          .u16(time)
          .u16(date)
          .u32(e.crc32 >>> 0)
          .u32(csize)
          .u32(deflate ? e.size : 0)
          .u16(name.length)
          .u16(0)
          .u16(0)
          .u16(0)
          .u16(0)
          .u32(e.key === null ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0)
          .u32(localOffset)
          .bytes(name)
          .done(),
      );
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      await write(c);
      cdSize += c.length;
    }
    await write(
      new Buf()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(Math.min(entries.length, MAX16))
        .u16(Math.min(entries.length, MAX16))
        .u32(cdSize)
        .u32(cdStart)
        .u16(0)
        .done(),
    );
    await w.close();
  })().catch((e) => w.abort(e));
  return readable;
}
