// Showing PDF pages with pdf.js (ADR-050): pages draw only near the screen, zoom, page number. Used
// by the PDF tools and by the file preview (Chrome on Android can't show a PDF in an iframe).
import { Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../lib/i18n';
import { openPdf, pageSize, renderPage, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs';

/** One page of what is shown: page `number` (from 1) of `pdf`, turned `extra` more. */
export interface ViewPage {
  key: string;
  pdf: PDFDocumentProxy;
  number: number;
  extra: number;
}

export function usePage(pdf: PDFDocumentProxy, number: number, wanted: boolean) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  useEffect(() => {
    if (!wanted || page) return;
    let alive = true;
    // A document closed meanwhile rejects (or throws, when its worker is gone): show nothing.
    Promise.resolve()
      .then(() => pdf.getPage(number))
      .then(
        (p) => alive && setPage(p),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [pdf, number, wanted, page]);
  return page;
}

/** A page at `width` CSS pixels; `children` are drawn over it (stamps), sized like the page. */
export function PageCanvas({
  view,
  width,
  ratio = 1.414,
  children,
  onSize,
}: {
  view: ViewPage;
  width: number;
  /** Height ÷ width until the page is known. */
  ratio?: number;
  /** Drawn over the page, given its size in CSS pixels. */
  children?: (size: { w: number; h: number }) => ReactNode;
  onSize?: (w: number, h: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const page = usePage(view.pdf, view.number, near);
  const rotation = page ? (page.rotate + view.extra) % 360 : 0;
  const size = page ? pageSize(page, 1, rotation) : null;
  const h = width * (size ? size.height / size.width : ratio);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(Boolean(e?.isIntersecting)), {
      rootMargin: '800px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (size) onSize?.(size.width, size.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report once the page is known
  }, [page, rotation]);

  useEffect(() => {
    const c = canvas.current;
    if (!near || !page || !c || width < 1) return;
    let task: ReturnType<typeof renderPage>;
    try {
      task = renderPage(page, c, width, rotation);
    } catch {
      return; // the document was closed
    }
    task.promise.catch(() => undefined);
    return () => task.cancel();
  }, [near, page, width, rotation]);

  return (
    <div
      ref={box}
      className="relative shrink-0 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
      style={{ width, height: h }}
      data-page={view.key}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {children?.({ w: width, h })}
    </div>
  );
}

/** Pages one under another, fitting the width; zoom with the buttons. */
export function PageList({
  pages,
  overlay,
  onPageClick,
  zoomable = true,
}: {
  pages: ViewPage[];
  overlay?: (view: ViewPage, size: { w: number; h: number }) => ReactNode;
  onPageClick?: (view: ViewPage, u: number, v: number, size: { w: number; h: number }) => void;
  zoomable?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFit(Math.min(900, (e?.contentRect.width ?? 0) - 24)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const first = pages[0];
    if (!first) return;
    Promise.resolve()
      .then(() => first.pdf.getPage(first.number))
      .then(
        (p) => {
          const s = pageSize(p, 1, (p.rotate + first.extra) % 360);
          setRatio(s.height / s.width);
        },
        () => undefined,
      );
  }, [pages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const kids = el.querySelectorAll<HTMLElement>('[data-page]');
    let n = 1;
    kids.forEach((k, i) => {
      if (k.offsetTop <= mid) n = i + 1;
    });
    setCurrent(n);
  };

  const width = Math.max(120, fit * zoom);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-[var(--bg-subtle)] px-3 py-4"
      >
        <div className="mx-auto flex w-max min-w-full flex-col items-center gap-4">
          {fit > 0 &&
            pages.map((p) => (
              <PageCanvas key={p.key} view={p} width={width} ratio={ratio}>
                {(size) =>
                  (overlay || onPageClick) && (
                    <div
                      className="absolute inset-0"
                      onClick={(e) => {
                        if (!onPageClick || e.target !== e.currentTarget) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        onPageClick(
                          p,
                          (e.clientX - r.left) / r.width,
                          (e.clientY - r.top) / r.height,
                          size,
                        );
                      }}
                    >
                      {overlay?.(p, size)}
                    </div>
                  )
                }
              </PageCanvas>
            ))}
        </div>
      </div>
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex items-center justify-between">
        <span className="rounded-full bg-black/70 px-3 py-1 text-xs text-white tabular-nums">
          {t.editor.pageOf(Math.min(current, pages.length), pages.length)}
        </span>
        {zoomable && (
          <span className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/70 p-1 text-white">
            <button
              type="button"
              className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40"
              onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
              disabled={zoom <= 0.5}
              aria-label={t.editor.zoomOut}
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="min-w-12 rounded-full px-1 text-xs tabular-nums hover:bg-white/15"
              onClick={() => setZoom(1)}
              aria-label={t.editor.fitWidth}
              title={t.editor.fitWidth}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40"
              onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
              disabled={zoom >= 3}
              aria-label={t.editor.zoomIn}
            >
              <Plus className="h-4 w-4" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Pages of one PDF document. */
export const allPages = (pdf: PDFDocumentProxy, prefix = ''): ViewPage[] =>
  Array.from({ length: pdf.numPages }, (_, i) => ({
    key: `${prefix}${i}`,
    pdf,
    number: i + 1,
    extra: 0,
  }));

/** Asks for a PDF's password in the page itself. */
export function usePasswordPrompt() {
  const [ask, setAsk] = useState<{ wrong: boolean; answer: (p: string | null) => void } | null>(
    null,
  );
  const request = useCallback(
    (wrong: boolean) => new Promise<string | null>((answer) => setAsk({ wrong, answer })),
    [],
  );
  const ui = ask && (
    <form
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--bg)] p-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get('password');
        ask.answer(typeof v === 'string' ? v : '');
        setAsk(null);
      }}
    >
      <p className="text-sm font-medium">{t.editor.passwordTitle}</p>
      {ask.wrong && <p className="text-xs text-red-600">{t.editor.wrongPassword}</p>}
      <input
        name="password"
        type="password"
        autoFocus
        autoComplete="off"
        aria-label={t.editor.passwordTitle}
        className="h-10 w-64 max-w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 outline-none focus:border-brand-500"
      />
      <div className="flex gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            ask.answer(null);
            setAsk(null);
          }}
        >
          {t.common.cancel}
        </Button>
        <Button type="submit">{t.editor.open}</Button>
      </div>
    </form>
  );
  return { request, ui };
}

/** The file preview's PDF: fetched in ranges from the preview URL. `onFail` falls back to the browser's viewer. */
export function PdfPreview({ url, onFail }: { url: string; onFail: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const pw = usePasswordPrompt();
  const pages = useMemo(() => (pdf ? allPages(pdf) : null), [pdf]);
  const ask = pw.request;
  useEffect(() => {
    let alive = true;
    let doc: PDFDocumentProxy | null = null;
    openPdf(url, ask).then(
      (d) => {
        doc = d;
        if (alive) setPdf(d);
        else void d.loadingTask.destroy();
      },
      () => alive && onFail(),
    );
    return () => {
      alive = false;
      void doc?.loadingTask.destroy();
    };
  }, [url, onFail, ask]);
  return (
    <div className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg">
      {pages ? (
        <PageList pages={pages} />
      ) : (
        <p className="m-auto text-sm text-white/70">{t.common.loading}</p>
      )}
      {pw.ui}
    </div>
  );
}
