// pdf.js for showing PDFs (ADR-050). The legacy build: the normal one needs JavaScript features
// many phones don't have yet. Its fonts, character maps and decoders are static files under
// /pdfjs-<version>/ (copied by vite.config.ts), loaded only when a PDF needs them.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assets = `${import.meta.env.BASE_URL}pdfjs-${pdfjs.version}/`;

export type { PDFDocumentProxy, PDFPageProxy };

/**
 * Opens bytes (copied: pdf.js takes the buffer it is given) or a URL (fetched in ranges, so big
 * files show their first pages early). `askPassword` is called for locked files.
 */
export function openPdf(
  from: Uint8Array | string,
  askPassword?: (wrong: boolean) => Promise<string | null>,
): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    ...(typeof from === 'string' ? { url: from, disableAutoFetch: true } : { data: from.slice() }),
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    enableXfa: false,
  });
  task.onPassword = (answer: (p: string) => void, reason: number) => {
    if (!askPassword) return void task.destroy();
    void askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((p) =>
      p === null ? task.destroy() : answer(p),
    );
  };
  return task.promise;
}

/** Page size in CSS pixels at `scale`, turned `rotation` (absolute, like pdf.js). */
export function pageSize(page: PDFPageProxy, scale: number, rotation: number) {
  const vp = page.getViewport({ scale, rotation });
  return { width: vp.width, height: vp.height };
}

/** Draws the page into `canvas` at `cssWidth` (sharp on high-density screens). */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  rotation: number,
  maxPixels = 4_000_000,
): RenderTask {
  const base = page.getViewport({ scale: 1, rotation });
  let scale = (cssWidth / base.width) * Math.min(2, window.devicePixelRatio || 1);
  // Big zooms on phones: cap the canvas, it is blurrier but does not run out of memory.
  const area = base.width * base.height * scale * scale;
  if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
  const vp = page.getViewport({ scale, rotation });
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  return page.render({ canvas, viewport: vp });
}

/** The page as a JPEG at `dpi` (the "small" squeeze), with its size in points as shown. */
export async function pageAsJpeg(
  page: PDFPageProxy,
  rotation: number,
  dpi: number,
  quality: number,
) {
  const pts = page.getViewport({ scale: 1, rotation });
  const vp = page.getViewport({ scale: dpi / 72, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('encode'))), 'image/jpeg', quality),
  );
  canvas.width = canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: pts.width, height: pts.height };
}
