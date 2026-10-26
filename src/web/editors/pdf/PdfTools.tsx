// The PDF tools' Form and Tools tabs (ADR-052): filling in the form; a watermark and page numbers on
// every page (shown over the pages while editing); squeezing; pages as pictures; the text as .txt.
// Everything works on the PDF as it would be saved now, stamps included.
import { useState, type ReactNode } from 'react';
import { formatBytes } from '../../../shared/format';
import { Button } from '../../components/Button';
import { toast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { resultName } from '../files';
import { Busy, type Result } from '../ui';
import {
  PdfError,
  imagesToPdf,
  shrinkImages,
  type FormField,
  type NumberPos,
  type PageImage,
  type Recompress,
} from './ops';
import { openPdf, pageAsImage, pageAsJpeg, pageText } from './pdfjs';

export function failText(e: unknown): string {
  if (e instanceof PdfError && e.code === 'FONT') return t.editor.fontLatinOnly;
  return e instanceof PdfError && e.code === 'ENCRYPTED'
    ? t.editor.encryptedNoEdit
    : t.editor.cannotOpen;
}

export interface UiExtras {
  watermark: { on: boolean; text: string; opacity: number; size: number };
  numbers: { on: boolean; pos: NumberPos; format: 'n' | 'n/N' | 'page'; start: number };
}

export interface FormState {
  values: Record<string, string | boolean>;
  flatten: boolean;
}

/** The watermark and the page number over a page while editing, roughly as they will be written. */
export function ExtrasPreview({
  extras,
  index,
  total,
  size,
}: {
  extras: UiExtras;
  index: number;
  total: number;
  size: { w: number; h: number };
}) {
  const { w, h } = size;
  const short = Math.min(w, h);
  const wm = extras.watermark;
  const n = extras.numbers;
  const label =
    n.format === 'n'
      ? String(n.start + index)
      : n.format === 'n/N'
        ? `${n.start + index} / ${n.start + total - 1}`
        : t.editor.pageLabel(n.start + index, n.start + total - 1);
  const span = Math.hypot(w, h) * (wm.size / 100);
  return (
    <>
      {wm.on && wm.text.trim() && (
        <span
          className="pointer-events-none absolute top-1/2 left-1/2 font-bold whitespace-nowrap text-[#808080] select-none"
          style={{
            fontSize: Math.min(h * 0.3, span / Math.max(1, wm.text.trim().length * 0.62)),
            opacity: wm.opacity / 100,
            transform: `translate(-50%, -50%) rotate(${(-Math.atan2(h, w) * 180) / Math.PI}deg)`,
          }}
        >
          {wm.text.trim()}
        </span>
      )}
      {n.on && index >= 0 && (
        <span
          className="pointer-events-none absolute whitespace-nowrap text-[#333] select-none"
          style={{
            fontSize: short / 50,
            bottom: n.pos === 'top-right' ? undefined : short * 0.04,
            top: n.pos === 'top-right' ? short * 0.04 : undefined,
            ...(n.pos === 'bottom-center'
              ? { left: '50%', transform: 'translateX(-50%)' }
              : { right: short * 0.045 }),
          }}
        >
          {label}
        </span>
      )}
    </>
  );
}

const field = 'h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm';

export function FormTab({
  fields,
  form,
  onChange,
}: {
  fields: FormField[];
  form: FormState;
  onChange: (f: FormState) => void;
}) {
  const set = (name: string, v: string | boolean) =>
    onChange({ ...form, values: { ...form.values, [name]: v } });
  const groups = new Map<number | null, FormField[]>();
  for (const f of fields) groups.set(f.page, [...(groups.get(f.page) ?? []), f]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-subtle)] p-4">
      <div className="mx-auto max-w-md space-y-4">
        <p className="text-sm text-[var(--fg-muted)]">{t.editor.formIntro}</p>
        {[...groups].map(([page, list]) => (
          <section key={String(page)} className="z-card space-y-3 rounded-2xl p-4">
            <h2 className="text-sm font-semibold">
              {page === null ? t.editor.formOther : t.editor.formPage(page + 1)}
            </h2>
            {list.map((f) => {
              const v = form.values[f.name] ?? f.value;
              const id = `pdf-field-${f.name}`;
              if (f.kind === 'check')
                return (
                  <label key={f.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(v)}
                      onChange={(e) => set(f.name, e.target.checked)}
                    />
                    <span className="min-w-0 break-words">{f.name}</span>
                  </label>
                );
              return (
                <div key={f.name} className="space-y-1">
                  <label htmlFor={id} className="block text-xs break-words text-[var(--fg-muted)]">
                    {f.name}
                  </label>
                  {f.kind === 'text' ? (
                    f.multiline ? (
                      <textarea
                        id={id}
                        rows={3}
                        value={String(v)}
                        onChange={(e) => set(f.name, e.target.value)}
                        className={cn(field, 'h-auto py-2')}
                      />
                    ) : (
                      <input
                        id={id}
                        value={String(v)}
                        onChange={(e) => set(f.name, e.target.value)}
                        className={field}
                      />
                    )
                  ) : (
                    <select
                      id={id}
                      value={String(v)}
                      onChange={(e) => set(f.name, e.target.value)}
                      className={field}
                    >
                      <option value="">{t.editor.formChoose}</option>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.flatten}
            onChange={(e) => onChange({ ...form, flatten: e.target.checked })}
            className="mt-0.5"
          />
          {t.editor.formFlatten}
        </label>
      </div>
    </div>
  );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="z-card space-y-3 rounded-2xl p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {desc && <p className="text-xs text-[var(--fg-muted)]">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function Range({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-20 shrink-0 text-[var(--fg-muted)]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-brand-600"
      />
      <span className="w-8 text-right tabular-nums">{value}</span>
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      {t.editor.putOnPages}
    </label>
  );
}

const recompress: Recompress = async (jpeg, size) => {
  const max = 1600;
  if (Math.max(size.width, size.height) <= max && jpeg.length < 150_000) return null;
  const bmp = await createImageBitmap(
    new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
  );
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.7));
  return b
    ? { bytes: new Uint8Array(await b.arrayBuffer()), width: c.width, height: c.height }
    : null;
};

export function ToolsTab({
  extras,
  onExtras,
  make,
  baseName,
  onResults,
}: {
  extras: UiExtras;
  onExtras: (e: UiExtras) => void;
  /** The PDF as it would be saved now. */
  make: () => Promise<Uint8Array | null>;
  baseName: string;
  /** `whole`: the result is the whole edited document (saving it leaves nothing unsaved). */
  onResults: (list: Result[], whole: boolean) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [mode, setMode] = useState<'balanced' | 'small'>('balanced');
  const [out, setOut] = useState<{ before: number; blob: Blob } | null>(null);
  const [pictures, setPictures] = useState<{ type: 'image/jpeg' | 'image/png'; dpi: 150 | 300 }>({
    type: 'image/jpeg',
    dpi: 150,
  });
  const wm = extras.watermark;
  const nums = extras.numbers;
  const setWm = (p: Partial<typeof wm>) => onExtras({ ...extras, watermark: { ...wm, ...p } });
  const setNums = (p: Partial<typeof nums>) => onExtras({ ...extras, numbers: { ...nums, ...p } });

  /** Runs `job` on the current PDF opened in pdf.js, with the progress cover. */
  async function withPdf(job: (pdf: Awaited<ReturnType<typeof openPdf>>) => Promise<void>) {
    setProgress(0);
    try {
      const src = await make();
      if (!src) return;
      const pdf = await openPdf(src);
      try {
        await job(pdf);
      } finally {
        void pdf.loadingTask.destroy();
      }
    } catch (e) {
      toast(failText(e), { tone: 'error' });
    } finally {
      setProgress(null);
    }
  }

  async function squeeze() {
    setOut(null);
    setProgress(0);
    try {
      const src = await make();
      if (!src) return;
      let bytes: Uint8Array;
      if (mode === 'balanced') {
        bytes = await shrinkImages(src, recompress, setProgress);
      } else {
        const pdf = await openPdf(src);
        try {
          const pages: PageImage[] = [];
          for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const jpg = await pageAsJpeg(page, page.rotate, 110, 0.6);
            pages.push({ ...jpg, kind: 'jpg' });
            setProgress(n / pdf.numPages);
          }
          bytes = await imagesToPdf(pages);
        } finally {
          void pdf.loadingTask.destroy();
        }
      }
      setOut({
        before: src.length,
        blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
      });
    } catch (e) {
      toast(failText(e), { tone: 'error' });
    } finally {
      setProgress(null);
    }
  }

  const toPictures = () =>
    withPdf(async (pdf) => {
      const list: Result[] = [];
      const ext = pictures.type === 'image/png' ? 'png' : 'jpg';
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const { blob } = await pageAsImage(page, page.rotate, pictures.dpi, pictures.type, 0.9);
        list.push({ blob, name: resultName(baseName, ext, t.editor.pageSuffix(n)) });
        setProgress(n / pdf.numPages);
      }
      onResults(list, false);
    });

  const toText = () =>
    withPdf(async (pdf) => {
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        pages.push(await pageText(await pdf.getPage(n)));
        setProgress(n / pdf.numPages);
      }
      if (!pages.some(Boolean)) return void toast(t.editor.noText, { tone: 'error' });
      const blob = new Blob([pages.join('\n\n')], { type: 'text/plain;charset=utf-8' });
      onResults([{ blob, name: resultName(baseName, 'txt', t.editor.textSuffix) }], false);
    });

  const option = (id: 'balanced' | 'small', title: string, body: string) => (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3',
        mode === id && 'border-brand-500 bg-[var(--accent-soft)]',
      )}
    >
      <input type="radio" checked={mode === id} onChange={() => setMode(id)} className="mt-0.5" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[var(--fg-muted)]">{body}</span>
      </span>
    </label>
  );
  const smaller = out && out.blob.size < out.before;
  const select = 'h-9 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 text-sm';
  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[var(--bg-subtle)] p-4">
      <div className="mx-auto max-w-md space-y-4">
        <Card title={t.editor.watermark} desc={t.editor.watermarkDesc}>
          <Toggle on={wm.on} onChange={(on) => setWm({ on })} />
          {wm.on && (
            <>
              <input
                value={wm.text}
                onChange={(e) => setWm({ text: e.target.value })}
                aria-label={t.editor.watermarkText}
                placeholder={t.editor.watermarkText}
                className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
              />
              <Range
                label={t.editor.opacity}
                min={5}
                max={80}
                value={wm.opacity}
                onChange={(opacity) => setWm({ opacity })}
              />
              <Range
                label={t.editor.markSize}
                min={20}
                max={100}
                value={wm.size}
                onChange={(size) => setWm({ size })}
              />
            </>
          )}
        </Card>

        <Card title={t.editor.pageNumbers} desc={t.editor.pageNumbersDesc}>
          <Toggle on={nums.on} onChange={(on) => setNums({ on })} />
          {nums.on && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <select
                value={nums.pos}
                onChange={(e) => setNums({ pos: e.target.value as NumberPos })}
                aria-label={t.editor.pageNumbers}
                className={select}
              >
                {(['bottom-center', 'bottom-right', 'top-right'] as const).map((p) => (
                  <option key={p} value={p}>
                    {t.editor.numberPos[p]}
                  </option>
                ))}
              </select>
              <select
                value={nums.format}
                onChange={(e) => setNums({ format: e.target.value as typeof nums.format })}
                aria-label={t.editor.numberFormat}
                className={select}
              >
                <option value="n">1</option>
                <option value="n/N">1 / 10</option>
                <option value="page">{t.editor.pageLabel(1, 10)}</option>
              </select>
              <label className="col-span-2 flex items-center gap-2">
                <span className="text-[var(--fg-muted)]">{t.editor.numberStart}</span>
                <input
                  type="number"
                  min={0}
                  value={nums.start}
                  onChange={(e) =>
                    setNums({ start: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                  }
                  className={cn(select, 'w-20 tabular-nums')}
                />
              </label>
            </div>
          )}
        </Card>

        <Card title={t.editor.compressTitle}>
          {option('balanced', t.editor.compressBalanced, t.editor.compressBalancedDesc)}
          {option('small', t.editor.compressSmall, t.editor.compressSmallDesc)}
          <Button onClick={() => void squeeze()} disabled={progress !== null} className="w-full">
            {t.editor.compressStart}
          </Button>
          {out && (
            <div className="space-y-3 text-sm">
              {smaller ? (
                <p>
                  {t.editor.compressResult(
                    formatBytes(out.before),
                    formatBytes(out.blob.size),
                    Math.round((1 - out.blob.size / out.before) * 100),
                  )}
                </p>
              ) : (
                <p>{t.editor.notSmaller}</p>
              )}
              {smaller && (
                <Button
                  className="w-full"
                  onClick={() =>
                    onResults(
                      [
                        {
                          blob: out.blob,
                          name: resultName(baseName, 'pdf', t.editor.compressedSuffix),
                        },
                      ],
                      true,
                    )
                  }
                >
                  {t.common.save}
                </Button>
              )}
            </div>
          )}
        </Card>

        <Card title={t.editor.toImages} desc={t.editor.toImagesDesc}>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={pictures.type}
              onChange={(e) =>
                setPictures({ ...pictures, type: e.target.value as typeof pictures.type })
              }
              aria-label={t.editor.format}
              className={select}
            >
              <option value="image/jpeg">JPG</option>
              <option value="image/png">PNG</option>
            </select>
            <select
              value={pictures.dpi}
              onChange={(e) =>
                setPictures({ ...pictures, dpi: Number(e.target.value) as 150 | 300 })
              }
              aria-label={t.editor.quality}
              className={select}
            >
              {([150, 300] as const).map((d) => (
                <option key={d} value={d}>
                  {t.editor.dpi[d]}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="secondary"
            onClick={() => void toPictures()}
            disabled={progress !== null}
            className="w-full"
          >
            {t.editor.makeImages}
          </Button>
        </Card>

        <Card title={t.editor.extractText} desc={t.editor.extractTextDesc}>
          <Button
            variant="secondary"
            onClick={() => void toText()}
            disabled={progress !== null}
            className="w-full"
          >
            {t.editor.extractText}
          </Button>
        </Card>
      </div>
      {progress !== null && (
        <Busy label={t.editor.progress(Math.round(progress * 100))} progress={progress} />
      )}
    </div>
  );
}
