// Photo editor (ADR-050): crop, turn, flip, light and colour, filters, size and format. Works on a
// smaller copy on screen and redraws the full photo only when saving.
import {
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Redo2,
  RotateCcw,
  RotateCw,
  Scaling,
  SlidersHorizontal,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { resultName, type EditRequest } from '../files';
import { Busy, EditorFrame, Failed, SaveDialog, ToolButton, useSources, type Result } from '../ui';
import { FILTERS, NO_ADJUST, type Adjust, type FilterId } from './adjust';
import {
  FULL,
  clampRect,
  dragCorner,
  fitRatio,
  flipRect,
  outputSize,
  turnOrientation,
  turnRect,
  turnedSize,
  type Corner,
  type Rect,
} from './geometry';
import {
  START,
  defaultType,
  drawPhoto,
  exportPhoto,
  extFor,
  scaled,
  type OutType,
  type PhotoState,
} from './render';

type Panel = 'crop' | 'adjust' | 'filter' | 'size';
const RATIOS: Array<{ id: string; value: number | 'original' | null }> = [
  { id: 'free', value: null },
  { id: 'original', value: 'original' },
  { id: '1:1', value: 1 },
  { id: '4:3', value: 4 / 3 },
  { id: '3:4', value: 3 / 4 },
  { id: '16:9', value: 16 / 9 },
  { id: '9:16', value: 9 / 16 },
];
const SCALES = [1, 0.75, 0.5, 0.25];
const PREVIEW_MAX = 1600;

/** Undo/redo over whole states (they are small). */
function useHistory(start: PhotoState) {
  const [h, setH] = useState({ list: [start], at: 0 });
  const state = h.list[h.at]!;
  const push = useCallback(
    (next: PhotoState) =>
      setH((x) => ({ list: [...x.list.slice(0, x.at + 1), next], at: x.at + 1 })),
    [],
  );
  /** Replaces the current state (while dragging a slider or the crop). */
  const replace = useCallback(
    (next: PhotoState) =>
      setH((x) => ({ list: x.list.map((s, i) => (i === x.at ? next : s)), at: x.at })),
    [],
  );
  return {
    state,
    push,
    replace,
    undo: () => setH((x) => ({ ...x, at: Math.max(0, x.at - 1) })),
    redo: () => setH((x) => ({ ...x, at: Math.min(x.list.length - 1, x.at + 1) })),
    at: h.at,
    canUndo: h.at > 0,
    canRedo: h.at < h.list.length - 1,
  };
}

export function PhotoEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'photo');
  const source = sources?.[0] ?? null;
  const [full, setFull] = useState<ImageBitmap | null>(null);
  const [small, setSmall] = useState<ImageBitmap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    (async () => {
      const bmp = await createImageBitmap(source.blob, { imageOrientation: 'from-image' });
      const preview = await scaled(bmp, PREVIEW_MAX);
      if (!alive) return;
      setFull(bmp);
      setSmall(preview);
    })().catch(() => {
      if (!alive) return;
      const heic = /hei[cf]$/i.test(source.name) || /hei[cf]/.test(source.blob.type);
      setLoadError(heic ? t.editor.heicUnsupported : t.editor.cannotOpen);
    });
    return () => {
      alive = false;
    };
  }, [source]);

  const title = source?.name ?? t.editor.photo;
  if (error || loadError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? loadError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!source || !full || !small)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Workspace source={source} full={full} small={small} onClose={onClose} />;
}

function Workspace({
  source,
  full,
  small,
  onClose,
}: {
  source: NonNullable<ReturnType<typeof useSources>['sources']>[number];
  full: ImageBitmap;
  small: ImageBitmap;
  onClose: () => void;
}) {
  const hist = useHistory(START);
  const st = hist.state;
  const [panel, setPanel] = useState<Panel>('crop');
  const [ratio, setRatio] = useState<string>('free');
  const [type, setType] = useState<OutType>(() => defaultType(source.blob.type, source.name));
  const [quality, setQuality] = useState(0.9);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const cropping = panel === 'crop';
  const turned = turnedSize(small.width, small.height, st.o.turn);
  const shown = cropping ? FULL : st.crop;
  const aspect = (turned.w * shown.w) / (turned.h * shown.h);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The biggest size with the picture's shape that fits the stage.
  const fit = useMemo(() => {
    if (!box.w || !box.h) return { w: 0, h: 0 };
    const w = Math.min(box.w, box.h * aspect);
    return { w, h: w / aspect };
  }, [box, aspect]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !fit.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(fit.w * dpr);
    const h = Math.round(fit.h * dpr);
    // Never more pixels than the copy has: drawing is per pixel.
    const s = Math.min(1, (turned.w * shown.w) / w);
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const id = requestAnimationFrame(() => drawPhoto(c, small, st, shown));
    return () => cancelAnimationFrame(id);
  }, [fit, small, st, shown, turned.w]);

  const update = (p: Partial<PhotoState>) => hist.push({ ...st, ...p });
  const turn = (dir: 1 | -1) =>
    update({ o: turnOrientation(st.o, dir), crop: turnRect(st.crop, dir) });
  const flip = (axis: 'h' | 'v') =>
    update({
      o: axis === 'h' ? { ...st.o, flipH: !st.o.flipH } : { ...st.o, flipV: !st.o.flipV },
      crop: flipRect(st.crop, axis),
    });
  const ratioValue = (id: string): number | null => {
    const r = RATIOS.find((x) => x.id === id)?.value ?? null;
    return r === 'original' ? turned.w / turned.h : r;
  };
  const chooseRatio = (id: string) => {
    setRatio(id);
    const r = ratioValue(id);
    if (r) update({ crop: fitRatio(FULL, r, turned.w, turned.h) });
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, dialog')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) hist.redo();
        else hist.undo();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [hist]);

  async function save() {
    setBusy(true);
    try {
      const blob = await exportPhoto(full, st, type, quality);
      const ext = extFor(blob.type);
      setResults([{ blob, name: resultName(source.name, ext, t.editor.editSuffix) }]);
    } catch {
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  const out = outputSize(full.width, full.height, st.o.turn, st.crop, st.scale);
  return (
    <EditorFrame
      title={source.name}
      onClose={onClose}
      dirty={hist.at !== savedAt}
      actions={
        <>
          <button
            type="button"
            onClick={hist.undo}
            disabled={!hist.canUndo}
            className="rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40"
            aria-label={t.editor.undo}
            title={t.editor.undo}
          >
            <Undo2 className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={hist.redo}
            disabled={!hist.canRedo}
            className="rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40"
            aria-label={t.editor.redo}
            title={t.editor.redo}
          >
            <Redo2 className="h-5 w-5" />
          </button>
          <Button onClick={() => void save()} disabled={busy} className="h-9 px-4">
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
            aria-label={source.name}
          />
          {cropping && fit.w > 0 && (
            <CropBox
              rect={st.crop}
              ratio={ratioValue(ratio)}
              pw={turned.w}
              ph={turned.h}
              onChange={(crop) => hist.replace({ ...st, crop })}
              onCommit={(crop) => hist.push({ ...st, crop })}
            />
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border)] bg-[var(--card)]">
        <div className="mx-auto max-w-2xl px-3 py-3">
          {panel === 'crop' && (
            <div className="space-y-3">
              <div className="flex gap-1 overflow-x-auto pb-1">
                {RATIOS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => chooseRatio(r.id)}
                    aria-pressed={ratio === r.id}
                    className={cn(
                      'shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-xs',
                      ratio === r.id &&
                        'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
                    )}
                  >
                    {r.id === 'free'
                      ? t.editor.ratioFree
                      : r.id === 'original'
                        ? t.editor.ratioOriginal
                        : r.id}
                  </button>
                ))}
              </div>
              <div className="flex justify-center gap-1">
                <ToolButton icon={RotateCcw} label={t.editor.rotateLeft} onClick={() => turn(-1)} />
                <ToolButton icon={RotateCw} label={t.editor.rotateRight} onClick={() => turn(1)} />
                <ToolButton
                  // Lucide draws the mirror line: a vertical line flips left-right.
                  icon={FlipVertical2}
                  label={t.editor.flipH}
                  onClick={() => flip('h')}
                />
                <ToolButton
                  icon={FlipHorizontal2}
                  label={t.editor.flipV}
                  onClick={() => flip('v')}
                />
              </div>
            </div>
          )}
          {panel === 'adjust' && (
            <Sliders
              value={st.adjust}
              onChange={(adjust) => hist.replace({ ...st, adjust })}
              onCommit={(adjust) => hist.push({ ...st, adjust })}
            />
          )}
          {panel === 'filter' && (
            <Filters
              img={small}
              st={st}
              value={st.filter}
              onChange={(filter) => update({ filter })}
            />
          )}
          {panel === 'size' && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 text-xs text-[var(--fg-muted)]">{t.editor.scale}</span>
                {SCALES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => update({ scale: s })}
                    aria-pressed={st.scale === s}
                    className={cn(
                      'rounded-full border border-[var(--border)] px-3 py-1 text-xs',
                      st.scale === s &&
                        'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
                    )}
                  >
                    {Math.round(s * 100)}%
                  </button>
                ))}
                <span className="text-xs text-[var(--fg-muted)]">
                  {t.editor.pixels(out.w, out.h)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="photo-format" className="w-20 text-xs text-[var(--fg-muted)]">
                  {t.editor.format}
                </label>
                <select
                  id="photo-format"
                  value={type}
                  onChange={(e) => setType(e.target.value as OutType)}
                  className="h-9 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2"
                >
                  <option value="image/jpeg">JPEG</option>
                  <option value="image/png">PNG</option>
                  <option value="image/webp">WebP</option>
                </select>
                {type !== 'image/png' && (
                  <label className="flex flex-1 items-center gap-2 text-xs text-[var(--fg-muted)]">
                    {t.editor.quality}
                    <input
                      type="range"
                      min={0.4}
                      max={1}
                      step={0.05}
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                      className="flex-1 accent-brand-600"
                    />
                    <span className="w-9 text-right tabular-nums">{Math.round(quality * 100)}</span>
                  </label>
                )}
              </div>
              <p className="text-xs text-[var(--fg-muted)]">{t.editor.exifNote}</p>
            </div>
          )}
        </div>
        <nav
          className="flex justify-center gap-1 border-t border-[var(--border)] px-2 py-1.5"
          aria-label={t.editor.photo}
        >
          <ToolButton
            icon={Crop}
            label={t.editor.crop}
            active={panel === 'crop'}
            onClick={() => setPanel('crop')}
          />
          <ToolButton
            icon={SlidersHorizontal}
            label={t.editor.adjust}
            active={panel === 'adjust'}
            onClick={() => setPanel('adjust')}
          />
          <ToolButton
            icon={Sparkles}
            label={t.editor.filters}
            active={panel === 'filter'}
            onClick={() => setPanel('filter')}
          />
          <ToolButton
            icon={Scaling}
            label={t.editor.resize}
            active={panel === 'size'}
            onClick={() => setPanel('size')}
          />
        </nav>
      </div>
      {busy && <Busy label={t.editor.working} />}
      <SaveDialog
        results={results}
        source={source}
        onClose={() => setResults(null)}
        onSaved={() => setSavedAt(hist.at)}
      />
    </EditorFrame>
  );
}

const SLIDERS: Array<keyof Adjust> = ['brightness', 'contrast', 'saturation', 'warmth'];

function Sliders({
  value,
  onChange,
  onCommit,
}: {
  value: Adjust;
  onChange: (a: Adjust) => void;
  onCommit: (a: Adjust) => void;
}) {
  const base = useRef(value);
  return (
    <div className="space-y-2">
      {SLIDERS.map((k) => (
        <label key={k} className="flex items-center gap-3 text-xs">
          <span className="w-24 shrink-0 text-[var(--fg-muted)]">{t.editor.adjustments[k]}</span>
          <input
            type="range"
            min={-100}
            max={100}
            value={value[k]}
            onPointerDown={() => (base.current = value)}
            onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })}
            onPointerUp={(e) => onCommit({ ...base.current, [k]: Number(e.currentTarget.value) })}
            onKeyUp={(e) => onCommit({ ...value, [k]: Number(e.currentTarget.value) })}
            onDoubleClick={() => onCommit({ ...value, [k]: 0 })}
            className="flex-1 accent-brand-600"
          />
          <span className="w-9 text-right tabular-nums">{value[k]}</span>
        </label>
      ))}
      <div className="text-right">
        <button
          type="button"
          className="text-xs text-[var(--accent)] hover:underline"
          onClick={() => onCommit(NO_ADJUST)}
        >
          {t.editor.reset}
        </button>
      </div>
    </div>
  );
}

function Filters({
  img,
  st,
  value,
  onChange,
}: {
  img: ImageBitmap;
  st: PhotoState;
  value: FilterId;
  onChange: (f: FilterId) => void;
}) {
  const [thumbs, setThumbs] = useState<Partial<Record<FilterId, string>>>({});
  const { o, crop } = st;
  useEffect(() => {
    let alive = true;
    (async () => {
      const tiny = await scaled(img, 160);
      const c = document.createElement('canvas');
      const tw = turnedSize(tiny.width, tiny.height, o.turn);
      const s = 72 / Math.max(tw.w * crop.w, tw.h * crop.h);
      c.width = Math.max(1, Math.round(tw.w * crop.w * s));
      c.height = Math.max(1, Math.round(tw.h * crop.h * s));
      const out: Partial<Record<FilterId, string>> = {};
      for (const f of Object.keys(FILTERS) as FilterId[]) {
        drawPhoto(c, tiny, { o, adjust: NO_ADJUST, filter: f }, crop);
        out[f] = c.toDataURL('image/jpeg', 0.8);
      }
      if (alive) setThumbs(out);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [img, o, crop]);
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {(Object.keys(FILTERS) as FilterId[]).map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          aria-pressed={value === f}
          className="flex shrink-0 flex-col items-center gap-1 text-[11px]"
        >
          <span
            className={cn(
              'flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-xl border-2 border-transparent bg-[var(--bg-subtle)]',
              value === f && 'border-brand-500',
            )}
          >
            {thumbs[f] && <img src={thumbs[f]} alt="" className="max-h-full max-w-full" />}
          </span>
          {t.editor.filterNames[f]}
        </button>
      ))}
    </div>
  );
}

/** The crop rectangle over the photo: drag inside to move it, drag a corner to resize it. */
function CropBox({
  rect,
  ratio,
  pw,
  ph,
  onChange,
  onCommit,
}: {
  rect: Rect;
  ratio: number | null;
  pw: number;
  ph: number;
  onChange: (r: Rect) => void;
  onCommit: (r: Rect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: 'move' | Corner;
    x: number;
    y: number;
    start: Rect;
    last: Rect;
  } | null>(null);

  function grab(e: PointerEvent, mode: 'move' | Corner) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: rect, last: rect };
  }
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const box = ref.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    const next =
      d.mode === 'move'
        ? clampRect({ ...d.start, x: d.start.x + dx, y: d.start.y + dy })
        : dragCorner(d.start, d.mode, dx, dy, ratio, pw, ph);
    d.last = next;
    onChange(next);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.last !== d.start) onCommit(d.last);
  };
  const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];
  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none overflow-hidden"
      onPointerMove={move}
      onPointerUp={up}
    >
      <div
        className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
        onPointerDown={(e) => grab(e, 'move')}
      >
        {/* Rule of thirds. */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="border border-white/25" />
          ))}
        </div>
        {corners.map((c) => (
          <span
            key={c}
            role="presentation"
            onPointerDown={(e) => grab(e, c)}
            className={cn(
              // Inside the corners: the stage clips anything outside the photo.
              'absolute h-6 w-6 touch-none rounded-full border-2 border-white bg-brand-600 shadow',
              c === 'nw' && 'top-0.5 left-0.5 cursor-nwse-resize',
              c === 'ne' && 'top-0.5 right-0.5 cursor-nesw-resize',
              c === 'sw' && 'bottom-0.5 left-0.5 cursor-nesw-resize',
              c === 'se' && 'right-0.5 bottom-0.5 cursor-nwse-resize',
            )}
          />
        ))}
      </div>
    </div>
  );
}
