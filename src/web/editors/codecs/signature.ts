// JPEG XL's two signatures, a bare codestream or the box container (ADR-067). No DOM here.
const BOX = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

export function jxlSignature(head: Uint8Array): boolean {
  if (head[0] === 0xff && head[1] === 0x0a) return true;
  return head.length >= BOX.length && BOX.every((b, i) => head[i] === b);
}
