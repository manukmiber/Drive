// PDF tools (ADR-050): where stamps land, page order/rotation/joining, pictures as pages, and the
// balanced squeeze.
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildPdf,
  imagesToPdf,
  pageInfo,
  pageSizeFor,
  shrinkImages,
  stampPlacement,
  toPdfPoint,
  type Box,
  type PageRef,
  type Quarter,
} from '../../src/web/editors/pdf/ops';

const fixture = (p: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${p}`, import.meta.url)));
const Q: Quarter[] = [0, 90, 180, 270];
const crop = { x: 10, y: 20, width: 600, height: 800 };

/** PDF point → fractions of the page as shown (the inverse of toPdfPoint). */
function shown(X: number, Y: number, r: Quarter): [number, number] {
  const { x, y, width: W, height: H } = crop;
  if (r === 0) return [(X - x) / W, (y + H - Y) / H];
  if (r === 90) return [(Y - y) / H, (X - x) / W];
  if (r === 180) return [(x + W - X) / W, (Y - y) / H];
  return [(y + H - Y) / H, (x + W - X) / W];
}

async function makePdf(sizes: Array<[number, number]>, form = false): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => {
    const p = d.addPage([w, h]);
    p.drawText(`page ${i + 1}`, { x: 20, y: 20, size: 12, font });
  });
  if (form) d.getForm().createTextField('name').addToPage(d.getPage(0), { x: 50, y: 50 });
  d.setTitle('Surat');
  return d.save();
}

const ref = (src: number, index: number, rotate: Quarter = 0): PageRef => ({
  key: `${src}:${index}`,
  src,
  index,
  rotate,
});

describe('stamp placement', () => {
  it('maps the shown page corners onto the crop box for every rotation', () => {
    for (const r of Q) {
      for (const [u, v] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [0.25, 0.6],
      ] as const) {
        const [X, Y] = toPdfPoint(u, v, r, crop);
        const [u2, v2] = shown(X, Y, r);
        expect(u2).toBeCloseTo(u, 9);
        expect(v2).toBeCloseTo(v, 9);
      }
    }
  });

  it('puts every corner of the picture where the box shows it, turned or not', () => {
    const box: Box = { x: 0.2, y: 0.3, w: 0.25, h: 0.1 };
    // Box corners as shown, clockwise from bottom-left; a picture turned k quarters clockwise has
    // its corner i at box corner i + k.
    const boxCorners: Array<[number, number]> = [
      [box.x, box.y + box.h],
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
    ];
    for (const r of Q) {
      for (const rot of Q) {
        const p = stampPlacement(box, rot, r, crop);
        const t = (p.rotate * Math.PI) / 180;
        // Picture corners in its own space, clockwise from bottom-left.
        const own: Array<[number, number]> = [
          [0, 0],
          [0, p.height],
          [p.width, p.height],
          [p.width, 0],
        ];
        own.forEach(([px, py], i) => {
          const X = p.x + px * Math.cos(t) - py * Math.sin(t);
          const Y = p.y + px * Math.sin(t) + py * Math.cos(t);
          const [u, v] = shown(X, Y, r);
          const want = boxCorners[(i + rot / 90) % 4]!;
          expect(u).toBeCloseTo(want[0], 6);
          expect(v).toBeCloseTo(want[1], 6);
        });
      }
    }
  });
});

describe('building the PDF', () => {
  it('reorders, drops and turns pages into a new file with only what they use', async () => {
    const src = await makePdf([
      [100, 200],
      [300, 400],
      [500, 600],
    ]);
    const out = await buildPdf([src], [ref(0, 2), ref(0, 0, 90)]);
    const d = await PDFDocument.load(out);
    expect(d.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [500, 600],
      [100, 200],
    ]);
    expect(d.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90]);
    expect(d.getTitle()).toBe('Surat');
  });

  it('changes the file in place when the pages stay the same, keeping its form', async () => {
    const src = await makePdf(
      [
        [100, 200],
        [300, 400],
      ],
      true,
    );
    const png = fixture('image/red.png');
    const out = await buildPdf(
      [src],
      [ref(0, 0, 270), ref(0, 1)],
      new Map([['0:0', [{ png, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, rot: 0 }]]]),
    );
    const d = await PDFDocument.load(out);
    expect(
      d
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(['name']);
    expect(d.getPage(0).getRotation().angle).toBe(270);
    const xobjects = d.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    expect(xobjects?.toString()).toMatch(/Image/);
  });

  it('joins sources, the same page twice too', async () => {
    const a = await makePdf([[100, 100]]);
    const b = await makePdf([
      [200, 200],
      [300, 300],
    ]);
    const out = await buildPdf([a, b], [ref(1, 1), ref(0, 0), { ...ref(1, 1), key: 'again' }]);
    const info = await pageInfo(out);
    expect(info.count).toBe(3);
    const d = await PDFDocument.load(out);
    expect(d.getPages().map((p) => p.getWidth())).toEqual([300, 100, 300]);
  });

  it('says when a file is locked with a password', async () => {
    const plain = new TextDecoder('latin1').decode(
      await (await PDFDocument.load(await makePdf([[100, 100]]))).save({ useObjectStreams: false }),
    );
    const locked = plain
      .replace(
        '\nxref\n',
        '\n99 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>\nendobj\n\nxref\n',
      )
      .replace('trailer\n<<', 'trailer\n<<\n/Encrypt 99 0 R');
    expect(locked).not.toBe(plain);
    await expect(
      pageInfo(new Uint8Array([...locked].map((c) => c.charCodeAt(0)))),
    ).rejects.toMatchObject({
      code: 'ENCRYPTED',
    });
  });
});

describe('pictures and squeezing', () => {
  it('makes one page per picture, A4 long side', async () => {
    const size = pageSizeFor(320, 240);
    expect(size).toEqual({ width: 842, height: 632 });
    const out = await imagesToPdf([
      { bytes: fixture('image/photo.jpg'), kind: 'jpg', ...size },
      { bytes: fixture('image/red.png'), kind: 'png', ...pageSizeFor(40, 30) },
    ]);
    const d = await PDFDocument.load(out);
    expect(d.getPageCount()).toBe(2);
    expect(d.getPage(0).getWidth()).toBe(842);
  });

  it('re-encodes JPEG photos only when that makes them smaller', async () => {
    const photo = fixture('image/photo.jpg');
    const small = fixture('image/small.jpg');
    const d = await PDFDocument.create();
    const page = d.addPage([400, 300]);
    page.drawImage(await d.embedJpg(photo), { x: 0, y: 0, width: 400, height: 300 });
    page.drawImage(await d.embedPng(fixture('image/red.png')), {
      x: 0,
      y: 0,
      width: 40,
      height: 30,
    });
    const before = await d.save();

    const seen: Array<{ width: number; height: number }> = [];
    const out = await shrinkImages(before, async (jpeg, size) => {
      expect(jpeg.length).toBe(photo.length);
      seen.push(size);
      return { bytes: small, width: 80, height: 60 };
    });
    expect(seen).toEqual([{ width: 320, height: 240 }]);
    expect(out.length).toBeLessThan(before.length);
    const images = (await PDFDocument.load(out)).context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter(
        (o): o is PDFRawStream =>
          o instanceof PDFRawStream && String(o.dict.get(PDFName.of('Subtype'))) === '/Image',
      );
    const jpeg = images.find((o) => String(o.dict.get(PDFName.of('Filter'))) === '/DCTDecode')!;
    expect(String(jpeg.dict.get(PDFName.of('Width')))).toBe('80');
    expect(jpeg.contents.length).toBe(small.length);
    expect(images).toHaveLength(2); // the JPEG and the (untouched) PNG

    // Not smaller → the original stays.
    const same = await shrinkImages(before, async () => ({
      bytes: photo,
      width: 320,
      height: 240,
    }));
    const kept = (await PDFDocument.load(same)).context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .find(
        (o): o is PDFRawStream =>
          o instanceof PDFRawStream && String(o.dict.get(PDFName.of('Filter'))) === '/DCTDecode',
      )!;
    expect(kept.contents.length).toBe(photo.length);
  });
});

describe('marks, extras and forms (ADR-052)', () => {
  /** The text on each page with where it sits on the page as shown (fractions from top-left). */
  async function texts(bytes: Uint8Array) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    const out: Array<Array<{ str: string; u: number; v: number }>> = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      out.push(
        content.items.flatMap((it) => {
          if (!('str' in it) || !it.str.trim()) return [];
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          return [{ str: it.str, u: x / vp.width, v: y / vp.height }];
        }),
      );
    }
    await task.destroy();
    return out;
  }

  it('puts page numbers where they are asked for, on turned pages too', async () => {
    const src = await makePdf([
      [600, 800],
      [600, 800],
    ]);
    const out = await buildPdf([src], [ref(0, 0), ref(0, 1, 90)], new Map(), {
      numbers: { pos: 'bottom-center', label: (n, total) => `${n} / ${total}`, start: 1 },
    });
    const [p1, p2] = await texts(out);
    for (const [page, label] of [
      [p1!, '1 / 2'],
      [p2!, '2 / 2'],
    ] as const) {
      const n = page.find((t) => t.str === label)!;
      expect(n).toBeTruthy();
      expect(n.u).toBeGreaterThan(0.4);
      expect(n.u).toBeLessThan(0.5);
      expect(n.v).toBeGreaterThan(0.9);
    }
  });

  it('writes a watermark across every page, in its middle', async () => {
    const src = await makePdf([[600, 800]]);
    const out = await buildPdf([src], [ref(0, 0)], new Map(), {
      watermark: { text: 'RAHASIA', opacity: 0.3, size: 0.6, color: [0.5, 0.5, 0.5] },
    });
    const w = (await texts(out))[0]!.find((t) => t.str === 'RAHASIA')!;
    // The baseline starts below-left of the middle, going up to the right.
    expect(w.u).toBeGreaterThan(0.1);
    expect(w.u).toBeLessThan(0.5);
    expect(w.v).toBeGreaterThan(0.5);
  });

  it('maps highlights onto the page for every rotation', async () => {
    const { shadeRect } = await import('../../src/web/editors/pdf/ops');
    for (const r of Q) {
      const rect = shadeRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, r, crop);
      const [u0, v0] = shown(rect.x, rect.y, r);
      const [u1, v1] = shown(rect.x + rect.width, rect.y + rect.height, r);
      expect(Math.min(u0, u1)).toBeCloseTo(0.1);
      expect(Math.max(u0, u1)).toBeCloseTo(0.4);
      expect(Math.min(v0, v1)).toBeCloseTo(0.2);
      expect(Math.max(v0, v1)).toBeCloseTo(0.6);
    }
    const src = await makePdf([[600, 800]]);
    const shade = {
      kind: 'shade' as const,
      box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
      rot: 0 as Quarter,
      color: [1, 0.9, 0.2] as [number, number, number],
      opacity: 0.5,
      multiply: true,
    };
    const out = await buildPdf([src], [ref(0, 0)], new Map([['0:0', [shade]]]));
    const page = (await PDFDocument.load(out)).getPage(0);
    const gs = page.node.Resources()?.lookup(PDFName.of('ExtGState'));
    expect(String(gs)).toContain('/Multiply');
  });

  it('lists form fields and fills them, in place or flattened', async () => {
    const src = await makePdf([[600, 800]], true);
    const { formFields } = await import('../../src/web/editors/pdf/ops');
    expect(await formFields(src)).toEqual([
      { name: 'name', kind: 'text', value: '', options: [], multiline: false, page: 0 },
    ]);
    const filled = await buildPdf([src], [ref(0, 0)], new Map(), {
      form: { values: { name: 'Budi Santoso' }, flatten: false },
    });
    expect((await PDFDocument.load(filled)).getForm().getTextField('name').getText()).toBe(
      'Budi Santoso',
    );
    const flat = await buildPdf([src], [ref(0, 0)], new Map(), {
      form: { values: { name: 'Budi Santoso' }, flatten: true },
    });
    expect((await PDFDocument.load(flat)).getForm().getFields()).toHaveLength(0);
    expect((await texts(flat))[0]!.some((t) => t.str.includes('Budi Santoso'))).toBe(true);
  });

  it('says so when the form text needs letters the standard font lacks', async () => {
    const src = await makePdf([[600, 800]], true);
    await expect(
      buildPdf([src], [ref(0, 0)], new Map(), {
        form: { values: { name: '山田' }, flatten: false },
      }),
    ).rejects.toMatchObject({ code: 'FONT' });
    const { latinOnly } = await import('../../src/web/editors/pdf/ops');
    expect(latinOnly('Rp 10.000 – “lunas” café')).toBe(true);
    expect(latinOnly('山田')).toBe(false);
  });

  it('makes a blank A4 page', async () => {
    const { blankPdf } = await import('../../src/web/editors/pdf/ops');
    const d = await PDFDocument.load(await blankPdf());
    expect(d.getPageCount()).toBe(1);
    expect(d.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
  });
});
