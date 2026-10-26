// Photo editor (ADR-050, ADR-052), laid out like Snapseed: Looks (ready-made styles with a strength)
// and Tools. A tool opens over the bottom of the screen and changes a draft; ✓ keeps it as one step
// (undo/redo go step by step), ✕ drops it. Works on a smaller copy on screen and draws the full
// photo only when saving.
import {
  Aperture,
  Bandage,
  Check,
  Crop,
  Eye,
  Focus,
  Frame,
  Redo2,
  RotateCw,
  Scaling,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Thermometer,
  Triangle,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { resultName, type EditRequest } from '../files';
import { Busy, EditorFrame, Failed, SaveDialog, ToolButton, useSources, type Result } from '../ui';
import { LOOKS, autoTune, autoWhiteBalance, type LookId } from './adjust';
import {
  FULL,
  apply,
  fitRatio,
  flipRect,
  invert,
  matScale,
  photoMatrix,
  turnOrientation,
  turnRect,
  turnedSize,
} from './geometry';
import {
  CropBox,
  HealLayer,
  LensGuide,
  StraightenGrid,
  TextLayer,
  VignetteGuide,
} from './overlays';
import {
  CropPanel,
  CurvesPanel,
  DetailPanel,
  EffectsPanel,
  FramePanel,
  HealPanel,
  LensPanel,
  RATIOS,
  RotatePanel,
  SizePanel,
  Slider,
  TextPanel,
  TunePanel,
  VignettePanel,
  WbPanel,
} from './panels';
import {
  defaultType,
  drawPhoto,
  exportPhoto,
  extFor,
  scaled,
  textLayout,
  type OutType,
} from './render';
import { START, type PhotoState } from './state';

type ToolId =
  | 'tune'
  | 'detail'
  | 'curves'
  | 'wb'
  | 'crop'
  | 'rotate'
  | 'heal'
  | 'lens'
  | 'vignette'
  | 'effects'
  | 'text'
  | 'frame'
  | 'size';

const TOOLS: Array<[ToolId, LucideIcon]> = [
  ['tune', SlidersHorizontal],
  ['detail', Triangle],
  ['curves', Spline],
  ['wb', Thermometer],
  ['crop', Crop],
  ['rotate', RotateCw],
  ['heal', Bandage],
  ['lens', Focus],
  ['vignette', Aperture],
  ['effects', Sparkles],
  ['text', Type],
  ['frame', Frame],
  ['size', Scaling],
];

const PREVIEW_MAX = 1600;

let seq = 0;
const newId = () => `t${++seq}`;

/** Undo/redo over whole states (they are small: pictures are never in them). */
function useHistory(start: PhotoState) {
  const [h, setH] = useState({ list: [start], at: 0 });
  const push = useCallback(
    (next: PhotoState) =>
      setH((x) => ({ list: [...x.list.slice(0, x.at + 1), next], at: x.at + 1 })),
    [],
  );
  return {
    state: h.list[h.at]!,
    push,
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

/** The photo with its turn and straightening only, small: what "auto" looks at. */
function plainPixels(img: ImageBitmap, st: PhotoState): Uint8ClampedArray {
  const c = document.createElement('canvas');
  const t0 = turnedSize(img.width, img.height, st.o.turn);
  const s = Math.min(1, 320 / Math.max(t0.w * st.crop.w, t0.h * st.crop.h));
  c.width = Math.max(1, Math.round(t0.w * st.crop.w * s));
  c.height = Math.max(1, Math.round(t0.h * st.crop.h * s));
  drawPhoto(c, img, { ...START, o: st.o, angle: st.angle }, st.crop);
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
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
  const [tool, setTool] = useState<ToolId | null>(null);
  // The open tool's changes (or a look's strength being dragged), not yet a step.
  const [draft, setDraft] = useState<PhotoState | null>(null);
  const [tab, setTab] = useState<'looks' | 'tools'>('tools');
  const [comparing, setComparing] = useState(false);
  const [ratio, setRatio] = useState('free');
  const [brush, setBrush] = useState(6);
  const [chosenText, setChosenText] = useState<string | null>(null);
  const [histogram, setHistogram] = useState<Uint32Array | null>(null);
  const [type, setType] = useState<OutType>(() => defaultType(source.blob.type, source.name));
  const [quality, setQuality] = useState(0.9);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const st = draft ?? hist.state;
  const cropping = tool === 'crop';
  const turned = turnedSize(small.width, small.height, st.o.turn);
  const shown = cropping ? FULL : st.crop;
  const aspect = (turned.w * shown.w) / (turned.h * shown.h);
  // Comparing shows the photo as it came, in the same frame.
  const drawn = useMemo(
    () => (comparing ? { ...START, o: st.o, angle: st.angle, crop: st.crop } : st),
    [comparing, st],
  );

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
    const id = requestAnimationFrame(() => {
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      drawPhoto(c, small, drawn, shown);
    });
    return () => cancelAnimationFrame(id);
  }, [fit, small, drawn, shown, turned.w]);

  // Photo (small copy) pixels → CSS pixels of the shown photo, and back.
  const m = useMemo(
    () => photoMatrix(small.width, small.height, st.o, st.angle, shown, fit.w || 1, fit.h || 1),
    [small, st.o, st.angle, shown, fit],
  );
  const toPhoto = (x: number, y: number) => {
    const [px, py] = apply(invert(m), x, y);
    return [px / small.width, py / small.height] as const;
  };

  const edit = (p: Partial<PhotoState>) => setDraft((d) => ({ ...(d ?? hist.state), ...p }));
  /** Keeps whatever is pending (a look's strength mid-drag included) as a step. */
  function settle(): PhotoState {
    if (draft && draft !== hist.state) hist.push(draft);
    return draft ?? hist.state;
  }
  function openTool(id: ToolId) {
    setDraft(settle());
    setTool(id);
    setChosenText(null);
    if (id === 'curves') {
      const c = canvas.current;
      const data = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (data) {
        const h = new Uint32Array(256);
        for (let i = 0; i < data.length; i += 8)
          h[Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!)]!++;
        setHistogram(h);
      }
    }
  }
  /** Keeps (✓) or drops (✕) what the tool changed. Returns what the photo is now. */
  function closeTool(keep: boolean): PhotoState {
    const next = keep ? settle() : hist.state;
    setDraft(null);
    setTool(null);
    setChosenText(null);
    return next;
  }

  const turn = (dir: 1 | -1) =>
    edit({ o: turnOrientation(st.o, dir), crop: turnRect(st.crop, dir) });
  // A mirror turns the straightening the other way, so it stays a mirror of what was there.
  const flip = (axis: 'h' | 'v') =>
    edit({
      o: axis === 'h' ? { ...st.o, flipH: !st.o.flipH } : { ...st.o, flipV: !st.o.flipV },
      crop: flipRect(st.crop, axis),
      angle: -st.angle,
    });
  const ratioValue = (id: string): number | null => {
    const r = RATIOS.find((x) => x.id === id)?.value ?? null;
    return r === 'original' ? turned.w / turned.h : r;
  };
  const chooseRatio = (id: string) => {
    setRatio(id);
    const r = ratioValue(id);
    if (r) edit({ crop: fitRatio(FULL, r, turned.w, turned.h) });
  };

  function addText() {
    const [x, y] = toPhoto(fit.w / 2, fit.h / 2);
    const mark = {
      id: newId(),
      text: t.editor.textDefault,
      x,
      y,
      // 8% of what is shown, in short sides of the photo.
      size: (0.08 * Math.min(fit.w, fit.h)) / (Math.min(small.width, small.height) * matScale(m)),
      color: '#ffffff',
      style: 'bold' as const,
    };
    edit({ texts: [...st.texts, mark] });
    setChosenText(mark.id);
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, dialog')) return;
      if (tool || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) hist.redo();
      else hist.undo();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [hist, tool]);

  async function save() {
    // Saving keeps what the open tool shows.
    const final = closeTool(true);
    setBusy(true);
    try {
      const blob = await exportPhoto(full, final, type, quality);
      const ext = extFor(blob.type);
      setResults([{ blob, name: resultName(source.name, ext, t.editor.editSuffix) }]);
    } catch {
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  const shortCss = Math.min(small.width, small.height) * matScale(m);
  const overlay = (() => {
    if (!fit.w || comparing) return null;
    switch (tool) {
      case 'crop':
        return (
          <CropBox
            rect={st.crop}
            ratio={ratioValue(ratio)}
            pw={turned.w}
            ph={turned.h}
            onChange={(crop) => edit({ crop })}
          />
        );
      case 'rotate':
        return <StraightenGrid />;
      case 'vignette':
        return (
          <VignetteGuide
            v={st.vignette}
            w={fit.w}
            h={fit.h}
            onMove={(x, y) => edit({ vignette: { ...st.vignette, x, y } })}
          />
        );
      case 'lens':
        return st.lens.shape === 'off' ? null : (
          <LensGuide
            lens={st.lens}
            w={fit.w}
            h={fit.h}
            onMove={(x, y) => edit({ lens: { ...st.lens, x, y } })}
          />
        );
      case 'heal':
        return (
          <HealLayer
            spots={st.heal.map((s) => {
              const [x, y] = apply(m, s.x * small.width, s.y * small.height);
              return { x, y, r: s.r * shortCss };
            })}
            onTap={(cx, cy) => {
              const [x, y] = toPhoto(cx, cy);
              const r = ((brush / 100) * Math.min(fit.w, fit.h)) / shortCss;
              edit({ heal: [...st.heal, { x, y, r }] });
            }}
          />
        );
      case 'text':
        return (
          <TextLayer
            boxes={st.texts.map((tx) => {
              const l = textLayout(tx, m, small.width, small.height);
              return { id: tx.id, x: l.x, y: l.y, w: l.w, h: l.h };
            })}
            chosen={chosenText}
            onChoose={setChosenText}
            onDrag={(id, cx, cy) => {
              const [x, y] = toPhoto(cx, cy);
              edit({
                texts: st.texts.map((tx) =>
                  tx.id === id
                    ? { ...tx, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
                    : tx,
                ),
              });
            }}
          />
        );
      default:
        return null;
    }
  })();

  const panel = (() => {
    const p = { st, edit };
    switch (tool) {
      case 'tune':
        return <TunePanel {...p} onAuto={() => edit({ tune: autoTune(plainPixels(small, st)) })} />;
      case 'detail':
        return <DetailPanel {...p} />;
      case 'curves':
        return <CurvesPanel {...p} histogram={histogram} />;
      case 'wb':
        return (
          <WbPanel {...p} onAuto={() => edit({ wb: autoWhiteBalance(plainPixels(small, st)) })} />
        );
      case 'crop':
        return <CropPanel ratio={ratio} onRatio={chooseRatio} />;
      case 'rotate':
        return <RotatePanel {...p} turn={turn} flip={flip} />;
      case 'vignette':
        return <VignettePanel {...p} />;
      case 'lens':
        return <LensPanel {...p} />;
      case 'effects':
        return <EffectsPanel {...p} />;
      case 'heal':
        return (
          <HealPanel
            brush={brush}
            onBrush={setBrush}
            count={st.heal.length}
            onClear={() => edit({ heal: [] })}
          />
        );
      case 'text':
        return <TextPanel {...p} chosen={chosenText} onAdd={addText} onChoose={setChosenText} />;
      case 'frame':
        return <FramePanel {...p} />;
      case 'size':
        return (
          <SizePanel
            {...p}
            full={full}
            type={type}
            onType={setType}
            quality={quality}
            onQuality={setQuality}
          />
        );
      default:
        return null;
    }
  })();

  const iconButton =
    'rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <EditorFrame
      title={source.name}
      onClose={onClose}
      dirty={hist.at !== savedAt || Boolean(draft && draft !== hist.state)}
      actions={
        <>
          <button
            type="button"
            onClick={hist.undo}
            disabled={!hist.canUndo || Boolean(tool)}
            className={iconButton}
            aria-label={t.editor.undo}
            title={t.editor.undo}
          >
            <Undo2 className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={hist.redo}
            disabled={!hist.canRedo || Boolean(tool)}
            className={iconButton}
            aria-label={t.editor.redo}
            title={t.editor.redo}
          >
            <Redo2 className="h-5 w-5" />
          </button>
          <button
            type="button"
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            onPointerCancel={() => setComparing(false)}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              iconButton,
              'touch-none select-none',
              comparing && 'bg-[var(--accent-soft)]',
            )}
            aria-label={t.editor.compare}
            title={t.editor.compare}
          >
            <Eye className="h-5 w-5" />
          </button>
          <Button onClick={() => void save()} disabled={busy} className="ml-1 h-9 px-4">
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
          {overlay}
        </div>
      </div>

      <div className="border-t border-[var(--border)] bg-[var(--card)]">
        {tool ? (
          <>
            <div className="mx-auto max-h-[40vh] max-w-2xl overflow-y-auto px-3 py-3">{panel}</div>
            <div className="flex items-center justify-between border-t border-[var(--border)] px-2 py-1">
              <button
                type="button"
                onClick={() => closeTool(false)}
                className="rounded-full p-2.5 hover:bg-[var(--bg-subtle)]"
                aria-label={t.common.cancel}
                title={t.common.cancel}
              >
                <X className="h-5 w-5" />
              </button>
              <span className="text-sm font-medium">{t.editor.toolNames[tool]}</span>
              <button
                type="button"
                onClick={() => closeTool(true)}
                className="rounded-full p-2.5 text-[var(--accent)] hover:bg-[var(--bg-subtle)]"
                aria-label={t.editor.apply}
                title={t.editor.apply}
              >
                <Check className="h-5 w-5" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto max-w-2xl px-2 py-2">
              {tab === 'looks' ? (
                <Looks
                  img={small}
                  st={st}
                  onPick={(id) => {
                    hist.push({ ...hist.state, look: { id, amount: 100 } });
                    setDraft(null);
                  }}
                  onAmount={(amount) => edit({ look: { ...st.look, amount } })}
                  onAmountDone={() => {
                    settle();
                    setDraft(null);
                  }}
                />
              ) : (
                <div className="grid grid-cols-5 gap-y-1 sm:grid-cols-7">
                  {TOOLS.map(([id, icon]) => (
                    <ToolButton
                      key={id}
                      icon={icon}
                      label={t.editor.toolNames[id]!}
                      onClick={() => openTool(id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <nav
              className="flex justify-center gap-6 border-t border-[var(--border)] text-sm"
              aria-label={t.editor.photo}
            >
              {(['looks', 'tools'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    settle();
                    setDraft(null);
                    setTab(id);
                  }}
                  aria-current={tab === id ? 'page' : undefined}
                  className={cn(
                    'border-t-2 px-4 py-2.5',
                    tab === id
                      ? 'border-brand-600 font-semibold text-[var(--fg)]'
                      : 'border-transparent text-[var(--fg-muted)]',
                  )}
                >
                  {id === 'looks' ? t.editor.looks : t.editor.toolsTab}
                </button>
              ))}
            </nav>
          </>
        )}
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

const LOOK_IDS = Object.keys(LOOKS) as LookId[];

function Looks({
  img,
  st,
  onPick,
  onAmount,
  onAmountDone,
}: {
  img: ImageBitmap;
  st: PhotoState;
  onPick: (id: LookId) => void;
  onAmount: (v: number) => void;
  onAmountDone: () => void;
}) {
  const [thumbs, setThumbs] = useState<Partial<Record<LookId, string>>>({});
  // The thumbnails show the photo as edited, each with its look; redrawn when the edits change.
  const base = useMemo(() => ({ ...st, look: { id: 'none' as LookId, amount: 100 } }), [st]);
  const key = JSON.stringify({ ...base, texts: base.texts.length });
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      (async () => {
        const tiny = await scaled(img, 200);
        const c = document.createElement('canvas');
        const tw = turnedSize(tiny.width, tiny.height, base.o.turn);
        const s = 72 / Math.max(tw.w * base.crop.w, tw.h * base.crop.h);
        c.width = Math.max(1, Math.round(tw.w * base.crop.w * s));
        c.height = Math.max(1, Math.round(tw.h * base.crop.h * s));
        const out: Partial<Record<LookId, string>> = {};
        for (const f of LOOK_IDS) {
          drawPhoto(c, tiny, { ...base, look: { id: f, amount: 100 } }, base.crop);
          out[f] = c.toDataURL('image/jpeg', 0.8);
        }
        if (alive) setThumbs(out);
      })().catch(() => undefined);
    }, 150);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redrawn when the edits (key) change
  }, [img, key]);
  return (
    <div className="space-y-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {LOOK_IDS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onPick(f)}
            aria-pressed={st.look.id === f}
            className="flex shrink-0 flex-col items-center gap-1 text-[11px]"
          >
            <span
              className={cn(
                'flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-xl border-2 border-transparent bg-[var(--bg-subtle)]',
                st.look.id === f && 'border-brand-500',
              )}
            >
              {thumbs[f] && <img src={thumbs[f]} alt="" className="max-h-full max-w-full" />}
            </span>
            {t.editor.lookNames[f]}
          </button>
        ))}
      </div>
      {st.look.id !== 'none' && (
        <div onPointerUp={onAmountDone} onKeyUp={onAmountDone}>
          <Slider
            label={t.editor.adjustments.amount!}
            min={0}
            zero={100}
            value={st.look.amount}
            onChange={onAmount}
          />
        </div>
      )}
    </div>
  );
}
