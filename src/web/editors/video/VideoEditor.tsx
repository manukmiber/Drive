// Video editor (ADR-050): a timeline of parts from one or more clips. Cut (set where a part starts
// and ends), split at the playhead, delete or reorder parts, add clips, then save one joined file
// or every part as its own file.
import {
  ArrowLeft,
  ArrowRight,
  ChevronFirst,
  ChevronLast,
  Pause,
  Play,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { formatBytes } from '../../../shared/format';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/ui/Dialog';
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
import { EditError, canReencode, probe, render, type RenderMode } from './engine';
import {
  clock,
  length,
  locate,
  move,
  remove,
  split,
  startOf,
  total,
  trim,
  type Part,
} from './timeline';

interface Clip {
  id: string;
  source: Source;
  url: string;
  duration: number;
}

const COLORS = [
  'bg-brand-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
];

let seq = 0;
const newId = () => `p${++seq}`;

export function VideoEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'video');
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    if (!sources) return;
    let alive = true;
    const made: Clip[] = [];
    (async () => {
      for (const s of sources) {
        const info = await probe(s.blob);
        made.push({
          id: newId(),
          source: s,
          url: URL.createObjectURL(s.blob),
          duration: info.duration,
        });
      }
      if (alive) setClips(made);
    })().catch(() => alive && setProbeError(t.editor.cannotOpen));
    return () => {
      alive = false;
    };
  }, [sources]);
  useEffect(() => () => clips?.forEach((c) => URL.revokeObjectURL(c.url)), [clips]);

  const title = sources?.[0]?.name ?? t.editor.video;
  if (error || probeError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? probeError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!clips)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Workspace initial={clips} onClose={onClose} />;
}

function Workspace({ initial, onClose }: { initial: Clip[]; onClose: () => void }) {
  const config = useConfig();
  const [clips, setClips] = useState(initial);
  const [hist, setHist] = useState(() => ({
    list: [initial.map((c) => ({ id: newId(), clip: c.id, start: 0, end: c.duration }))],
    at: 0,
  }));
  const parts = hist.list[hist.at]!;
  const commit = useCallback(
    (next: Part[]) =>
      setHist((h) =>
        next === h.list[h.at] ? h : { list: [...h.list.slice(0, h.at + 1), next], at: h.at + 1 },
      ),
    [],
  );
  const [selected, setSelected] = useState(parts[0]!.id);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<{ progress: number; cancel: () => void } | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const clipOf = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const index = new Map(clips.map((c, i) => [c.id, i]));
  const sum = total(parts);
  const sel = parts.find((p) => p.id === selected) ?? parts[0]!;
  const selIndex = parts.indexOf(sel);
  // Where the playhead is: which part, and the time in its clip.
  const here = locate(parts, Math.min(time, sum));
  const current = useRef<number>(0);

  /** Shows timeline time `tl` in the player. */
  const show = useCallback(
    (tl: number, keepPlaying = false) => {
      const v = video.current;
      const loc = locate(parts, Math.max(0, Math.min(tl, sum)));
      if (!v || !loc) return;
      const part = parts[loc.index]!;
      const clip = clipOf.get(part.clip)!;
      current.current = loc.index;
      if (v.dataset.clip !== clip.id) {
        v.dataset.clip = clip.id;
        v.src = clip.url;
      }
      v.currentTime = loc.at;
      setTime(loc.offset + (loc.at - part.start));
      if (keepPlaying) void v.play().catch(() => setPlaying(false));
    },
    [parts, sum, clipOf],
  );

  // Keep the player on the playhead when the parts change.
  useEffect(() => {
    if (!playing) show(Math.min(time, sum));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the parts change
  }, [parts]);

  // While playing: follow the clip's time, and jump to the next part at each part's end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      const i = current.current;
      const part = parts[i];
      if (v && part) {
        if (v.currentTime >= part.end - 0.02 || v.ended) {
          if (i + 1 < parts.length) {
            show(startOf(parts, i + 1), true);
          } else {
            v.pause();
            setPlaying(false);
            setTime(sum);
            return;
          }
        } else {
          setTime(startOf(parts, i) + Math.max(0, v.currentTime - part.start));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, parts, show, sum]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
    } else {
      show(time >= sum - 0.05 ? 0 : time, true);
      setPlaying(true);
    }
  };

  const seekTo = (e: PointerEvent) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    const tl = ((e.clientX - r.left) / r.width) * sum;
    const loc = locate(parts, tl);
    if (loc) setSelected(parts[loc.index]!.id);
    show(tl, playing);
  };

  const edit = (next: Part[]) => {
    if (playing) {
      video.current?.pause();
      setPlaying(false);
    }
    commit(next);
  };
  const doSplit = () => {
    const id = newId();
    const next = split(parts, time, id);
    if (next !== parts) {
      edit(next);
      setSelected(id);
    }
  };
  const setEdge = (edge: 'start' | 'end') => {
    if (!here || parts[here.index]!.id !== sel.id) return toast(t.editor.playheadOutside);
    edit(trim(parts, sel.id, edge, here.at));
    if (edge === 'start') setTime(startOf(parts, selIndex));
  };

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      const added: Clip[] = [];
      for (const f of Array.from(files)) {
        const s = fromFile(f, maxBytes(config, 'video'));
        const info = await probe(s.blob);
        added.push({
          id: newId(),
          source: s,
          url: URL.createObjectURL(s.blob),
          duration: info.duration,
        });
      }
      setClips((c) => [...c, ...added]);
      edit([
        ...parts,
        ...added.map((c) => ({ id: newId(), clip: c.id, start: 0, end: c.duration })),
      ]);
    } catch (e) {
      toast(
        e instanceof TooLargeError ? t.editor.tooLarge(formatBytes(e.max)) : t.editor.cannotOpen,
        {
          tone: 'error',
        },
      );
    }
  }

  async function run(mode: RenderMode, each: boolean) {
    setExporting(false);
    video.current?.pause();
    setPlaying(false);
    const ac = new AbortController();
    setBusy({ progress: 0, cancel: () => ac.abort() });
    const groups = each ? parts.map((p) => [p]) : [parts];
    const out: Result[] = [];
    try {
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        const r = await render(
          group.map((p) => ({
            source: clipOf.get(p.clip)!.source.blob,
            start: p.start,
            end: p.end,
          })),
          {
            mode,
            signal: ac.signal,
            onProgress: (p) => setBusy((b) => b && { ...b, progress: (g + p) / groups.length }),
          },
        );
        const first = clipOf.get(group[0]!.clip)!.source.name;
        out.push({
          blob: r.blob,
          name: resultName(
            first,
            r.ext,
            each
              ? t.editor.partSuffix(g + 1)
              : new Set(group.map((p) => p.clip)).size > 1
                ? t.editor.mergedSuffix
                : t.editor.editSuffix,
          ),
        });
      }
      setResults(out);
    } catch (e) {
      const code = e instanceof EditError ? e.code : 'UNREADABLE';
      if (code !== 'CANCELED')
        toast(
          code === 'INCOMPATIBLE'
            ? t.editor.incompatible
            : code === 'CANNOT_ENCODE'
              ? t.editor.cannotEncode
              : t.editor.cannotOpen,
          { tone: 'error' },
        );
    } finally {
      setBusy(null);
    }
  }

  const single = clips.length === 1 ? clips[0]!.source : null;
  const [savedAt, setSavedAt] = useState(0);
  // Adding a clip adds parts, so the history covers it.
  const dirty = hist.at !== savedAt;
  return (
    <EditorFrame
      title={clips.length > 1 ? t.editor.mergeVideos(clips.length) : clips[0]!.source.name}
      onClose={onClose}
      dirty={dirty}
      actions={
        <>
          <button
            type="button"
            onClick={() => setHist((h) => ({ ...h, at: Math.max(0, h.at - 1) }))}
            disabled={hist.at === 0}
            className="rounded-full px-3 py-2 text-sm hover:bg-[var(--bg-subtle)] disabled:opacity-40"
          >
            {t.editor.undo}
          </button>
          <Button onClick={() => setExporting(true)} className="h-9 px-4">
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        <video
          ref={video}
          playsInline
          preload="auto"
          className="max-h-full max-w-full"
          onClick={toggle}
          onError={() => setUnplayable(true)}
          onLoadedData={() => setUnplayable(false)}
        />
        {unplayable && (
          <p className="absolute inset-x-4 bottom-4 rounded-xl bg-black/70 p-3 text-center text-xs text-white">
            {t.editor.cannotPlay}
          </p>
        )}
      </div>

      <div className="border-t border-[var(--border)] bg-[var(--card)] px-3 pt-3 pb-1">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggle}
              className="rounded-full bg-brand-600 p-2.5 text-white hover:bg-brand-700"
              aria-label={playing ? t.editor.pause : t.editor.play}
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>
            <span className="text-sm tabular-nums">
              {clock(time)} <span className="text-[var(--fg-muted)]">/ {clock(sum)}</span>
            </span>
            <span className="ml-auto truncate text-xs text-[var(--fg-muted)]">
              {t.editor.partInfo(
                selIndex + 1,
                clock(sel.start),
                clock(sel.end),
                clock(length(sel)),
              )}
            </span>
          </div>

          <div
            ref={bar}
            role="slider"
            tabIndex={0}
            aria-label={t.editor.timeline}
            aria-valuemin={0}
            aria-valuemax={Math.round(sum)}
            aria-valuenow={Math.round(time)}
            className="relative flex h-14 cursor-pointer touch-none gap-0.5 overflow-hidden rounded-xl bg-[var(--bg-subtle)] select-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seekTo(e);
            }}
            onPointerMove={(e) => e.buttons && seekTo(e)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') show(time - 1);
              if (e.key === 'ArrowRight') show(time + 1);
              if (e.key === ' ') {
                e.preventDefault();
                toggle();
              }
            }}
          >
            {parts.map((p, i) => (
              <div
                key={p.id}
                style={{ flexGrow: length(p), flexBasis: 0 }}
                className={cn(
                  'relative flex min-w-[6px] items-center overflow-hidden rounded-lg px-1.5 text-[11px] font-medium text-white/95',
                  COLORS[(index.get(p.clip) ?? 0) % COLORS.length],
                  p.id === sel.id ? 'ring-2 ring-[var(--fg)] ring-inset' : 'opacity-75',
                )}
              >
                <span className="truncate">{i + 1}</span>
              </div>
            ))}
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--fg)]"
              style={{ left: `${sum ? (time / sum) * 100 : 0}%` }}
            />
          </div>

          <div className="flex gap-1 overflow-x-auto pb-1">
            <ToolButton icon={Scissors} label={t.editor.splitHere} onClick={doSplit} />
            <ToolButton
              icon={ChevronFirst}
              label={t.editor.setStart}
              onClick={() => setEdge('start')}
            />
            <ToolButton icon={ChevronLast} label={t.editor.setEnd} onClick={() => setEdge('end')} />
            <ToolButton
              icon={Trash2}
              label={t.editor.deletePart}
              disabled={parts.length < 2}
              onClick={() => {
                const next = remove(parts, sel.id);
                edit(next);
                setSelected(next[Math.max(0, selIndex - 1)]!.id);
              }}
            />
            <ToolButton
              icon={ArrowLeft}
              label={t.editor.moveLeft}
              disabled={selIndex === 0}
              onClick={() => edit(move(parts, sel.id, -1))}
            />
            <ToolButton
              icon={ArrowRight}
              label={t.editor.moveRight}
              disabled={selIndex === parts.length - 1}
              onClick={() => edit(move(parts, sel.id, 1))}
            />
            <ToolButton
              icon={Plus}
              label={t.editor.addVideo}
              onClick={() => addInput.current?.click()}
            />
            <input
              ref={addInput}
              type="file"
              accept="video/*"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>

      <ExportDialog
        open={exporting}
        parts={parts.length}
        onClose={() => setExporting(false)}
        onRun={(mode, each) => void run(mode, each)}
      />
      {busy && (
        <Busy
          label={t.editor.progress(Math.round(busy.progress * 100))}
          progress={busy.progress}
          onCancel={busy.cancel}
        />
      )}
      <SaveDialog
        results={results}
        source={single ?? clips[0]!.source}
        replaceable={Boolean(single)}
        onClose={() => setResults(null)}
        onSaved={() => setSavedAt(hist.at)}
      />
    </EditorFrame>
  );
}

function ExportDialog({
  open,
  parts,
  onClose,
  onRun,
}: {
  open: boolean;
  parts: number;
  onClose: () => void;
  onRun: (mode: RenderMode, each: boolean) => void;
}) {
  const [mode, setMode] = useState<RenderMode>('fast');
  const [each, setEach] = useState(false);
  const [precise, setPrecise] = useState<boolean | null>(null);
  useEffect(() => {
    if (open && precise === null) void canReencode().then(setPrecise, () => setPrecise(false));
  }, [open, precise]);
  const option = (
    checked: boolean,
    onPick: () => void,
    title: string,
    body: string,
    disabled = false,
  ) => (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-xl border border-[var(--border)] p-3',
        checked && 'border-brand-500 bg-[var(--accent-soft)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="mt-0.5"
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-[var(--fg-muted)]">{body}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open={open}
      title={t.editor.exportTitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => onRun(mode, parts > 1 && each)}>{t.editor.render}</Button>
        </>
      }
    >
      <div className="space-y-2">
        {option(mode === 'fast', () => setMode('fast'), t.editor.modeFast, t.editor.modeFastDesc)}
        {option(
          mode === 'precise',
          () => setMode('precise'),
          t.editor.modePrecise,
          precise === false ? t.editor.preciseUnavailable : t.editor.modePreciseDesc,
          precise === false,
        )}
        {parts > 1 && (
          <fieldset className="space-y-1.5 pt-2">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!each} onChange={() => setEach(false)} />
              {t.editor.outputOne}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={each} onChange={() => setEach(true)} />
              {t.editor.outputEach(parts)}
            </label>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
