// PDF changes for the PDF tools (ADR-050), with pdf-lib: page order, rotation, joining, stamps
// (signatures, text, dates), pictures as pages, and smaller JPEGs inside. No DOM here; anything
// that needs a canvas comes in as a function, so all of this is tested in Node.
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  degrees,
  type PDFDict,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';

export type Quarter = 0 | 90 | 180 | 270;

/** One page of the result: page `index` of source `src`, turned `rotate` more (clockwise). */
export interface PageRef {
  key: string;
  src: number;
  index: number;
  rotate: Quarter;
}

/** Fractions of the page as shown (rotation applied), from its top-left corner. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A picture put on a page as shown; `rot` turns the picture itself clockwise inside its box. */
export interface Stamp {
  png: Uint8Array;
  box: Box;
  rot: Quarter;
}

export type PdfErrorCode = 'ENCRYPTED' | 'UNREADABLE';

export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(code);
  }
}

export const quarter = (deg: number): Quarter =>
  ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Quarter;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    // pdf-lib's errors are ES5 classes, so `instanceof EncryptedPDFError` is always false.
    if (e instanceof Error && /encrypted/i.test(e.message)) throw new PdfError('ENCRYPTED');
    throw new PdfError('UNREADABLE');
  }
}

interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point on the page as shown (fractions from top-left) → PDF user space. */
export function toPdfPoint(u: number, v: number, rotation: Quarter, c: CropBox): [number, number] {
  const { x, y, width: W, height: H } = c;
  switch (rotation) {
    case 0:
      return [x + u * W, y + H - v * H];
    case 90:
      return [x + v * W, y + u * H];
    case 180:
      return [x + W - u * W, y + v * H];
    case 270:
      return [x + W - v * W, y + H - u * H];
  }
}

/** Where pdf-lib's drawImage puts a stamp so it shows in `box`, turned `rot`, on a page turned `rotation`. */
export function stampPlacement(box: Box, rot: Quarter, rotation: Quarter, c: CropBox) {
  const shownW = rotation % 180 ? c.height : c.width;
  const shownH = rotation % 180 ? c.width : c.height;
  const width = rot % 180 ? box.h * shownH : box.w * shownW;
  const height = rot % 180 ? box.w * shownW : box.h * shownH;
  // The picture's own bottom-left corner, after turning it, is at this corner of the box.
  const corner: Record<Quarter, [number, number]> = {
    0: [box.x, box.y + box.h],
    90: [box.x, box.y],
    180: [box.x + box.w, box.y],
    270: [box.x + box.w, box.y + box.h],
  };
  const [u, v] = corner[rot];
  const [px, py] = toPdfPoint(u, v, rotation, c);
  // pdf-lib turns counter-clockwise; the page's rotation turns it clockwise when shown.
  return { x: px, y: py, width, height, rotate: quarter(rotation - rot) };
}

function pageRotation(page: PDFPage): Quarter {
  return quarter(page.getRotation().angle);
}

async function drawStamps(
  doc: PDFDocument,
  page: PDFPage,
  stamps: Stamp[],
  cache: Map<Uint8Array, PDFImage>,
) {
  const rotation = pageRotation(page);
  const crop = page.getCropBox();
  for (const s of stamps) {
    let img = cache.get(s.png);
    if (!img) {
      img = await doc.embedPng(s.png);
      cache.set(s.png, img);
    }
    const p = stampPlacement(s.box, s.rot, rotation, crop);
    page.drawImage(img, {
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      rotate: degrees(p.rotate),
    });
  }
}

/**
 * Makes the PDF: `pages` in order, each turned and stamped. When the pages are exactly the first
 * source's, in its order, the file is changed in place, which keeps its form fields, bookmarks and
 * details; otherwise a new file gets copies of the pages (and only what they use).
 */
export async function buildPdf(
  sources: Uint8Array[],
  pages: PageRef[],
  stamps: Map<string, Stamp[]> = new Map(),
): Promise<Uint8Array> {
  if (!pages.length) throw new PdfError('UNREADABLE');
  const docs = new Map<number, PDFDocument>();
  const doc = async (src: number) => {
    let d = docs.get(src);
    if (!d) {
      d = await loadPdf(sources[src]!);
      docs.set(src, d);
    }
    return d;
  };
  const first = await doc(pages[0]!.src);
  const inPlace =
    pages.every((p, i) => p.src === pages[0]!.src && p.index === i) &&
    pages.length === first.getPageCount();
  const cache = new Map<Uint8Array, PDFImage>();

  let out: PDFDocument;
  let outPages: PDFPage[];
  if (inPlace) {
    out = first;
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    for (const [key, value] of [
      ['Title', first.getTitle()],
      ['Author', first.getAuthor()],
      ['Subject', first.getSubject()],
    ] as const) {
      if (!value) continue;
      if (key === 'Title') out.setTitle(value);
      else if (key === 'Author') out.setAuthor(value);
      else out.setSubject(value);
    }
    // One copy per source, so fonts and images its pages share are copied once.
    const wanted = new Map<number, number[]>();
    for (const p of pages) wanted.set(p.src, [...(wanted.get(p.src) ?? []), p.index]);
    const copied = new Map<number, PDFPage[]>();
    for (const [src, indices] of wanted)
      copied.set(src, await out.copyPages(await doc(src), indices));
    outPages = pages.map((p) => {
      const page = copied.get(p.src)!.shift()!;
      out.addPage(page);
      return page;
    });
  }
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    const page = outPages[i]!;
    if (p.rotate) page.setRotation(degrees(quarter(pageRotation(page) + p.rotate)));
    const s = stamps.get(p.key);
    if (s?.length) await drawStamps(out, page, s, cache);
  }
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}

/** How many pages, and how each is turned already. */
export async function pageInfo(
  bytes: Uint8Array,
): Promise<{ count: number; rotations: Quarter[] }> {
  const d = await loadPdf(bytes);
  return { count: d.getPageCount(), rotations: d.getPages().map(pageRotation) };
}

export interface PageImage {
  bytes: Uint8Array;
  kind: 'jpg' | 'png';
  /** Page size in points. */
  width: number;
  height: number;
}

/** One page per picture, each the picture's size (pictures, or pages turned into pictures). */
export async function imagesToPdf(images: PageImage[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const im of images) {
    const img = im.kind === 'jpg' ? await out.embedJpg(im.bytes) : await out.embedPng(im.bytes);
    const page = out.addPage([im.width, im.height]);
    page.drawImage(img, { x: 0, y: 0, width: im.width, height: im.height });
  }
  return out.save({ useObjectStreams: true });
}

/** Page size for a picture: A4's long side (842 pt), the picture's shape. */
export function pageSizeFor(widthPx: number, heightPx: number): { width: number; height: number } {
  const long = 842;
  const s = long / Math.max(widthPx, heightPx);
  return { width: Math.round(widthPx * s), height: Math.round(heightPx * s) };
}

export type Recompress = (
  jpeg: Uint8Array,
  size: { width: number; height: number },
) => Promise<{ bytes: Uint8Array; width: number; height: number } | null>;

const name = (d: PDFDict, key: string) => d.get(PDFName.of(key))?.toString();

/** A JPEG we can re-encode as RGB without changing how it looks: 8-bit gray/RGB, no masks by colour. */
function plainJpeg(d: PDFDict, lookup: (o: unknown) => unknown): boolean {
  if (name(d, 'Subtype') !== '/Image') return false;
  const filter = d.get(PDFName.of('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray().map(String) : [String(filter)];
  if (filters.length !== 1 || filters[0] !== '/DCTDecode') return false;
  if (d.get(PDFName.of('Decode')) || d.get(PDFName.of('ImageMask'))) return false;
  if (d.get(PDFName.of('Mask')) instanceof PDFArray) return false;
  const bpc = d.get(PDFName.of('BitsPerComponent'));
  if (bpc && bpc.toString() !== '8') return false;
  const cs = lookup(d.get(PDFName.of('ColorSpace')));
  const csName = cs instanceof PDFArray ? String(cs.get(0)) : String(cs);
  if (
    csName === '/DeviceRGB' ||
    csName === '/DeviceGray' ||
    csName === '/CalRGB' ||
    csName === '/CalGray'
  )
    return true;
  if (csName === '/ICCBased' && cs instanceof PDFArray) {
    const icc = lookup(cs.get(1));
    const n = icc instanceof PDFRawStream ? icc.dict.get(PDFName.of('N'))?.toString() : undefined;
    return n === '1' || n === '3';
  }
  return false;
}

/**
 * Re-encodes the JPEG photos inside (the "balanced" squeeze): text, drawings and everything else
 * stay as they are. A photo is replaced only when the new one is clearly smaller.
 */
export async function shrinkImages(
  bytes: Uint8Array,
  recompress: Recompress,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const ctx = doc.context;
  const lookup = (o: unknown) => (o ? ctx.lookup(o as Parameters<typeof ctx.lookup>[0]) : o);
  const jpegs = ctx
    .enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFRawStream && plainJpeg(o.dict, lookup)) as Array<
    [Parameters<typeof ctx.assign>[0], PDFRawStream]
  >;
  for (let i = 0; i < jpegs.length; i++) {
    const [ref, stream] = jpegs[i]!;
    const width = Number(stream.dict.get(PDFName.of('Width'))?.toString() ?? 0);
    const height = Number(stream.dict.get(PDFName.of('Height'))?.toString() ?? 0);
    const r = await recompress(stream.contents, { width, height }).catch(() => null);
    if (r && r.bytes.length < stream.contents.length * 0.9) {
      const dict = stream.dict.clone(ctx);
      dict.set(PDFName.of('Width'), PDFNumber.of(r.width));
      dict.set(PDFName.of('Height'), PDFNumber.of(r.height));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));
      dict.set(PDFName.of('Length'), PDFNumber.of(r.bytes.length));
      ctx.assign(ref, PDFRawStream.of(dict, r.bytes));
    }
    onProgress?.((i + 1) / jpegs.length);
  }
  doc.setModificationDate(new Date());
  return doc.save({ useObjectStreams: true });
}
