// Reads the duration of an MP4/MOV/M4V from its `mvhd` box without decoding (SPEC §11: never send a
// clip longer than 60 s to Media Transformations). Looks at the head, then the tail (moov at end).

function findMvhd(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Scan for the 'mvhd' fourcc; boxes may straddle our window, so a linear search is simplest.
  for (let i = 4; i + 24 < buf.length; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) {
      const version = buf[i + 4];
      if (version === 1 && i + 36 <= buf.length) {
        const timescale = view.getUint32(i + 24);
        const duration = Number(view.getBigUint64(i + 28));
        return timescale ? duration / timescale : null;
      }
      if (version === 0) {
        const timescale = view.getUint32(i + 16);
        const duration = view.getUint32(i + 20);
        return timescale ? duration / timescale : null;
      }
    }
  }
  return null;
}

export async function mp4Duration(
  bucket: R2Bucket,
  key: string,
  size: number,
  window = 1 << 20,
): Promise<number | null> {
  const head = await bucket.get(key, { range: { offset: 0, length: Math.min(size, window) } });
  if (head && 'body' in head) {
    const d = findMvhd(new Uint8Array(await head.arrayBuffer()));
    if (d !== null) return d;
  }
  if (size <= window) return null;
  const tail = await bucket.get(key, { range: { offset: size - window, length: window } });
  if (tail && 'body' in tail) return findMvhd(new Uint8Array(await tail.arrayBuffer()));
  return null;
}

export { findMvhd };
