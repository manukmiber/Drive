// R2Bucket shim on the local filesystem (ADR-001). Implements the subset Zeiko uses: head/get
// (with range + onlyIf), put, delete, list, and multipart uploads with R2's part rules
// (uniform part size, ≥ 5 MiB except the last part, ≤ 10,000 parts, auto-abort after 7 days).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MIN_PART = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MPU_TTL_MS = 7 * 24 * 3600 * 1000;

interface HttpMetadata {
  contentType?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  cacheControl?: string;
}

interface StoredMeta {
  key: string;
  size: number;
  etag: string;
  uploaded: number;
  version: string;
  httpMetadata: HttpMetadata;
  customMetadata: Record<string, string>;
}

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

interface Range {
  offset: number;
  length: number;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function toNodeReadable(value: PutValue): Readable {
  if (value === null) return Readable.from([]);
  if (typeof value === 'string') return Readable.from([Buffer.from(value)]);
  if (value instanceof ArrayBuffer) return Readable.from([Buffer.from(value)]);
  if (ArrayBuffer.isView(value))
    return Readable.from([Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
  if (value instanceof Blob) return Readable.fromWeb(value.stream() as never);
  return Readable.fromWeb(value as never);
}

class ShimR2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: HttpMetadata;
  readonly customMetadata: Record<string, string>;
  readonly checksums = { toJSON: () => ({}) };
  readonly storageClass = 'Standard';
  readonly range?: { offset: number; length: number };

  constructor(meta: StoredMeta, range?: Range) {
    this.key = meta.key;
    this.version = meta.version;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = new Date(meta.uploaded);
    this.httpMetadata = meta.httpMetadata;
    this.customMetadata = meta.customMetadata;
    if (range) this.range = range;
  }

  writeHttpMetadata(headers: Headers): void {
    const m = this.httpMetadata;
    if (m.contentType) headers.set('content-type', m.contentType);
    if (m.contentDisposition) headers.set('content-disposition', m.contentDisposition);
    if (m.contentEncoding) headers.set('content-encoding', m.contentEncoding);
    if (m.contentLanguage) headers.set('content-language', m.contentLanguage);
    if (m.cacheControl) headers.set('cache-control', m.cacheControl);
  }
}

class ShimR2ObjectBody extends ShimR2Object {
  readonly body: ReadableStream<Uint8Array>;
  constructor(meta: StoredMeta, path: string, range?: Range) {
    super(meta, range);
    const start = range?.offset ?? 0;
    const length = range?.length ?? meta.size;
    this.body =
      length === 0
        ? new ReadableStream({ start: (c) => c.close() })
        : (Readable.toWeb(
            createReadStream(path, { start, end: start + length - 1 }),
          ) as ReadableStream<Uint8Array>);
  }
  get bodyUsed(): boolean {
    return this.body.locked;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Response(this.body).arrayBuffer();
  }
  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }
  async text(): Promise<string> {
    return new Response(this.body).text();
  }
  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
  async blob(): Promise<Blob> {
    return new Response(this.body).blob();
  }
}

interface OnlyIf {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

function stripEtag(s: string): string {
  return s.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function conditionsPass(meta: StoredMeta, onlyIf: OnlyIf | Headers | undefined): boolean {
  if (!onlyIf) return true;
  let c: OnlyIf;
  if (onlyIf instanceof Headers) {
    c = {};
    const im = onlyIf.get('if-match');
    const inm = onlyIf.get('if-none-match');
    if (im) c.etagMatches = im;
    if (inm) c.etagDoesNotMatch = inm;
  } else c = onlyIf;
  if (
    c.etagMatches &&
    !c.etagMatches.split(',').some((e) => stripEtag(e) === meta.etag || e.trim() === '*')
  )
    return false;
  if (
    c.etagDoesNotMatch &&
    c.etagDoesNotMatch.split(',').some((e) => stripEtag(e) === meta.etag || e.trim() === '*')
  )
    return false;
  if (c.uploadedBefore && meta.uploaded >= c.uploadedBefore.getTime()) return false;
  if (c.uploadedAfter && meta.uploaded <= c.uploadedAfter.getTime()) return false;
  return true;
}

export class R2ShimError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`${message} (${code})`);
  }
}

export class ShimR2Bucket {
  private objDir: string;
  private mpuDir: string;
  private tmpDir: string;

  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.objDir = join(root, 'objects');
    this.mpuDir = join(root, 'mpu');
    this.tmpDir = join(root, 'tmp');
  }

  async init(): Promise<this> {
    await Promise.all(
      [this.objDir, this.mpuDir, this.tmpDir].map((d) => mkdir(d, { recursive: true })),
    );
    return this;
  }

  private paths(key: string) {
    const h = hashKey(key);
    return { data: join(this.objDir, `${h}.bin`), meta: join(this.objDir, `${h}.json`) };
  }

  private async readMeta(key: string): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.paths(key).meta, 'utf8')) as StoredMeta;
    } catch {
      return null;
    }
  }

  async head(key: string): Promise<ShimR2Object | null> {
    const meta = await this.readMeta(key);
    return meta ? new ShimR2Object(meta) : null;
  }

  async get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number; suffix?: number } | Headers;
      onlyIf?: OnlyIf | Headers;
    },
  ): Promise<ShimR2ObjectBody | ShimR2Object | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;
    if (!conditionsPass(meta, options?.onlyIf)) return new ShimR2Object(meta);
    let range: Range | undefined;
    const r = options?.range;
    if (r && !(r instanceof Headers)) {
      if (r.suffix !== undefined) {
        const len = Math.min(r.suffix, meta.size);
        range = { offset: meta.size - len, length: len };
      } else {
        const offset = r.offset ?? 0;
        if (offset > meta.size) throw new R2ShimError(10039, 'InvalidRange');
        const length = Math.min(r.length ?? meta.size - offset, meta.size - offset);
        range = { offset, length };
      }
    }
    return new ShimR2ObjectBody(meta, this.paths(key).data, range);
  }

  async put(
    key: string,
    value: PutValue,
    options?: {
      httpMetadata?: HttpMetadata | Headers;
      customMetadata?: Record<string, string>;
      onlyIf?: OnlyIf | Headers;
    },
  ): Promise<ShimR2Object | null> {
    if (options?.onlyIf) {
      const existing = await this.readMeta(key);
      if (existing && !conditionsPass(existing, options.onlyIf)) return null;
    }
    const tmp = join(this.tmpDir, `${crypto.randomUUID()}.part`);
    const md5 = createHash('md5');
    let size = 0;
    await pipeline(
      toNodeReadable(value),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          md5.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp),
    );
    return this.commit(key, tmp, size, md5.digest('hex'), options);
  }

  private async commit(
    key: string,
    tmpPath: string,
    size: number,
    etag: string,
    options?: { httpMetadata?: HttpMetadata | Headers; customMetadata?: Record<string, string> },
  ): Promise<ShimR2Object> {
    const p = this.paths(key);
    const hm = options?.httpMetadata;
    const httpMetadata: HttpMetadata =
      hm instanceof Headers
        ? Object.fromEntries(
            [
              ['contentType', hm.get('content-type')],
              ['contentDisposition', hm.get('content-disposition')],
              ['cacheControl', hm.get('cache-control')],
            ].filter(([, v]) => v),
          )
        : (hm ?? {});
    const meta: StoredMeta = {
      key,
      size,
      etag,
      uploaded: this.now(),
      version: crypto.randomUUID().replace(/-/g, ''),
      httpMetadata,
      customMetadata: options?.customMetadata ?? {},
    };
    await rename(tmpPath, p.data);
    await writeFile(p.meta, JSON.stringify(meta));
    return new ShimR2Object(meta);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const p = this.paths(key);
      await rm(p.data, { force: true });
      await rm(p.meta, { force: true });
    }
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }) {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(options?.limit ?? 1000, 1000);
    const files = (await readdir(this.objDir)).filter((f) => f.endsWith('.json'));
    const metas: StoredMeta[] = [];
    for (const f of files) {
      try {
        const m = JSON.parse(await readFile(join(this.objDir, f), 'utf8')) as StoredMeta;
        if (m.key.startsWith(prefix)) metas.push(m);
      } catch {
        // object being written
      }
    }
    metas.sort((a, b) => (a.key < b.key ? -1 : 1));
    const delimited = new Set<string>();
    let entries = metas;
    if (options?.delimiter) {
      entries = [];
      for (const m of metas) {
        const rest = m.key.slice(prefix.length);
        const i = rest.indexOf(options.delimiter);
        if (i === -1) entries.push(m);
        else delimited.add(prefix + rest.slice(0, i + options.delimiter.length));
      }
    }
    const start = options?.cursor ? entries.findIndex((m) => m.key > options.cursor!) : 0;
    const page = start === -1 ? [] : entries.slice(start, start + limit);
    const truncated = start !== -1 && start + limit < entries.length;
    return {
      objects: page.map((m) => new ShimR2Object(m)),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1]!.key } : {}),
      delimitedPrefixes: [...delimited],
    };
  }

  // ── multipart ──
  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: HttpMetadata; customMetadata?: Record<string, string> },
  ): Promise<ShimR2MultipartUpload> {
    const uploadId = crypto.randomUUID().replace(/-/g, '');
    const dir = join(this.mpuDir, uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'upload.json'),
      JSON.stringify({ key, createdAt: this.now(), options: options ?? {} }),
    );
    return new ShimR2MultipartUpload(this, key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): ShimR2MultipartUpload {
    return new ShimR2MultipartUpload(this, key, uploadId);
  }

  /** @internal */
  async mpuState(key: string, uploadId: string) {
    const dir = join(this.mpuDir, uploadId);
    try {
      const info = JSON.parse(await readFile(join(dir, 'upload.json'), 'utf8')) as {
        key: string;
        createdAt: number;
        options: { httpMetadata?: HttpMetadata; customMetadata?: Record<string, string> };
      };
      if (info.key !== key) throw new R2ShimError(10024, 'NoSuchUpload');
      if (this.now() - info.createdAt > MPU_TTL_MS) {
        await rm(dir, { recursive: true, force: true });
        throw new R2ShimError(10024, 'NoSuchUpload');
      }
      return { dir, info };
    } catch (e) {
      if (e instanceof R2ShimError) throw e;
      throw new R2ShimError(10024, 'NoSuchUpload');
    }
  }

  /** @internal */
  async mpuComplete(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ) {
    const { dir, info } = await this.mpuState(key, uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (sorted.length === 0 || sorted.length > MAX_PARTS)
      throw new R2ShimError(10025, 'InvalidPart');
    const sizes: number[] = [];
    for (const p of sorted) {
      let st;
      try {
        st = await stat(join(dir, `${p.partNumber}.bin`));
      } catch {
        throw new R2ShimError(10025, 'InvalidPart');
      }
      const etag = await readFile(join(dir, `${p.partNumber}.etag`), 'utf8');
      if (etag !== p.etag) throw new R2ShimError(10025, 'InvalidPart');
      sizes.push(st.size);
    }
    for (let i = 0; i < sizes.length - 1; i++) {
      if (sizes[i]! < MIN_PART) throw new R2ShimError(10011, 'EntityTooSmall');
      if (sizes[i] !== sizes[0])
        throw new R2ShimError(10048, 'All non-trailing parts must have the same size');
    }
    if (sizes.length > 1 && sizes[sizes.length - 1]! > sizes[0]!) {
      throw new R2ShimError(10048, 'All non-trailing parts must have the same size');
    }
    const tmp = join(this.tmpDir, `${uploadId}.assembling`);
    const out = createWriteStream(tmp);
    const md5s = createHash('md5');
    let size = 0;
    for (const p of sorted) {
      const partPath = join(dir, `${p.partNumber}.bin`);
      md5s.update(Buffer.from(p.etag, 'hex'));
      await pipeline(createReadStream(partPath), out, { end: false });
      size += (await stat(partPath)).size;
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
    const etag = `${md5s.digest('hex')}-${sorted.length}`;
    const obj = await this.commit(key, tmp, size, etag, info.options);
    await rm(dir, { recursive: true, force: true });
    return obj;
  }

  /** @internal */
  async mpuAbort(key: string, uploadId: string): Promise<void> {
    const { dir } = await this.mpuState(key, uploadId);
    await rm(dir, { recursive: true, force: true });
  }

  /** @internal */
  async mpuUploadPart(key: string, uploadId: string, partNumber: number, value: PutValue) {
    const { dir } = await this.mpuState(key, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw new R2ShimError(10025, 'InvalidPart');
    }
    const tmp = join(this.tmpDir, `${uploadId}.${partNumber}.${crypto.randomUUID()}`);
    const md5 = createHash('md5');
    await pipeline(
      toNodeReadable(value),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          md5.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp),
    );
    const etag = md5.digest('hex');
    await rename(tmp, join(dir, `${partNumber}.bin`));
    await writeFile(join(dir, `${partNumber}.etag`), etag);
    return { partNumber, etag };
  }
}

export class ShimR2MultipartUpload {
  constructor(
    private bucket: ShimR2Bucket,
    readonly key: string,
    readonly uploadId: string,
  ) {}
  uploadPart(partNumber: number, value: PutValue) {
    return this.bucket.mpuUploadPart(this.key, this.uploadId, partNumber, value);
  }
  abort(): Promise<void> {
    return this.bucket.mpuAbort(this.key, this.uploadId);
  }
  complete(parts: Array<{ partNumber: number; etag: string }>) {
    return this.bucket.mpuComplete(this.key, this.uploadId, parts);
  }
}
