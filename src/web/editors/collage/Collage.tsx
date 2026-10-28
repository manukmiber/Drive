// The collage (ADR-067): up to nine photos from Drive or this device in one picture. Tabs: Layout
// (boxes for that many photos, and the shape), Style (spacing, border, round corners, background),
// Text & stickers, and Photo (zoom, swap, replace or take out the chosen box's photo; drag in a
// box to move its photo). Saved as JPEG, PNG, WebP, AVIF or JPEG XL.
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Plus,
  Redo2,
  RefreshCw,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { formatBytes } from '../../../shared/format';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/ui/Dialog';
import { toast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import {
  IMAGE_LABEL,
  IMAGE_TYPES,
  decodeImage,
  encodeImage,
  extForType,
  lossless,
  type ImageType,
} from '../codecs/image';
import { Chips, Field, Slider, Swatches } from '../controls';
import { boxOf, framePlace } from '../decor/draw';
import { DecorLayer } from '../decor/DecorLayer';
import { DecorPanel, type NewItem } from '../decor/DecorPanel';
import { makeItem } from '../decor/items';
import {
  TooLargeError,
  fromFile,
  maxBytes,
  resultName,
  type EditRequest,
  type Source,
} from '../files';
import {
  Busy,
  EditorFrame,
  Failed,
  SaveDialog,
  ToolButton,
  errorMessage,
  useConfig,
  useSources,
  type Result,
} from '../ui';
import { FRAMED, MAX_PHOTOS, coverRect, layoutsFor, type Framing } from './layouts';
import {
  BACKGROUNDS,
  GRADIENTS,
  RATIOS,
  cellRects,
  drawCollage,
  type CollageState,
} from './render';

interface Photo {
  name: string;
  /** For saving: at most a size that suits how many photos share the picture. */
  full: ImageBitmap;
  /** For the screen. */
  small: ImageBitmap;
}

const PREVIEW_MAX = 1200;
/** Long side kept per photo: fewer photos get more of the saved picture. */
const keepFor = (n: number) => (n <= 1 ? 4096 : n <= 2 ? 3000 : n <= 4 ? 2400 : 1800);

async function shrink(img: ImageBitmap, max: number): Promise<ImageBitmap> {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  if (s === 1) return img;
  return createImageBitmap(img, {
    resizeWidth: Math.max(1, Math.round(img.width * s)),
    resizeHeight: Math.max(1, Math.round(img.height * s)),
    resizeQuality: 'high',
  });
}

async function load(blob: Blob, name: string, count: number): Promise<Photo> {
  const bmp = await decodeImage(blob, name);
  const full = await shrink(bmp, keepFor(count));
  if (full !== bmp) bmp.close();
  return { name, full, small: await shrink(full, PREVIEW_MAX) };
}

let seq = 0;
const newId = () => `k${++seq}`;

export function Collage({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'collage');
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sources) return;
    let alive = true;
    const list = sources.slice(0, MAX_PHOTOS);
    Promise.all(list.map((s) => load(s.blob, s.name, list.length))).then(
      (p) => alive && setPhotos(p),
      () => alive && setLoadError(t.editor.cannotOpen),
    );
    return () => {
      alive = false;
    };
  }, [sources]);

  if (error || loadError)
    return (
      <EditorFrame title={t.collage.title} onClose={onClose}>
        <Failed message={(error ?? loadError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!photos || !sources)
    return (
      <EditorFrame title={t.collage.title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Workspace initial={photos} source={sources[0] ?? null} onClose={onClose} />;
}

/** Undo/redo; steps with the same key close together (a drag, a slider) become one. */
function useHistory<T>(start: T) {
  const [h, setH] = useState({ list: [start], at: 0, key: '', time: 0 });
  return {
    state: h.list[h.at]!,
    set: (next: T, key = '') =>
      setH((x) => {
        const now = Date.now();
        if (key && key === x.key && now - x.time < 1500)
          return { list: [...x.list.slice(0, x.at), next], at: x.at, key, time: now };
        return { list: [...x.list.slice(0, x.at + 1), next], at: x.at + 1, key, time: now };
      }),
    undo: () => setH((x) => ({ ...x, at: Math.max(0, x.at - 1), key: '' })),
    redo: () => setH((x) => ({ ...x, at: Math.min(x.list.length - 1, x.at + 1), key: '' })),
    at: h.at,
    canUndo: h.at > 0,
    canRedo: h.at < h.list.length - 1,
  };
}

const startState = (n: number): CollageState => ({
  layout: layoutsFor(n)[0]!.id,
  ratio: 1,
  spacing: 30,
  margin: 30,
  radius: 0,
  background: { colour: '#ffffff', gradient: null },
  order: Array.from({ length: n }, (_, i) => i),
  framing: {},
  decor: [],
});

type Tab = 'layout' | 'style' | 'decor' | 'photo';

function Workspace({
  initial,
  source,
  onClose,
}: {
  initial: Photo[];
  source: Source | null;
  onClose: () => void;
}) {
  const config = useConfig();
  const [photos, setPhotos] = useState(initial);
  const hist = useHistory(startState(initial.length));
  const st = hist.state;
  const [tab, setTab] = useState<Tab>('layout');
  const [cell, setCell] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: e!.contentRect.width, h: e!.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = useMemo(() => {
    if (!box.w || !box.h) return { w: 0, h: 0 };
    const w = Math.min(box.w, box.h * st.ratio);
    return { w, h: w / st.ratio };
  }, [box, st.ratio]);

  const small = useMemo(() => photos.map((p) => p.small), [photos]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !fit.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const id = requestAnimationFrame(() => {
      c.width = Math.round(fit.w * dpr);
      c.height = Math.round(fit.h * dpr);
      drawCollage(c, st, small);
    });
    return () => cancelAnimationFrame(id);
  }, [fit, st, small]);

  const set = (p: Partial<CollageState>, key = '') => hist.set({ ...st, ...p }, key);
  const rects = fit.w ? cellRects(st, fit.w, fit.h) : [];

  async function addFiles(list: FileList | null, into: number | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const room = MAX_PHOTOS - photos.length + (into == null ? 0 : 1);
    if (files.length > room) toast(t.collage.tooMany(MAX_PHOTOS), { tone: 'error' });
    setBusy(true);
    try {
      const max = maxBytes(config, 'collage');
      const count = Math.min(MAX_PHOTOS, photos.length + files.length);
      const made: Photo[] = [];
      for (const f of files.slice(0, Math.max(0, room))) {
        const s = fromFile(f, max);
        made.push(await load(s.blob, s.name, count));
      }
      if (!made.length) return;
      if (into != null) {
        // Replace the chosen box's photo; its framing starts again.
        const idx = st.order[into]!;
        setPhotos((p) => p.map((x, i) => (i === idx ? made[0]! : x)));
        const framing = { ...st.framing };
        delete framing[idx];
        set({ framing });
        return;
      }
      const next = [...photos, ...made];
      setPhotos(next);
      const n = next.length;
      set({
        layout: layoutsFor(n)[0]!.id,
        order: [...st.order, ...made.map((_, i) => photos.length + i)],
      });
    } catch (e) {
      toast(e instanceof TooLargeError ? t.editor.tooLarge(formatBytes(e.max)) : errorMessage(e), {
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  function removePhoto(at: number) {
    if (photos.length < 2) return;
    const idx = st.order[at]!;
    const next = photos.filter((_, i) => i !== idx);
    setPhotos(next);
    const framing: Record<number, Framing> = {};
    for (const [k, v] of Object.entries(st.framing)) {
      const i = Number(k);
      if (i !== idx) framing[i > idx ? i - 1 : i] = v;
    }
    set({
      layout: layoutsFor(next.length)[0]!.id,
      order: st.order.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)),
      framing,
    });
    setCell(null);
  }

  const swap = (at: number, dir: -1 | 1) => {
    const j = at + dir;
    if (j < 0 || j >= st.order.length) return;
    const order = [...st.order];
    [order[at], order[j]] = [order[j]!, order[at]!];
    set({ order });
    setCell(j);
  };

  function addDecor(n: NewItem) {
    const id = newId();
    const item =
      n.kind === 'text'
        ? makeItem(id, 'text', { text: t.overlay.defaultText })
        : n.kind === 'sticker'
          ? makeItem(id, 'sticker', { emoji: n.emoji })
          : makeItem(id, 'shape', { shape: n.shape, aspect: n.aspect });
    set({ decor: [...st.decor, item] });
    setChosen(id);
  }

  async function render(longSide: number, type: ImageType, quality: number) {
    setExporting(false);
    setBusy(true);
    try {
      const w = st.ratio >= 1 ? longSide : Math.round(longSide * st.ratio);
      const h = st.ratio >= 1 ? Math.round(longSide / st.ratio) : longSide;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      drawCollage(
        c,
        st,
        photos.map((p) => p.full),
      );
      const blob = await encodeImage(c, type, { quality });
      c.width = c.height = 0;
      const ext = extForType(blob.type || type);
      setResults([
        {
          blob,
          name: source?.name
            ? resultName(source.name, ext, t.collage.suffix)
            : `${t.collage.untitled}.${ext}`,
        },
      ]);
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const chosenCell = cell != null && cell < st.order.length ? cell : null;
  const tabs: Tab[] = ['layout', 'style', 'decor', 'photo'];
  return (
    <EditorFrame
      title={t.collage.title}
      onClose={onClose}
      dirty={hist.at !== savedAt}
      actions={
        <>
          <IconBar
            icon={Undo2}
            label={t.editor.undo}
            onClick={hist.undo}
            disabled={!hist.canUndo}
          />
          <IconBar
            icon={Redo2}
            label={t.editor.redo}
            onClick={hist.redo}
            disabled={!hist.canRedo}
          />
          <Button onClick={() => setExporting(true)} className="ml-1 h-9 px-4" disabled={busy}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div
        ref={stage}
        className="relative m-3 flex min-h-0 flex-1 items-center justify-center sm:m-6"
      >
        <div className="relative" style={{ width: fit.w, height: fit.h }}>
          <canvas
            ref={canvas}
            className="block h-full w-full shadow-[var(--shadow-lg)]"
            aria-label={t.collage.title}
          />
          {tab === 'decor' ? (
            <DecorLayer
              boxes={st.decor.map((it) => ({
                ...boxOf(it, framePlace(fit.w, fit.h)),
                id: it.id,
                size: it.size,
                rotation: it.rotation,
              }))}
              chosen={chosen}
              onChoose={setChosen}
              onMove={(id, x, y) =>
                set(
                  {
                    decor: st.decor.map((it) =>
                      it.id === id
                        ? {
                            ...it,
                            x: Math.max(0, Math.min(1, x / fit.w)),
                            y: Math.max(0, Math.min(1, y / fit.h)),
                          }
                        : it,
                    ),
                  },
                  `move-${id}`,
                )
              }
              onTransform={(id, size, rotation) =>
                set(
                  { decor: st.decor.map((it) => (it.id === id ? { ...it, size, rotation } : it)) },
                  `turn-${id}`,
                )
              }
              onRemove={(id) => {
                set({ decor: st.decor.filter((it) => it.id !== id) });
                setChosen(null);
              }}
            />
          ) : (
            <CellsLayer
              rects={rects}
              chosen={chosenCell}
              onChoose={(i) => {
                setCell(i);
                if (i != null && tab !== 'photo') setTab('photo');
              }}
              onPan={(i, ddx, ddy) => {
                const idx = st.order[i]!;
                const img = photos[idx]!.small;
                const f = st.framing[idx] ?? FRAMED;
                const r = rects[i]!;
                const d = coverRect(img.width, img.height, r, f);
                const ox = d.w - r.w;
                const oy = d.h - r.h;
                set(
                  {
                    framing: {
                      ...st.framing,
                      [idx]: {
                        ...f,
                        dx: ox > 0.5 ? Math.max(-1, Math.min(1, f.dx + (2 * ddx) / ox)) : 0,
                        dy: oy > 0.5 ? Math.max(-1, Math.min(1, f.dy + (2 * ddy) / oy)) : 0,
                      },
                    },
                  },
                  `pan-${idx}`,
                );
              }}
              onZoom={(i, k) => {
                const idx = st.order[i]!;
                const f = st.framing[idx] ?? FRAMED;
                set(
                  {
                    framing: {
                      ...st.framing,
                      [idx]: { ...f, zoom: Math.max(1, Math.min(4, f.zoom * k)) },
                    },
                  },
                  `zoom-${idx}`,
                );
              }}
            />
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border)] bg-[var(--card)]">
        <div className="mx-auto max-h-[38vh] max-w-2xl overflow-y-auto px-3 py-3">
          {tab === 'layout' && (
            <div className="space-y-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {layoutsFor(photos.length).map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => set({ layout: l.id })}
                    aria-pressed={st.layout === l.id}
                    aria-label={`${t.collage.tabs.layout} ${l.id}`}
                    className={cn(
                      'shrink-0 rounded-xl border-2 border-transparent p-1',
                      st.layout === l.id && 'border-brand-500',
                    )}
                  >
                    <svg width={52} height={52} viewBox="0 0 52 52" aria-hidden>
                      {l.cells.map((c, i) => (
                        <rect
                          key={i}
                          x={2 + c.x * 48 + 1}
                          y={2 + c.y * 48 + 1}
                          width={Math.max(1, c.w * 48 - 2)}
                          height={Math.max(1, c.h * 48 - 2)}
                          rx={2}
                          className="fill-[var(--fg-muted)] opacity-60"
                        />
                      ))}
                    </svg>
                  </button>
                ))}
              </div>
              <Field label={t.collage.ratio}>
                <Chips
                  items={RATIOS.map(([id]) => [id, id] as const)}
                  value={RATIOS.find(([, v]) => Math.abs(v - st.ratio) < 1e-3)?.[0] ?? '1:1'}
                  onChange={(id) => set({ ratio: RATIOS.find(([k]) => k === id)![1] })}
                />
              </Field>
              <Button
                variant="secondary"
                className="w-full"
                disabled={photos.length >= MAX_PHOTOS}
                onClick={() => addInput.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
                {t.collage.addPhotos} · {t.collage.photos(photos.length)}
              </Button>
            </div>
          )}
          {tab === 'style' && (
            <div className="space-y-2">
              <Slider
                label={t.collage.spacing}
                min={0}
                zero={30}
                value={st.spacing}
                onChange={(spacing) => set({ spacing }, 'spacing')}
              />
              <Slider
                label={t.collage.margin}
                min={0}
                zero={30}
                value={st.margin}
                onChange={(margin) => set({ margin }, 'margin')}
              />
              <Slider
                label={t.collage.radius}
                min={0}
                zero={0}
                value={st.radius}
                onChange={(radius) => set({ radius }, 'radius')}
              />
              <Field label={t.collage.background}>
                <Swatches
                  value={st.background.gradient ? '' : st.background.colour}
                  colours={BACKGROUNDS}
                  onChange={(colour) => set({ background: { colour, gradient: null } })}
                />
              </Field>
              <Field label={t.collage.gradients}>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {GRADIENTS.map((g) => {
                    const on = st.background.gradient?.join() === g.join();
                    return (
                      <button
                        key={g.join()}
                        type="button"
                        onClick={() => set({ background: { colour: g[0], gradient: g } })}
                        aria-pressed={on}
                        aria-label={`${t.collage.gradients} ${g.join(' → ')}`}
                        className={cn(
                          'h-7 w-7 shrink-0 rounded-full border border-black/15',
                          on && 'ring-2 ring-brand-500 ring-offset-2 ring-offset-[var(--card)]',
                        )}
                        style={{ background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` }}
                      />
                    );
                  })}
                </div>
              </Field>
            </div>
          )}
          {tab === 'decor' && (
            <DecorPanel
              items={st.decor}
              chosen={chosen}
              onChange={(decor) => set({ decor }, 'decor')}
              onChoose={setChosen}
              onAdd={addDecor}
            />
          )}
          {tab === 'photo' &&
            (chosenCell == null ? (
              <p className="text-sm text-[var(--fg-muted)]">
                {t.collage.noPhoto} {t.collage.cellHint}
              </p>
            ) : (
              <div className="space-y-2">
                <Slider
                  label={t.collage.zoom}
                  min={100}
                  max={400}
                  zero={100}
                  unit="%"
                  value={Math.round((st.framing[st.order[chosenCell]!] ?? FRAMED).zoom * 100)}
                  onChange={(v) => {
                    const idx = st.order[chosenCell]!;
                    const f = st.framing[idx] ?? FRAMED;
                    set(
                      { framing: { ...st.framing, [idx]: { ...f, zoom: v / 100 } } },
                      `zoom-${idx}`,
                    );
                  }}
                />
                <div className="flex flex-wrap gap-1">
                  <ToolButton
                    icon={ArrowLeft}
                    label={t.collage.swapPrev}
                    disabled={chosenCell === 0}
                    onClick={() => swap(chosenCell, -1)}
                  />
                  <ToolButton
                    icon={ArrowRight}
                    label={t.collage.swapNext}
                    disabled={chosenCell >= st.order.length - 1}
                    onClick={() => swap(chosenCell, 1)}
                  />
                  <ToolButton
                    icon={RefreshCw}
                    label={t.collage.replace}
                    onClick={() => replaceInput.current?.click()}
                  />
                  <ToolButton
                    icon={Trash2}
                    label={t.collage.removePhoto}
                    disabled={photos.length < 2}
                    onClick={() => removePhoto(chosenCell)}
                  />
                  <ToolButton
                    icon={Plus}
                    label={t.collage.addPhotos}
                    disabled={photos.length >= MAX_PHOTOS}
                    onClick={() => addInput.current?.click()}
                  />
                </div>
                <p className="text-[11px] text-[var(--fg-muted)]">{t.collage.cellHint}</p>
              </div>
            ))}
        </div>
        <nav
          className="flex justify-center gap-1 border-t border-[var(--border)] text-sm sm:gap-4"
          aria-label={t.collage.title}
        >
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={cn(
                'border-t-2 px-3 py-2.5',
                tab === id
                  ? 'border-brand-600 font-semibold text-[var(--fg)]'
                  : 'border-transparent text-[var(--fg-muted)]',
              )}
            >
              {t.collage.tabs[id]}
            </button>
          ))}
        </nav>
      </div>

      <input
        ref={addInput}
        type="file"
        accept="image/*,.jxl"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(e.target.files, null);
          e.target.value = '';
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept="image/*,.jxl"
        hidden
        onChange={(e) => {
          void addFiles(e.target.files, chosenCell);
          e.target.value = '';
        }}
      />
      <ExportDialog
        open={exporting}
        onClose={() => setExporting(false)}
        onRun={(side, type, q) => void render(side, type, q)}
      />
      {busy && <Busy label={t.editor.working} />}
      <SaveDialog
        results={results}
        source={source}
        replaceable={false}
        onClose={() => setResults(null)}
        onSaved={() => setSavedAt(hist.at)}
      />
    </EditorFrame>
  );
}

function IconBar({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

/** The boxes over the collage: tap to choose one, drag to move its photo, scroll to zoom it. */
function CellsLayer({
  rects,
  chosen,
  onChoose,
  onPan,
  onZoom,
}: {
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  chosen: number | null;
  onChoose: (i: number | null) => void;
  onPan: (i: number, dx: number, dy: number) => void;
  onZoom: (i: number, k: number) => void;
}) {
  const drag = useRef<{ i: number; x: number; y: number } | null>(null);
  return (
    <div className="absolute inset-0 touch-none" onPointerDown={() => onChoose(null)}>
      {rects.map((r, i) => (
        <div
          key={i}
          role="button"
          tabIndex={0}
          aria-label={`${t.collage.tabs.photo} ${i + 1}`}
          aria-pressed={chosen === i}
          className={cn(
            'absolute cursor-move',
            chosen === i &&
              'outline-2 outline-white outline-dashed [box-shadow:0_0_0_3px_rgba(0,0,0,0.35)]',
          )}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
          onPointerDown={(e: PointerEvent) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { i, x: e.clientX, y: e.clientY };
            onChoose(i);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.i !== i) return;
            onPan(i, e.clientX - d.x, e.clientY - d.y);
            drag.current = { i, x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => onZoom(i, e.deltaY < 0 ? 1.08 : 1 / 1.08)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onChoose(i);
          }}
        />
      ))}
    </div>
  );
}

const SIDES = [1080, 2048, 3000, 4096];

function ExportDialog({
  open,
  onClose,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  onRun: (side: number, type: ImageType, quality: number) => void;
}) {
  const [side, setSide] = useState(2048);
  const [type, setType] = useState<ImageType>('image/jpeg');
  const [quality, setQuality] = useState(0.9);
  return (
    <Dialog
      open={open}
      title={t.editor.saveTitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => onRun(side, type, quality)}>{t.common.save}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t.collage.size}>
          <Chips
            items={SIDES.map((s) => [String(s), `${s}px`] as const)}
            value={String(side)}
            onChange={(s) => setSide(Number(s))}
          />
        </Field>
        <Field label={t.editor.format}>
          <Chips
            items={IMAGE_TYPES.map((x) => [x, IMAGE_LABEL[x]] as const)}
            value={type}
            onChange={setType}
          />
        </Field>
        {!lossless(type) && (
          <Slider
            label={t.editor.quality}
            min={40}
            max={100}
            zero={90}
            value={Math.round(quality * 100)}
            onChange={(q) => setQuality(q / 100)}
          />
        )}
      </div>
    </Dialog>
  );
}
