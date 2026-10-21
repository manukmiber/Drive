// Incremental CRC-32 (IEEE 802.3), used by the scanner mock and ZIP writer.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export class Crc32 {
  private crc = 0xffffffff;
  update(chunk: Uint8Array): this {
    let c = this.crc;
    for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
    this.crc = c;
    return this;
  }
  digest(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

export function crc32(data: Uint8Array): number {
  return new Crc32().update(data).digest();
}
