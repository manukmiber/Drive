// PDF tools (ADR-050, ADR-052): view; arrange pages (turn, delete, reorder, duplicate, blank pages,
// take some out, split, add PDFs or pictures); fill & sign (signature, text, date, ticks, crosses,
// highlights, white-outs, pictures); fill in the form; tools (squeeze, watermark, page numbers,
// pictures, text). Pages and stamps are only a list until saving, when pdf-lib makes the file once.
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Copy,
  Eraser,
  File as FileBlank,
  FileOutput,
  FilePlus2,
  Highlighter,
  Image as ImageIcon,
  ImagePlus,
  PenLine,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { formatBytes, formatDate } from '../../../shared/format';
import { Button } from '../../components/Button';
import { PromptDialog } from '../../components/ui/Dialog';
import { toast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import {
  TooLargeError,
  fromFile,
  maxBytes,
  resultName,
  type EditRequest,
  type Source,
} from '../files';
import { turnRect } from '../photo/geometry';
import {
  Busy,
  EditorFrame,
  Failed,
  SaveDialog,
  ToolButton,
  useConfig,
  useSources,
  type Result,
} from '../ui';
import {
  PdfError,
  blankPdf,
  buildPdf,
  formFields,
  imagesToPdf,
  latinOnly,
  pageSizeFor,
  quarter,
  type Box,
  type Extras,
  type FormField,
  type PageImage,
  type PageRef,
  type Quarter,
  type Stamp,
} from './ops';
import {
  ExtrasPreview,
  FormTab,
  ToolsTab,
  failText,
  type FormState,
  type UiExtras,
} from './PdfTools';
import { PageCanvas, PageList, usePasswordPrompt, type ViewPage } from './PdfView';
import { openPdf, pageSize, type PDFDocumentProxy } from './pdfjs';
import { SignaturePad } from './SignaturePad';
import {
  MARK_INK,
  forgetSignature,
  markStamp,
  pictureStamp,
  savedSignatures,
  textStamp,
  wordsPicture,
  type MarkInk,
  type StampImage,
} from './stamps';

type Tab = 'view' | 'pages' | 'sign' | 'form' | 'more';

/** A stamp as placed: its picture to show (none for highlights and white-outs). */
type Placed = Stamp & {
  id: string;
  url: string;
  /** Height ÷ width of the picture, in pixels (0 for a shade). */
  ratio: number;
};

const SHADES = {
  highlight: { color: [1, 0.92, 0.23] as [number, number, number], opacity: 0.45, multiply: true },
  whiteout: { color: [1, 1, 1] as [number, number, number], opacity: 1, multiply: false },
};
type Shade = keyof typeof SHADES;

interface Work {
  pages: PageRef[];
  stamps: Record<string, Placed[]>;
}

interface Loaded {
  bytes: Uint8Array[];
  pdfs: PDFDocumentProxy[];
  names: string[];
  /** Blank pages added here: their documents don't make the result a merge. */
  blank: boolean[];
  /** Locked with a password: pdf-lib can't change it, only view. */
  readOnly: boolean;
}

let seq = 0;
const newId = () => `s${++seq}`;

/** A picture as a PDF page: turned upright, JPEG (PNG when it may be transparent). */
async function imagePage(blob: Blob): Promise<PageImage> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const png = blob.type === 'image/png';
  const out = await new Promise<Blob>((ok, fail) =>
    c.toBlob((b) => (b ? ok(b) : fail(new Error('encode'))), png ? 'image/png' : 'image/jpeg', 0.9),
  );
  return {
    bytes: new Uint8Array(await out.arrayBuffer()),
    kind: png ? 'png' : 'jpg',
    ...pageSizeFor(c.width, c.height),
  };
}

export function PdfEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, request.fromImages ? 'photo' : 'pdf');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const pw = usePasswordPrompt();
  const ask = pw.request;

  useEffect(() => {
    if (!sources) return;
    let alive = true;
    const pdfs: PDFDocumentProxy[] = [];
    (async () => {
      let files: Array<{ name: string; bytes: Uint8Array }>;
      if (request.fromImages) {
        const pages = [];
        for (const s of sources) pages.push(await imagePage(s.blob));
        files = [
          {
            name: resultName(sources[0]!.name, 'pdf', t.editor.fromImagesSuffix),
            bytes: await imagesToPdf(pages),
          },
        ];
      } else {
        files = await Promise.all(
          sources.map(async (s) => ({
            name: s.name,
            bytes: new Uint8Array(await s.blob.arrayBuffer()),
          })),
        );
      }
      let locked = false;
      for (const f of files) {
        const d = await openPdf(f.bytes, (wrong) => {
          locked = true;
          return ask(wrong);
        });
        if (!alive) return void d.loadingTask.destroy();
        pdfs.push(d);
        if ((await d.getPermissions()) !== null) locked = true;
      }
      if (alive)
        setLoaded({
          bytes: files.map((f) => f.bytes),
          pdfs,
          names: files.map((f) => f.name),
          blank: files.map(() => false),
          readOnly: locked,
        });
    })().catch(() => alive && setOpenError(t.editor.cannotOpen));
    return () => {
      alive = false;
      for (const d of pdfs) void d.loadingTask.destroy();
    };
  }, [sources, request.fromImages, ask]);

  const title = sources?.[0]?.name ?? t.editor.pdf;
  if (error || openError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? openError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!loaded || !sources)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
        {pw.ui}
      </EditorFrame>
    );
  return (
    <Workspace loaded={loaded} first={request.fromImages ? null : sources[0]!} onClose={onClose} />
  );
}

function Workspace({
  loaded,
  first,
  onClose,
}: {
  loaded: Loaded;
  first: Source | null;
  onClose: () => void;
}) {
  const config = useConfig();
  const [docs, setDocs] = useState(loaded);
  // Every pdf.js document has a worker. The first ones belong to PdfEditor, which frees them; the
  // ones added here are freed here when the editor closes.
  const added = useRef<PDFDocumentProxy[]>([]);
  useEffect(() => {
    const list = added.current;
    return () => list.splice(0).forEach((d) => void d.loadingTask.destroy());
  }, []);
  const [hist, setHist] = useState<{ list: Work[]; at: number }>(() => ({
    list: [
      {
        pages: loaded.pdfs.flatMap((pdf, src) =>
          Array.from({ length: pdf.numPages }, (_, index) => ({
            key: `${src}:${index}`,
            src,
            index,
            rotate: 0 as Quarter,
          })),
        ),
        stamps: {},
      },
    ],
    at: 0,
  }));
  const work = hist.list[hist.at]!;
  const commit = (next: Work) =>
    setHist((h) => ({ list: [...h.list.slice(0, h.at + 1), next], at: h.at + 1 }));
  /** Replaces the current step (dragging a stamp). */
  const replace = (next: Work) =>
    setHist((h) => ({ ...h, list: h.list.map((w, i) => (i === h.at ? next : w)) }));
  const [tab, setTab] = useState<Tab>('view');
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null);
  // `whole`: the result is the whole document as edited (saving it means nothing is left unsaved).
  const [results, setResults] = useState<{
    list: Result[];
    replaceable: boolean;
    whole: boolean;
  } | null>(null);

  const views: ViewPage[] = useMemo(
    () =>
      work.pages.map((p) => ({
        key: p.key,
        pdf: docs.pdfs[p.src]!,
        number: p.index + 1,
        extra: p.rotate,
      })),
    [work.pages, docs.pdfs],
  );
  const baseName = docs.names[0]!;
  const joined = docs.names.filter((_, i) => !docs.blank[i]).length;
  const merged = joined > 1;

  const stampMap = (w: Work) =>
    new Map(
      Object.entries(w.stamps).map(([k, list]) => [
        k,
        list.map(({ id: _id, url: _url, ratio: _ratio, ...stamp }): Stamp => stamp),
      ]),
    );

  // Watermark, page numbers and the form: not steps of the history, saved with the file.
  const [extras, setExtras] = useState<UiExtras>(() => ({
    watermark: { on: false, text: t.editor.watermarkDefault, opacity: 25, size: 70 },
    numbers: { on: false, pos: 'bottom-center', format: 'n', start: 1 },
  }));
  const [form, setForm] = useState<FormState>({ values: {}, flatten: false });
  const [fields, setFields] = useState<FormField[]>([]);
  useEffect(() => {
    if (docs.readOnly) return;
    let alive = true;
    formFields(loaded.bytes[0]!).then(
      (f) => alive && setFields(f),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [loaded.bytes, docs.readOnly]);

  function opsExtras(): Extras {
    const out: Extras = {};
    const w = extras.watermark;
    if (w.on && w.text.trim()) {
      const base = {
        opacity: w.opacity / 100,
        size: w.size / 100,
        color: [0.5, 0.5, 0.5] as [number, number, number],
      };
      if (latinOnly(w.text)) out.watermark = { ...base, text: w.text };
      else {
        const pic = wordsPicture(w.text.trim(), '#808080');
        if (pic) out.watermark = { ...base, png: pic.png, ratio: pic.ratio };
      }
    }
    const n = extras.numbers;
    if (n.on)
      out.numbers = {
        pos: n.pos,
        start: n.start,
        label: (i, total) =>
          n.format === 'n'
            ? String(i)
            : n.format === 'n/N'
              ? `${i} / ${total}`
              : t.editor.pageLabel(i, total),
      };
    if (fields.length && (Object.keys(form.values).length || form.flatten))
      out.form = { values: form.values, flatten: form.flatten };
    return out;
  }

  async function make(pages: PageRef[], w: Work = work): Promise<Uint8Array | null> {
    try {
      return await buildPdf(docs.bytes, pages, stampMap(w), opsExtras());
    } catch (e) {
      toast(failText(e), { tone: 'error' });
      return null;
    }
  }
  const asBlob = (b: Uint8Array) =>
    new Blob([b as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });

  async function save() {
    setBusy({ label: t.editor.working, progress: null });
    const b = await make(work.pages);
    setBusy(null);
    if (b)
      setResults({
        list: [
          {
            blob: asBlob(b),
            name: resultName(baseName, 'pdf', merged ? t.editor.mergedSuffix : t.editor.editSuffix),
          },
        ],
        replaceable: !merged,
        whole: true,
      });
  }

  const [savedAt, setSavedAt] = useState(0);
  const sideState = JSON.stringify({ extras, form });
  const [savedSide, setSavedSide] = useState(sideState);
  // Adding a PDF adds pages, so the history covers it.
  const dirty = hist.at !== savedAt || sideState !== savedSide;
  const tabs: Array<[Tab, string]> = docs.readOnly
    ? [['view', t.editor.view]]
    : [
        ['view', t.editor.view],
        ['pages', t.editor.pagesTab],
        ['sign', t.editor.fillSign],
        ...(fields.length ? [['form', t.editor.formTab] as [Tab, string]] : []),
        ['more', t.editor.moreTab],
      ];

  /** Adds documents' pages at `at` (the end by default). */
  async function addDocs(
    add: Array<{ name: string; bytes: Uint8Array }>,
    at = work.pages.length,
    blank = false,
  ) {
    const pdfs: PDFDocumentProxy[] = [];
    for (const a of add) {
      const d = await openPdf(a.bytes);
      if ((await d.getPermissions()) !== null) {
        void d.loadingTask.destroy();
        throw new PdfError('ENCRYPTED');
      }
      pdfs.push(d);
    }
    added.current.push(...pdfs);
    const start = docs.bytes.length;
    setDocs((d) => ({
      ...d,
      bytes: [...d.bytes, ...add.map((a) => a.bytes)],
      pdfs: [...d.pdfs, ...pdfs],
      names: [...d.names, ...add.map((a) => a.name)],
      blank: [...d.blank, ...add.map(() => blank)],
    }));
    const fresh = pdfs.flatMap((pdf, i) =>
      Array.from({ length: pdf.numPages }, (_, index) => ({
        key: `${start + i}:${index}`,
        src: start + i,
        index,
        rotate: 0 as Quarter,
      })),
    );
    commit({ ...work, pages: [...work.pages.slice(0, at), ...fresh, ...work.pages.slice(at)] });
    return fresh.length;
  }

  async function addSources(files: File[], images: boolean) {
    if (!files.length) return;
    try {
      const max = maxBytes(config, images ? 'photo' : 'pdf');
      const add: Array<{ name: string; bytes: Uint8Array }> = [];
      if (images) {
        const pages = [];
        for (const f of files) pages.push(await imagePage(fromFile(f, max).blob));
        add.push({ name: files[0]!.name, bytes: await imagesToPdf(pages) });
      } else {
        for (const f of files)
          add.push({
            name: f.name,
            bytes: new Uint8Array(await fromFile(f, max).blob.arrayBuffer()),
          });
      }
      toast(t.editor.added(await addDocs(add)));
    } catch (e) {
      toast(e instanceof TooLargeError ? t.editor.tooLarge(formatBytes(e.max)) : failText(e), {
        tone: 'error',
      });
    }
  }

  /** A blank page the size of the page at `like`, put after it. */
  async function addBlank(like: number) {
    try {
      const v = views[like]!;
      const page = await v.pdf.getPage(v.number);
      const size = pageSize(page, 1, (page.rotate + v.extra) % 360);
      await addDocs(
        [{ name: t.editor.blankPage, bytes: await blankPdf(size.width, size.height) }],
        like + 1,
        true,
      );
    } catch (e) {
      toast(failText(e), { tone: 'error' });
    }
  }

  const total = work.pages.length;
  const preview = (view: ViewPage, size: { w: number; h: number }) => (
    <ExtrasPreview
      extras={extras}
      index={work.pages.findIndex((p) => p.key === view.key)}
      total={total}
      size={size}
    />
  );

  return (
    <EditorFrame
      title={merged ? t.editor.mergePdfs(joined) : baseName}
      onClose={onClose}
      dirty={dirty}
      actions={
        !docs.readOnly && (
          <>
            <button
              type="button"
              onClick={() => setHist((h) => ({ ...h, at: Math.max(0, h.at - 1) }))}
              disabled={hist.at === 0}
              className="rounded-full px-3 py-2 text-sm hover:bg-[var(--bg-subtle)] disabled:opacity-40"
            >
              {t.editor.undo}
            </button>
            <Button onClick={() => void save()} className="h-9 px-4" disabled={Boolean(busy)}>
              {t.common.save}
            </Button>
          </>
        )
      }
    >
      <nav
        className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)] px-2"
        aria-label={t.editor.pdf}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={(e) => {
              setTab(id);
              e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
            aria-current={tab === id ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 px-2.5 py-2.5 text-sm sm:px-3',
              tab === id
                ? 'border-brand-600 font-semibold text-[var(--fg)]'
                : 'border-transparent text-[var(--fg-muted)]',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      {docs.readOnly && (
        <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
          {t.editor.encryptedNoEdit}
        </p>
      )}
      {tab === 'view' && (
        <PageList
          pages={views}
          overlay={(view, size) => (
            <>
              {preview(view, size)}
              {(work.stamps[view.key] ?? []).map((s) => (
                <StampPicture key={s.id} s={s} size={size} className="pointer-events-none" />
              ))}
            </>
          )}
        />
      )}
      {tab === 'pages' && (
        <PagesTab
          work={work}
          views={views}
          commit={commit}
          onResults={(list) => setResults({ list, replaceable: false, whole: false })}
          make={make}
          baseName={baseName}
          onAdd={(files, images) => void addSources(files, images)}
          onBlank={(like) => void addBlank(like)}
          setBusy={setBusy}
        />
      )}
      {tab === 'sign' && (
        <SignTab work={work} views={views} commit={commit} replace={replace} preview={preview} />
      )}
      {tab === 'form' && <FormTab fields={fields} form={form} onChange={setForm} />}
      {tab === 'more' && (
        <ToolsTab
          extras={extras}
          onExtras={setExtras}
          make={() => make(work.pages)}
          baseName={baseName}
          onResults={(list, whole) => setResults({ list, replaceable: whole && !merged, whole })}
        />
      )}
      {busy && <Busy label={busy.label} progress={busy.progress} />}
      <SaveDialog
        results={results?.list ?? null}
        source={first}
        replaceable={results?.replaceable ?? false}
        onClose={() => setResults(null)}
        onSaved={() => {
          if (!results?.whole) return;
          setSavedAt(hist.at);
          setSavedSide(sideState);
        }}
      />
    </EditorFrame>
  );
}

/** Turns the stamps of a page with it (they are kept as the page is shown). */
function turnStamps(list: Placed[] | undefined, dir: 1 | -1): Placed[] | undefined {
  return list?.map((s) => ({ ...s, box: turnRect(s.box, dir), rot: quarter(s.rot + dir * 90) }));
}

function PagesTab({
  work,
  views,
  commit,
  onResults,
  make,
  baseName,
  onAdd,
  onBlank,
  setBusy,
}: {
  work: Work;
  views: ViewPage[];
  commit: (w: Work) => void;
  onResults: (r: Result[]) => void;
  make: (pages: PageRef[]) => Promise<Uint8Array | null>;
  baseName: string;
  onAdd: (files: File[], images: boolean) => void;
  /** A blank page after page `like` (from 0), its size. */
  onBlank: (like: number) => void;
  setBusy: (b: { label: string; progress: number | null } | null) => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const pdfInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const picked = work.pages.filter((p) => sel.has(p.key));
  const toggle = (k: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const turn = (dir: 1 | -1) => {
    const stamps = { ...work.stamps };
    for (const p of picked) {
      const turned = turnStamps(stamps[p.key], dir);
      if (turned) stamps[p.key] = turned;
    }
    commit({
      pages: work.pages.map((p) =>
        sel.has(p.key) ? { ...p, rotate: quarter(p.rotate + dir * 90) } : p,
      ),
      stamps,
    });
  };
  const del = () => {
    const left = work.pages.filter((p) => !sel.has(p.key));
    if (!left.length) return toast(t.editor.keepOnePage, { tone: 'error' });
    commit({ ...work, pages: left });
    setSel(new Set());
  };
  /** Each chosen page twice, its stamps too. */
  const duplicate = () => {
    const pages: PageRef[] = [];
    const stamps = { ...work.stamps };
    for (const p of work.pages) {
      pages.push(p);
      if (!sel.has(p.key)) continue;
      const key = `${p.src}:${p.index}:${newId()}`;
      pages.push({ ...p, key });
      const list = stamps[p.key];
      if (list) stamps[key] = list.map((x) => ({ ...x, id: newId() }));
    }
    commit({ pages, stamps });
  };
  const lastChosen = work.pages.reduce((at, p, i) => (sel.has(p.key) ? i : at), -1);
  const shift = (dir: -1 | 1) => {
    const pages = [...work.pages];
    const order = dir === -1 ? pages.keys() : [...pages.keys()].reverse();
    for (const i of order) {
      const j = i + dir;
      if (!sel.has(pages[i]!.key) || j < 0 || j >= pages.length || sel.has(pages[j]!.key)) continue;
      [pages[i], pages[j]] = [pages[j]!, pages[i]!];
    }
    commit({ ...work, pages });
  };
  async function extract() {
    setBusy({ label: t.editor.working, progress: null });
    const b = await make(picked);
    setBusy(null);
    if (b)
      onResults([
        {
          blob: new Blob([b as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
          name: resultName(baseName, 'pdf', t.editor.extractSuffix(picked.length)),
        },
      ]);
  }
  async function splitAll() {
    const out: Result[] = [];
    for (let i = 0; i < work.pages.length; i++) {
      setBusy({
        label: t.editor.progress(Math.round((i / work.pages.length) * 100)),
        progress: i / work.pages.length,
      });
      const b = await make([work.pages[i]!]);
      if (!b) return setBusy(null);
      out.push({
        blob: new Blob([b as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
        name: resultName(baseName, 'pdf', t.editor.pageSuffix(i + 1)),
      });
    }
    setBusy(null);
    onResults(out);
  }

  const none = picked.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)] px-2 py-1">
        <button
          type="button"
          onClick={() => setSel(none ? new Set(work.pages.map((p) => p.key)) : new Set())}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs hover:bg-[var(--bg-subtle)]"
        >
          {none ? t.editor.selectAll : t.editor.selectedPages(picked.length)}
        </button>
        <ToolButton
          icon={RotateCcw}
          label={t.editor.rotateLeft}
          disabled={none}
          onClick={() => turn(-1)}
        />
        <ToolButton
          icon={RotateCw}
          label={t.editor.rotateRight}
          disabled={none}
          onClick={() => turn(1)}
        />
        <ToolButton
          icon={ArrowLeft}
          label={t.editor.moveEarlier}
          disabled={none}
          onClick={() => shift(-1)}
        />
        <ToolButton
          icon={ArrowRight}
          label={t.editor.moveLater}
          disabled={none}
          onClick={() => shift(1)}
        />
        <ToolButton icon={Copy} label={t.editor.duplicate} disabled={none} onClick={duplicate} />
        <ToolButton icon={Trash2} label={t.common.delete} disabled={none} onClick={del} />
        <ToolButton
          icon={FileOutput}
          label={t.editor.extract}
          disabled={none}
          onClick={() => void extract()}
        />
        <ToolButton
          icon={Scissors}
          label={t.editor.splitAll}
          disabled={work.pages.length < 2}
          onClick={() => void splitAll()}
        />
        <ToolButton
          icon={FileBlank}
          label={t.editor.blankPage}
          onClick={() => onBlank(lastChosen >= 0 ? lastChosen : work.pages.length - 1)}
        />
        <ToolButton
          icon={FilePlus2}
          label={t.editor.addPdf}
          onClick={() => pdfInput.current?.click()}
        />
        <ToolButton
          icon={ImagePlus}
          label={t.editor.addImages}
          onClick={() => imgInput.current?.click()}
        />
        <input
          ref={pdfInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []), false);
            e.target.value = '';
          }}
        />
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []), true);
            e.target.value = '';
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-subtle)] p-3">
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3"
          aria-label={t.editor.pagesTab}
        >
          {views.map((v, i) => {
            const on = sel.has(v.key);
            return (
              <li key={v.key}>
                <button
                  type="button"
                  onClick={() => toggle(v.key)}
                  aria-pressed={on}
                  aria-label={t.editor.pageOf(i + 1, views.length)}
                  className={cn(
                    'flex w-full flex-col items-center gap-1.5 rounded-xl p-2',
                    on ? 'bg-[var(--accent-soft)] ring-2 ring-brand-500' : 'hover:bg-[var(--bg)]',
                  )}
                >
                  <PageCanvas view={v} width={96}>
                    {() =>
                      on && (
                        <span className="absolute top-1 right-1 rounded-full bg-brand-600 p-0.5 text-white">
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      )
                    }
                  </PageCanvas>
                  <span className="text-xs tabular-nums">{i + 1}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function SignTab({
  work,
  views,
  commit,
  replace,
  preview,
}: {
  work: Work;
  views: ViewPage[];
  commit: (w: Work) => void;
  replace: (w: Work) => void;
  /** The watermark and page numbers, drawn under the stamps. */
  preview: (view: ViewPage, size: { w: number; h: number }) => ReactNode;
}) {
  const [pad, setPad] = useState(false);
  const [asking, setAsking] = useState(false);
  // What the next tap (a picture) or drag (a shade) puts on a page.
  const [armed, setArmed] = useState<StampImage | Shade | null>(null);
  const [ink, setInk] = useState<MarkInk>('black');
  const [chosen, setChosen] = useState<string | null>(null);
  const [saved, setSaved] = useState(savedSignatures);
  const picture = useRef<HTMLInputElement>(null);
  const shade = typeof armed === 'string' ? armed : null;

  const add = (key: string, s: Placed) => {
    commit({ ...work, stamps: { ...work.stamps, [key]: [...(work.stamps[key] ?? []), s] } });
    setChosen(s.id);
    setArmed(null);
  };

  async function place(view: ViewPage, u: number, v: number) {
    if (!armed || typeof armed === 'string') return setChosen(null);
    // The page's own shape (what is on screen may still be a placeholder), so the stamp keeps its own.
    const page = await view.pdf.getPage(view.number);
    const shown = pageSize(page, 1, (page.rotate + view.extra) % 360);
    const w = Math.min(0.9, armed.width ?? (armed.ratio > 0.5 ? 0.2 : 0.3));
    const h = Math.min(0.9, (w * shown.width * armed.ratio) / shown.height);
    const box: Box = {
      x: Math.max(0, Math.min(1 - w, u - w / 2)),
      y: Math.max(0, Math.min(1 - h, v - h / 2)),
      w,
      h,
    };
    add(view.key, { id: newId(), png: armed.png, url: armed.url, ratio: armed.ratio, box, rot: 0 });
  }
  const placeShade = (key: string, kind: Shade, box: Box) =>
    add(key, { id: newId(), kind: 'shade', ...SHADES[kind], box, rot: 0, url: '', ratio: 0 });
  const update = (key: string, id: string, box: Box, done: boolean) => {
    const next = {
      ...work,
      stamps: {
        ...work.stamps,
        [key]: (work.stamps[key] ?? []).map((s) => (s.id === id ? { ...s, box } : s)),
      },
    };
    if (done) commit(next);
    else replace(next);
  };
  const removeStamp = (key: string, id: string) =>
    commit({
      ...work,
      stamps: { ...work.stamps, [key]: (work.stamps[key] ?? []).filter((s) => s.id !== id) },
    });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)] px-2 py-1">
        <ToolButton icon={PenLine} label={t.editor.newSignature} onClick={() => setPad(true)} />
        <ToolButton icon={Type} label={t.editor.addText} onClick={() => setAsking(true)} />
        <ToolButton
          icon={CalendarDays}
          label={t.editor.addDate}
          onClick={() => setArmed(textStamp(formatDate(Date.now()), ink))}
        />
        <ToolButton
          icon={Check}
          label={t.editor.markCheck}
          onClick={() => setArmed(markStamp('check', ink))}
        />
        <ToolButton
          icon={X}
          label={t.editor.markCross}
          onClick={() => setArmed(markStamp('cross', ink))}
        />
        <ToolButton
          icon={Highlighter}
          label={t.editor.highlight}
          active={shade === 'highlight'}
          onClick={() => setArmed(shade === 'highlight' ? null : 'highlight')}
        />
        <ToolButton
          icon={Eraser}
          label={t.editor.whiteout}
          active={shade === 'whiteout'}
          onClick={() => setArmed(shade === 'whiteout' ? null : 'whiteout')}
        />
        <ToolButton
          icon={ImageIcon}
          label={t.editor.addPicture}
          onClick={() => picture.current?.click()}
        />
        <input
          ref={picture}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f)
              void pictureStamp(f).then(
                (p) => p && setArmed(p),
                () => toast(t.editor.cannotOpen, { tone: 'error' }),
              );
          }}
        />
        <span
          className="mx-1 flex shrink-0 items-center gap-1.5"
          role="radiogroup"
          aria-label={t.editor.ink}
        >
          {(Object.keys(MARK_INK) as MarkInk[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={ink === k}
              aria-label={t.editor.inks[k]}
              title={t.editor.inks[k]}
              onClick={() => setInk(k)}
              className={cn(
                'h-6 w-6 rounded-full border-2 border-white shadow',
                ink === k && 'ring-2 ring-brand-500',
              )}
              style={{ backgroundColor: MARK_INK[k] }}
            />
          ))}
        </span>
        {saved.map((s) => (
          <span key={s.url} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setArmed(s)}
              aria-label={t.editor.useSaved}
              className={cn(
                'flex h-12 w-24 items-center justify-center rounded-xl border border-[var(--border)] bg-white p-1',
                typeof armed !== 'string' && armed?.url === s.url && 'ring-2 ring-brand-500',
              )}
            >
              <img src={s.url} alt="" className="max-h-full max-w-full" />
            </button>
            <button
              type="button"
              onClick={() => {
                forgetSignature(s.url);
                setSaved(savedSignatures());
              }}
              aria-label={t.editor.forget}
              className="absolute -top-1 -right-1 rounded-full bg-[var(--card)] p-0.5 shadow"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {armed && (
        <p className="absolute inset-x-3 top-16 z-10 mx-auto max-w-md rounded-xl bg-brand-600 px-3 py-2 text-center text-xs text-white shadow-lg">
          {shade ? t.editor.shadeHint : t.editor.placeHint}
          {shade === 'whiteout' && (
            <span className="mt-1 block opacity-90">{t.editor.whiteoutNote}</span>
          )}
        </p>
      )}
      <PageList
        pages={views}
        onPageClick={(view, u, v) => void place(view, u, v)}
        overlay={(view, size) => (
          <>
            {preview(view, size)}
            <StampLayer
              stamps={work.stamps[view.key] ?? []}
              size={size}
              chosen={chosen}
              onChoose={setChosen}
              onMove={(id, box, done) => update(view.key, id, box, done)}
              onRemove={(id) => removeStamp(view.key, id)}
            />
            {shade && <ShadeDraw kind={shade} onDone={(box) => placeShade(view.key, shade, box)} />}
          </>
        )}
      />
      <SignaturePad
        open={pad}
        onClose={() => setPad(false)}
        onDone={(s) => {
          setPad(false);
          setArmed(s);
          setSaved(savedSignatures());
        }}
      />
      <PromptDialog
        open={asking}
        title={t.editor.addText}
        initial=""
        confirmLabel={t.editor.placeIt}
        onCancel={() => setAsking(false)}
        onSubmit={(text) => {
          setAsking(false);
          setArmed(textStamp(text, ink));
        }}
      />
    </div>
  );
}

/** Dragging out a highlight or a white-out on one page; a tap makes one of a line's size. */
function ShadeDraw({ kind, onDone }: { kind: Shade; onDone: (box: Box) => void }) {
  const [rect, setRect] = useState<Box | null>(null);
  const start = useRef<[number, number] | null>(null);
  const at = (e: PointerEvent<HTMLDivElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    ];
  };
  const box = (a: [number, number], b: [number, number]): Box => ({
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    w: Math.abs(b[0] - a[0]),
    h: Math.abs(b[1] - a[1]),
  });
  const { color, opacity, multiply } = SHADES[kind];
  return (
    <div
      className="absolute inset-0 z-10 cursor-crosshair touch-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = at(e);
        setRect(box(start.current, start.current));
      }}
      onPointerMove={(e) => start.current && setRect(box(start.current, at(e)))}
      onPointerUp={(e) => {
        const a = start.current;
        start.current = null;
        setRect(null);
        if (!a) return;
        let b = box(a, at(e));
        if (b.w < 0.02 && b.h < 0.01) {
          const w = 0.3;
          const h = 0.025;
          b = {
            x: Math.max(0, Math.min(1 - w, a[0] - w / 2)),
            y: Math.max(0, Math.min(1 - h, a[1] - h / 2)),
            w,
            h,
          };
        }
        onDone(b);
      }}
    >
      {rect && (
        <span
          className="pointer-events-none absolute outline-1 outline-brand-500 outline-dashed"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
            background: `rgb(${color.map((c) => c * 255).join(',')})`,
            opacity,
            mixBlendMode: multiply ? 'multiply' : undefined,
          }}
        />
      )}
    </div>
  );
}

/**
 * Stamps on one page: drag to move, drag the corner to resize (pictures keep their shape, shades
 * don't), × to remove.
 */
function StampLayer({
  stamps,
  size,
  chosen,
  onChoose,
  onMove,
  onRemove,
}: {
  stamps: Placed[];
  size: { w: number; h: number };
  chosen: string | null;
  onChoose: (id: string) => void;
  onMove: (id: string, box: Box, done: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const drag = useRef<{
    id: string;
    mode: 'move' | 'size';
    x: number;
    y: number;
    start: Box;
    last: Box;
  } | null>(null);
  function grab(e: PointerEvent, s: Placed, mode: 'move' | 'size') {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onChoose(s.id);
    drag.current = { id: s.id, mode, x: e.clientX, y: e.clientY, start: s.box, last: s.box };
  }
  const moveTo = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !size.w || !size.h) return;
    const dx = (e.clientX - d.x) / size.w;
    const dy = (e.clientY - d.y) / size.h;
    const b = d.start;
    let next: Box;
    if (d.mode === 'move') {
      next = {
        ...b,
        x: Math.max(0, Math.min(1 - b.w, b.x + dx)),
        y: Math.max(0, Math.min(1 - b.h, b.y + dy)),
      };
    } else if (stamps.find((s) => s.id === d.id)?.kind === 'shade') {
      next = {
        ...b,
        w: Math.max(0.01, Math.min(1 - b.x, b.w + dx)),
        h: Math.max(0.005, Math.min(1 - b.y, b.h + dy)),
      };
    } else {
      const k = b.h / b.w;
      const w = Math.max(0.03, Math.min(1 - b.x, b.w + dx, (1 - b.y) / k));
      next = { ...b, w, h: w * k };
    }
    d.last = next;
    onMove(d.id, next, false);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.last !== d.start) onMove(d.id, d.last, true);
  };
  const items: ReactNode[] = stamps.map((s) => {
    const bw = s.box.w * size.w;
    const bh = s.box.h * size.h;
    const on = chosen === s.id;
    return (
      <div
        key={s.id}
        className={cn(
          'absolute cursor-move touch-none',
          on && 'outline-2 outline-brand-500 outline-dashed',
        )}
        style={{ left: s.box.x * size.w, top: s.box.y * size.h, width: bw, height: bh }}
        onPointerDown={(e) => grab(e, s, 'move')}
        onPointerMove={moveTo}
        onPointerUp={up}
        onClick={(e) => e.stopPropagation()}
      >
        <StampPicture s={s} size={size} className="pointer-events-none" fill />
        {on && (
          <>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(s.id);
              }}
              aria-label={t.editor.removeStamp}
              className="absolute -top-3 -right-3 rounded-full bg-red-600 p-1 text-white shadow"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span
              role="presentation"
              onPointerDown={(e) => grab(e, s, 'size')}
              className="absolute -right-2 -bottom-2 h-5 w-5 cursor-nwse-resize touch-none rounded-full border-2 border-white bg-brand-600 shadow"
            />
          </>
        )}
      </div>
    );
  });
  return <>{items}</>;
}

/** One stamp as it will be written: a picture (turned with its page) or a shade. */
function StampPicture({
  s,
  size,
  className,
  fill = false,
}: {
  s: Placed;
  size: { w: number; h: number };
  className?: string;
  /** Fills its parent (which is the stamp's box) instead of placing itself on the page. */
  fill?: boolean;
}) {
  const bw = s.box.w * size.w;
  const bh = s.box.h * size.h;
  const at = fill ? { left: 0, top: 0 } : { left: s.box.x * size.w, top: s.box.y * size.h };
  if (s.kind === 'shade')
    return (
      <span
        className={cn('absolute', className)}
        style={{
          ...at,
          width: bw,
          height: bh,
          background: `rgb(${s.color.map((c) => c * 255).join(',')})`,
          opacity: s.opacity,
          mixBlendMode: s.multiply ? 'multiply' : undefined,
        }}
      />
    );
  const sideways = s.rot % 180 !== 0;
  const iw = sideways ? bh : bw;
  const ih = sideways ? bw : bh;
  return (
    <img
      src={s.url}
      alt=""
      draggable={false}
      className={cn('absolute max-w-none select-none', className)}
      style={{
        width: iw,
        height: ih,
        left: (fill ? 0 : s.box.x * size.w) + (bw - iw) / 2,
        top: (fill ? 0 : s.box.y * size.h) + (bh - ih) / 2,
        transform: s.rot ? `rotate(${s.rot}deg)` : undefined,
      }}
    />
  );
}
