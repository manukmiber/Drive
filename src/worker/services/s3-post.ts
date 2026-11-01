// PostObject (S8 part 4, ADR-076): uploads from an HTML form straight to a bucket, allowed by a
// policy the bucket owner signed with SigV4. The form is read as it streams: the small fields come
// first (at most 20 KB, as Amazon), then the file, which goes to R2 without being buffered. Its
// size is worked out from Content-Length, since R2 needs it up front.
import { S3Error } from '../lib/s3-errors';

/** Cloudflare's own request body cap. */
export const MAX_POST_BYTES = 100 * 1000 * 1000;
const MAX_FIELDS_BYTES = 20 * 1024;
const MAX_PART_HEADER = 8 * 1024;

export interface PostForm {
  /** Lowercase field name → value (the first one wins, like Amazon). */
  fields: Map<string, string>;
  file: {
    filename: string;
    contentType: string | null;
    size: number;
    stream: ReadableStream<Uint8Array>;
  } | null;
}

const malformed = (m = 'The body of your POST request is not well-formed multipart/form-data.') =>
  new S3Error('MalformedPOSTRequest', m);

const enc = new TextEncoder();
const dec = new TextDecoder();

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (
    let i = hay.indexOf(first!, from);
    i !== -1 && i + needle.length <= hay.length;
    i = hay.indexOf(first!, i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function isPostForm(h: Headers): boolean {
  return /^multipart\/form-data\s*;/i.test(h.get('content-type') ?? '');
}

/** Reads the fields, and hands the file over as a stream of exactly its bytes. */
export async function readPostForm(req: Request): Promise<PostForm> {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers.get('content-type') ?? '');
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary || !req.body) throw malformed();
  const total = Number(req.headers.get('content-length'));
  if (!Number.isSafeInteger(total) || total <= 0)
    throw new S3Error('MissingContentLength', 'You must provide the Content-Length HTTP header.');
  if (total > MAX_POST_BYTES)
    throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size.');
  const reader = req.body.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let offset = 0; // body offset of buf[0]
  const pull = async (): Promise<boolean> => {
    const { done, value } = await reader.read();
    if (done) return false;
    buf = concat(buf, value);
    if (offset + buf.length > total) throw malformed();
    return true;
  };
  const take = (n: number) => {
    buf = buf.subarray(n);
    offset += n;
  };
  const delimiter = enc.encode(`--${boundary}`);
  const between = enc.encode(`\r\n--${boundary}`);
  const fields = new Map<string, string>();

  // The first delimiter (a preamble before it is allowed and skipped).
  for (;;) {
    const at = indexOf(buf, delimiter);
    if (at !== -1) {
      take(at + delimiter.length);
      break;
    }
    if (buf.length > MAX_PART_HEADER || !(await pull())) throw malformed();
  }
  for (;;) {
    while (buf.length < 2) if (!(await pull())) throw malformed();
    if (buf[0] === 0x2d && buf[1] === 0x2d) {
      // "--": the form ended without a file.
      await reader.cancel().catch(() => undefined);
      return { fields, file: null };
    }
    if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw malformed();
    take(2);
    let end: number;
    while ((end = indexOf(buf, enc.encode('\r\n\r\n'))) === -1) {
      if (buf.length > MAX_PART_HEADER || !(await pull())) throw malformed();
    }
    const headers = dec.decode(buf.subarray(0, end));
    take(end + 4);
    const disposition = /^content-disposition:\s*form-data(.*)$/im.exec(headers)?.[1] ?? '';
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) throw malformed();
    if (name.toLowerCase() === 'file') {
      const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? '';
      const contentType = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? null;
      const closing = enc.encode(`\r\n--${boundary}--\r\n`);
      const size = total - offset - closing.length;
      if (size < 0) throw malformed();
      return {
        fields,
        file: { filename, contentType, size, stream: fileStream(reader, buf, size, closing) },
      };
    }
    let at: number;
    while ((at = indexOf(buf, between)) === -1) {
      if (offset + buf.length > MAX_FIELDS_BYTES || !(await pull()))
        throw new S3Error(
          'MaxMessageLengthExceeded',
          'The POST form fields must be at most 20 KB.',
        );
    }
    const lower = name.toLowerCase();
    if (!fields.has(lower)) fields.set(lower, dec.decode(buf.subarray(0, at)));
    take(at + between.length);
  }
}

/** Exactly `size` bytes, then a check that what follows is the form's closing delimiter. */
function fileStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  size: number,
  closing: Uint8Array,
): ReadableStream<Uint8Array> {
  let left = size;
  let pending: Uint8Array | null = head;
  let tail: Uint8Array = new Uint8Array(0);
  const finish = async (c: ReadableStreamDefaultController<Uint8Array>) => {
    while (tail.length < closing.length) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = concat(tail, value);
    }
    const ok = tail.length === closing.length && tail.every((b, i) => b === closing[i]);
    if (!ok)
      c.error(malformed('The file must be the last field, followed by the closing boundary.'));
    else c.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      let chunk: Uint8Array;
      if (pending) {
        chunk = pending;
        pending = null;
      } else if (left > 0) {
        const { done, value } = await reader.read();
        if (done) {
          c.error(new S3Error('IncompleteBody', 'The request body ended early.'));
          return;
        }
        chunk = value;
      } else chunk = new Uint8Array(0);
      const mine = chunk.subarray(0, Math.min(left, chunk.length));
      if (mine.length) c.enqueue(mine);
      left -= mine.length;
      if (mine.length < chunk.length) tail = concat(tail, chunk.subarray(mine.length));
      if (left === 0) await finish(c);
    },
    cancel: () => reader.cancel(),
  });
}

/** Amazon's POST policy: an expiry, and conditions every form field must meet. */
export function checkPostPolicy(
  policyB64: string,
  fields: Map<string, string>,
  bucket: string,
  fileSize: number,
  now: number,
): void {
  let policy: { expiration?: unknown; conditions?: unknown };
  try {
    policy = JSON.parse(atob(policyB64)) as typeof policy;
  } catch {
    throw new S3Error('InvalidPolicyDocument', 'Invalid Policy: Invalid JSON.');
  }
  const expires = typeof policy.expiration === 'string' ? Date.parse(policy.expiration) : NaN;
  if (Number.isNaN(expires))
    throw new S3Error('InvalidPolicyDocument', "Invalid Policy: Invalid 'expiration' value.");
  if (expires <= now)
    throw new S3Error('AccessDenied', 'Invalid according to Policy: Policy expired.');
  if (!Array.isArray(policy.conditions))
    throw new S3Error('InvalidPolicyDocument', "Invalid Policy: Missing 'conditions'.");
  const values = new Map(fields);
  values.set('bucket', bucket);
  const covered = new Set<string>();
  const failed = (c: unknown) =>
    new S3Error(
      'AccessDenied',
      `Invalid according to Policy: Policy Condition failed: ${JSON.stringify(c)}`,
    );
  for (const c of policy.conditions as unknown[]) {
    if (Array.isArray(c)) {
      const [op, a, b] = c as [unknown, unknown, unknown];
      const kind = typeof op === 'string' ? op.toLowerCase() : '';
      if (kind === 'content-length-range') {
        const min = Number(a);
        const max = Number(b);
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))
          throw new S3Error(
            'InvalidPolicyDocument',
            'Invalid Policy: Invalid content-length-range.',
          );
        if (fileSize > max)
          throw new S3Error(
            'EntityTooLarge',
            'Your proposed upload exceeds the maximum allowed size',
          );
        if (fileSize < min)
          throw new S3Error(
            'EntityTooSmall',
            'Your proposed upload is smaller than the minimum allowed size',
          );
        continue;
      }
      if (
        (kind !== 'eq' && kind !== 'starts-with') ||
        typeof a !== 'string' ||
        !a.startsWith('$') ||
        typeof b !== 'string'
      )
        throw new S3Error(
          'InvalidPolicyDocument',
          `Invalid Policy: Invalid condition ${JSON.stringify(c)}.`,
        );
      const name = a.slice(1).toLowerCase();
      const value = values.get(name) ?? '';
      if (kind === 'eq' ? value !== b : !value.startsWith(b)) throw failed(c);
      covered.add(name);
      continue;
    }
    if (c && typeof c === 'object') {
      const entries = Object.entries(c as Record<string, unknown>);
      if (entries.length !== 1 || typeof entries[0]![1] !== 'string')
        throw new S3Error(
          'InvalidPolicyDocument',
          `Invalid Policy: Invalid condition ${JSON.stringify(c)}.`,
        );
      const [k, v] = entries[0]! as [string, string];
      const name = k.toLowerCase();
      if ((values.get(name) ?? '') !== v) throw failed(c);
      covered.add(name);
      continue;
    }
    throw new S3Error(
      'InvalidPolicyDocument',
      `Invalid Policy: Invalid condition ${JSON.stringify(c)}.`,
    );
  }
  for (const name of fields.keys()) {
    if (name === 'x-amz-signature' || name === 'policy' || name.startsWith('x-ignore-')) continue;
    if (!covered.has(name))
      throw new S3Error('AccessDenied', `Invalid according to Policy: Extra input fields: ${name}`);
  }
}
