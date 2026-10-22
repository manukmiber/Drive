// Writes a known-length stream to R2. Up to SINGLE_PUT_MAX in one put; larger objects use multipart
// with uniform parts (R2 requires equal-sized parts except the last), read straight from the stream.
import { withKnownLength } from './zip';

const SINGLE_PUT_MAX = 4 * 1024 ** 3;
export const MULTIPART_PART_BYTES = 64 * 1024 ** 2;

/** Yields exactly `n` bytes from `reader`, keeping any overflow in `carry` for the next part. */
function take(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
  carry: { buf: Uint8Array | null },
): ReadableStream<Uint8Array> {
  let left = n;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left === 0) return controller.close();
      let chunk = carry.buf;
      carry.buf = null;
      if (!chunk) {
        const r = await reader.read();
        if (r.done) return controller.error(new Error('stream ended early'));
        chunk = r.value;
      }
      if (chunk.length > left) {
        carry.buf = chunk.subarray(left);
        chunk = chunk.subarray(0, left);
      }
      left -= chunk.length;
      controller.enqueue(chunk);
      if (left === 0) controller.close();
    },
  });
}

export async function putKnownLength(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  opts: R2PutOptions = {},
  partBytes = MULTIPART_PART_BYTES,
  singleMax = SINGLE_PUT_MAX,
): Promise<void> {
  if (size <= singleMax) {
    await bucket.put(key, withKnownLength(stream, size), opts);
    return;
  }
  const mpu = await bucket.createMultipartUpload(key, opts);
  const reader = stream.getReader();
  const carry: { buf: Uint8Array | null } = { buf: null };
  const parts: R2UploadedPart[] = [];
  try {
    for (let n = 1, done = 0; done < size; n++) {
      const len = Math.min(partBytes, size - done);
      parts.push(await mpu.uploadPart(n, withKnownLength(take(reader, len, carry), len)));
      done += len;
    }
    await mpu.complete(parts);
  } catch (e) {
    await mpu.abort().catch(() => undefined);
    throw e;
  } finally {
    reader.releaseLock();
  }
}
