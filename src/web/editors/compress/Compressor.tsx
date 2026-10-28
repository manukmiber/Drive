// The local compressor (ADR-067): a list of videos, audio and photos from Drive or this device,
// compressed one after another in the browser, free. Settings like HandBrake's: presets, then the
// container, codecs, quality control (RF, bitrate or target size), resolution, frame rate, trim,
// and for photos the format (JPEG XL and AVIF too), quality and size.
import type { VideoCodec } from 'mediabunny';
import {
  AudioLines,
  Clapperboard,
  ImageIcon,
  Play,
  Plus,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { Button } from '../../components/Button';
import { toast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import type { NodeDto } from '../../lib/files';
import { t } from '../../lib/i18n';
import { IMAGE_LABEL, IMAGE_TYPES, lossless as noQuality, type ImageType } from '../codecs/image';
import {
  AudioFields,
  ContainerField,
  VideoFields,
  fitSettings,
  useEncodable,
  type SourceInfo,
} from '../codecs/EncodeForm';
import { encodableVideo, type ContainerId, type EncodeSettings } from '../codecs/media';
import { Chips, Field, Slider, Toggle } from '../controls';
import {
  TooLargeError,
  isImage,
  isVideo,
  loadNode,
  maxBytes,
  resultName,
  type EditRequest,
  type Source,
} from '../files';
import { clock } from '../video/timeline';
import { EditorFrame, SaveDialog, errorMessage, useConfig, type Result } from '../ui';
import { CompressError, compressMedia, probeMedia, type MediaInfo } from './convert';
import { DEFAULT_IMAGE, compressImage, imageInfo, type ImageSettings } from './image';
import { PRESETS, PRESET_IDS, type PresetId } from './presets';
import { driveMediaSource, fileMediaSource } from './sources';

type Kind = 'video' | 'audio' | 'image';
type Status = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'canceled';

interface Item {
  id: string;
  name: string;
  size: number;
  kind: Kind;
  node: NodeDto | null;
  file: Blob | null;
  media: MediaInfo | null;
  pixels: { width: number; height: number } | null;
  status: Status;
  progress: number;
  /** Frames a second while running, and the seconds left. */
  speed: { fps: number; left: number } | null;
  result: Result | null;
  error: string | null;
}

const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;

function kindOf(mime: string | null, name: string): Kind | null {
  if (isVideo(mime, name)) return 'video';
  if ((mime ?? '').startsWith('audio/') || AUDIO.test(name)) return 'audio';
  if (isImage(mime, name) || /\.jxl$/i.test(name) || mime === 'image/jxl') return 'image';
  return null;
}

const KIND_ICON: Record<Kind, LucideIcon> = {
  video: Clapperboard,
  audio: AudioLines,
  image: ImageIcon,
};

let seq = 0;
const newId = () => `c${++seq}`;

function itemOf(
  src: { name: string; size: number; mime: string | null },
  node: NodeDto | null,
  file: Blob | null,
): Item | null {
  const kind = kindOf(src.mime, src.name);
  if (!kind) return null;
  return {
    id: newId(),
    name: src.name,
    size: src.size,
    kind,
    node,
    file,
    media: null,
    pixels: null,
    status: 'waiting',
    progress: 0,
    speed: null,
    result: null,
    error: null,
  };
}

/** "1:05" or "65" → seconds; empty → null. */
function parseClock(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  const parts = v.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

/** Audio alone in a video container gets the audio name of that container. */
function forAudio(c: ContainerId): ContainerId {
  return c === 'mp4' || c === 'mov' ? 'm4a' : c;
}

export function Compressor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const config = useConfig();
  const [items, setItems] = useState<Item[]>(() =>
    [
      ...request.nodes.map((n) => itemOf({ name: n.name, size: n.size, mime: n.mime }, n, null)),
      ...request.files.map((f) => itemOf({ name: f.name, size: f.size, mime: f.type }, null, f)),
    ].filter((x): x is Item => Boolean(x)),
  );
  const [preset, setPreset] = useState<PresetId>('fast1080');
  const [chosen, setSettings] = useState<EncodeSettings>(PRESETS.fast1080);
  const [image, setImage] = useState<ImageSettings>(DEFAULT_IMAGE);
  const [tab, setTab] = useState<'preset' | 'video' | 'audio' | 'picture' | 'image'>('preset');
  const [trim, setTrim] = useState({ from: '', to: '' });
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0);
  const [flip, setFlip] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState<Result[] | null>(null);
  const [saved, setSaved] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const can = useEncodable(chosen.container);
  // Settings the browser can't do become ones it can.
  const settings = can ? fitSettings(chosen, can, true) : chosen;
  const [videoCodecs, setVideoCodecs] = useState<VideoCodec[] | null>(null);

  useEffect(() => {
    void encodableVideo(['avc', 'hevc', 'vp9', 'av1', 'vp8']).then(setVideoCodecs);
  }, []);
  const patch = (id: string, p: Partial<Item>) =>
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));

  // Read what each new file is: size, length, codecs (Drive files in small ranges).
  const probing = useRef(new Set<string>());
  useEffect(() => {
    for (const it of items) {
      if (it.media || it.pixels || it.error || probing.current.has(it.id)) continue;
      probing.current.add(it.id);
      if (it.kind === 'image') {
        if (!it.file) continue; // Drive photos are read when their turn comes.
        void imageInfo(it.file, it.name).then(
          (pixels) => patch(it.id, { pixels }),
          () => patch(it.id, { error: t.localCompress.reasons.UNREADABLE! }),
        );
      } else {
        const source = it.node ? driveMediaSource(it.node) : fileMediaSource(it.file!);
        void probeMedia(source).then(
          (media) => patch(it.id, { media }),
          () => patch(it.id, { error: t.localCompress.reasons.UNREADABLE! }),
        );
      }
    }
  }, [items]);

  const media = items.filter((i) => i.kind !== 'image');
  const images = items.filter((i) => i.kind === 'image');
  const single = items.length === 1 ? items[0]! : null;
  const sourceInfo: SourceInfo | null = useMemo(() => {
    const m = single?.media;
    if (!m || !single) return null;
    const from = parseClock(trim.from) ?? 0;
    const to = Math.min(m.duration, parseClock(trim.to) ?? m.duration);
    return {
      w: m.width,
      h: m.height,
      fps: m.fps,
      seconds: Math.max(0.1, to - from),
      bytes: single.size,
    };
  }, [single, trim]);

  function pickPreset(id: PresetId) {
    setPreset(id);
    if (id !== 'custom') setSettings(PRESETS[id]);
  }
  const custom = (s: EncodeSettings) => {
    setPreset('custom');
    setSettings(s);
  };

  function add(list: FileList | null) {
    const files = Array.from(list ?? []);
    const added: Item[] = [];
    for (const f of files) {
      const it = itemOf({ name: f.name, size: f.size, mime: f.type }, null, f);
      if (!it) continue;
      if (it.kind === 'image') {
        const max = maxBytes(config, 'photo');
        if (max && f.size > max) {
          toast(t.editor.tooLarge(formatBytes(max)), { tone: 'error' });
          continue;
        }
      }
      added.push(it);
    }
    if (added.length < files.length && !added.length) toast(t.editor.cannotOpen, { tone: 'error' });
    setItems((l) => [...l, ...added]);
  }

  async function runOne(it: Item, signal: AbortSignal) {
    patch(it.id, { status: 'running', progress: 0, speed: null, error: null, result: null });
    const started = performance.now();
    try {
      if (it.kind === 'image') {
        const blob =
          it.file ??
          (await loadNode(
            it.node!,
            maxBytes(config, 'photo'),
            (p) => patch(it.id, { progress: p * 0.3 }),
            signal,
          ));
        const out = await compressImage(blob, it.name, image);
        if (out.same) return patch(it.id, { status: 'skipped', progress: 1 });
        return patch(it.id, {
          status: 'done',
          progress: 1,
          result: { blob: out.blob, name: resultName(it.name, out.ext, t.localCompress.suffix) },
        });
      }
      const info =
        it.media ??
        (await probeMedia(it.node ? driveMediaSource(it.node) : fileMediaSource(it.file!)));
      const from = single ? (parseClock(trim.from) ?? 0) : 0;
      const to = single
        ? Math.min(info.duration, parseClock(trim.to) ?? info.duration)
        : info.duration;
      const job = {
        settings: info.width ? settings : { ...settings, container: forAudio(settings.container) },
        trim:
          from > 0 || to < info.duration ? { start: from, end: Math.max(from + 0.1, to) } : null,
        rotate,
        flip,
      };
      const span = to - from;
      const out = await compressMedia(
        it.node ? driveMediaSource(it.node) : fileMediaSource(it.file!),
        info,
        job,
        {
          signal,
          onProgress: (p) => {
            const secs = (performance.now() - started) / 1000;
            const fps = info.fps && secs > 1 ? (p * span * info.fps) / secs : 0;
            const left = p > 0.02 ? (secs / p) * (1 - p) : 0;
            patch(it.id, { progress: p, speed: { fps: Math.round(fps), left } });
          },
        },
      );
      patch(it.id, {
        status: 'done',
        progress: 1,
        speed: null,
        result: { blob: out.blob, name: resultName(it.name, out.ext, t.localCompress.suffix) },
      });
    } catch (e) {
      if (signal.aborted || (e instanceof CompressError && e.code === 'CANCELED'))
        return patch(it.id, { status: 'canceled', speed: null });
      const message =
        e instanceof CompressError
          ? (t.localCompress.reasons[e.code] ?? t.localCompress.reasons.CANNOT_ENCODE!)
          : e instanceof TooLargeError
            ? errorMessage(e)
            : t.localCompress.reasons.CANNOT_ENCODE!;
      patch(it.id, { status: 'failed', speed: null, error: message });
    }
  }

  async function start() {
    const ac = new AbortController();
    stop.current = ac;
    setRunning(true);
    setSaved(false);
    // Phones sleep and stop the work: keep the screen on while it runs.
    const lock = await navigator.wakeLock?.request('screen').catch(() => null);
    try {
      const todo = items.filter(
        (i) =>
          i.status !== 'done' && i.status !== 'skipped' && !(i.error && i.status === 'waiting'),
      );
      for (const it of todo) {
        if (ac.signal.aborted) break;
        await runOne(it, ac.signal);
      }
    } finally {
      void lock?.release().catch(() => undefined);
      setRunning(false);
      stop.current = null;
    }
  }

  const results = items.flatMap((i) => (i.result ? [i.result] : []));
  const first = items[0];
  const saveSource: Source | null = first
    ? { name: first.name, blob: first.file ?? new Blob([]), node: first.node }
    : null;
  const pending = items.some(
    (i) => i.status === 'waiting' || i.status === 'failed' || i.status === 'canceled',
  );
  const tabs = [
    'preset',
    ...(media.length ? (['video', 'audio', 'picture'] as const) : []),
    ...(images.length ? (['image'] as const) : []),
  ] as Array<typeof tab>;
  const shownTab = tabs.includes(tab) ? tab : tabs[0]!;

  return (
    <EditorFrame
      title={t.localCompress.title}
      onClose={() => {
        stop.current?.abort();
        onClose();
      }}
      dirty={running || (results.length > 0 && !saved)}
      actions={
        <>
          <Button
            variant="ghost"
            className="h-9 px-3"
            onClick={() => addInput.current?.click()}
            disabled={running}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t.localCompress.add}</span>
          </Button>
          {running ? (
            <Button variant="secondary" className="h-9 px-4" onClick={() => stop.current?.abort()}>
              <Square className="h-4 w-4" />
              {t.localCompress.stop}
            </Button>
          ) : results.length > 0 && !pending ? (
            <Button className="h-9 px-4" onClick={() => setSaving(results)}>
              {t.localCompress.saveAll(results.length)}
            </Button>
          ) : (
            <Button className="h-9 px-4" onClick={() => void start()} disabled={!items.length}>
              <Play className="h-4 w-4" />
              {t.localCompress.start}
            </Button>
          )}
        </>
      }
    >
      <input
        ref={addInput}
        type="file"
        multiple
        hidden
        accept="video/*,audio/*,image/*,.jxl,.mkv,.flac,.opus"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-4 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <section className="space-y-2">
            {!items.length && (
              <button
                type="button"
                onClick={() => addInput.current?.click()}
                className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--border)] p-8 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
              >
                <Plus className="h-6 w-6" />
                {t.localCompress.empty}
              </button>
            )}
            <ul className="space-y-2">
              {items.map((it) => (
                <ItemRow
                  key={it.id}
                  it={it}
                  busy={running}
                  onRemove={() => setItems((l) => l.filter((x) => x.id !== it.id))}
                />
              ))}
            </ul>
            {results.length > 0 && !running && pending && (
              <Button variant="secondary" className="w-full" onClick={() => setSaving(results)}>
                {t.localCompress.saveAll(results.length)}
              </Button>
            )}
            <p className="pt-2 text-xs text-[var(--fg-muted)]">{t.localCompress.cloudNote}</p>
            {running && <p className="text-xs font-medium">{t.localCompress.keepOpen}</p>}
          </section>

          <section className="z-card space-y-3 rounded-2xl p-4" aria-disabled={running}>
            <nav className="-mx-1 flex gap-1 overflow-x-auto" aria-label={t.localCompress.title}>
              {tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-current={shownTab === id ? 'page' : undefined}
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1.5 text-sm',
                    shownTab === id
                      ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                      : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]',
                  )}
                >
                  {t.localCompress.tabs[id]}
                </button>
              ))}
            </nav>
            <fieldset disabled={running} className="space-y-3">
              {shownTab === 'preset' && (
                <PresetList value={preset} codecs={videoCodecs} onPick={pickPreset} />
              )}
              {shownTab === 'video' && (
                <>
                  <ContainerField
                    value={settings.container}
                    onChange={(container) => custom({ ...settings, container })}
                  />
                  <VideoFields value={settings} onChange={custom} allowCopy source={sourceInfo} />
                </>
              )}
              {shownTab === 'audio' && (
                <AudioFields value={settings} onChange={custom} allowCopy source={sourceInfo} />
              )}
              {shownTab === 'picture' && (
                <PictureFields
                  single={single?.media ?? null}
                  trim={trim}
                  onTrim={setTrim}
                  rotate={rotate}
                  onRotate={setRotate}
                  flip={flip}
                  onFlip={setFlip}
                />
              )}
              {shownTab === 'image' && <ImageFields value={image} onChange={setImage} />}
            </fieldset>
          </section>
        </div>
      </div>
      <SaveDialog
        results={saving}
        source={saveSource}
        replaceable={items.length === 1}
        onClose={() => setSaving(null)}
        onSaved={() => setSaved(true)}
      />
    </EditorFrame>
  );
}

function describe(it: Item): string {
  const bits = [formatBytes(it.size)];
  const m = it.media;
  if (m) {
    if (m.width) bits.push(`${m.width}×${m.height}`);
    if (m.duration) bits.push(clock(m.duration));
    if (m.fps) bits.push(`${Math.round(m.fps)} fps`);
    bits.push(
      [m.videoCodec, m.audioCodec ?? t.localCompress.noAudioTrack].filter(Boolean).join(' + '),
    );
  } else if (it.pixels) bits.push(`${it.pixels.width}×${it.pixels.height}`);
  return bits.join(' · ');
}

function ItemRow({ it, busy, onRemove }: { it: Item; busy: boolean; onRemove: () => void }) {
  const Icon = KIND_ICON[it.kind];
  const after = it.result?.blob.size ?? 0;
  const status =
    it.status === 'running'
      ? [
          t.localCompress.running(Math.round(it.progress * 100)),
          it.speed?.fps ? t.localCompress.speed(it.speed.fps) : null,
          it.speed?.left ? t.localCompress.eta(clock(it.speed.left).replace(/\.\d$/, '')) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : it.status === 'done' && it.result
        ? t.localCompress.result(
            formatBytes(it.size),
            formatBytes(after),
            Math.round((1 - after / Math.max(1, it.size)) * 100),
          )
        : it.status === 'failed'
          ? (it.error ?? t.localCompress.status.failed!)
          : it.error && it.status === 'waiting'
            ? it.error
            : t.localCompress.status[it.status]!;
  return (
    <li className="z-card rounded-2xl p-3">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-[var(--accent-soft)] p-2 text-[var(--accent)]">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{it.name}</p>
          <p className="truncate text-xs text-[var(--fg-muted)]">{describe(it)}</p>
          <p
            className={cn(
              'mt-1 text-xs',
              it.status === 'failed' || (it.error && it.status === 'waiting')
                ? 'text-red-600'
                : it.status === 'done'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-[var(--fg-muted)]',
            )}
            aria-live="polite"
          >
            {status}
          </p>
        </div>
        {!busy && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            aria-label={t.localCompress.remove}
            title={t.localCompress.remove}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {it.status === 'running' && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
          <div
            className="h-full bg-brand-600 transition-[width]"
            style={{ width: `${it.progress * 100}%` }}
          />
        </div>
      )}
    </li>
  );
}

function PresetList({
  value,
  codecs,
  onPick,
}: {
  value: PresetId;
  codecs: VideoCodec[] | null;
  onPick: (id: PresetId) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {PRESET_IDS.map((id) => {
        const p = id === 'custom' ? null : PRESETS[id];
        const audioOnly = p?.container === 'mp3' || p?.container === 'm4a';
        const works = !p || audioOnly || !codecs || codecs.includes(p.video.codec as VideoCodec);
        return (
          <li key={id}>
            <label
              className={cn(
                'flex cursor-pointer gap-3 rounded-xl border border-[var(--border)] p-2.5',
                value === id && 'border-brand-500 bg-[var(--accent-soft)]',
                !works && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name="preset"
                checked={value === id}
                disabled={!works}
                onChange={() => onPick(id)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">{t.localCompress.presets[id]}</span>
                <span className="block text-xs text-[var(--fg-muted)]">
                  {works ? t.localCompress.presetDesc[id] : t.localCompress.unavailable}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function PictureFields({
  single,
  trim,
  onTrim,
  rotate,
  onRotate,
  flip,
  onFlip,
}: {
  single: MediaInfo | null;
  trim: { from: string; to: string };
  onTrim: (v: { from: string; to: string }) => void;
  rotate: 0 | 90 | 180 | 270;
  onRotate: (r: 0 | 90 | 180 | 270) => void;
  flip: boolean;
  onFlip: (v: boolean) => void;
}) {
  const box =
    'h-9 w-24 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 text-sm tabular-nums';
  return (
    <div className="space-y-3">
      <Field label={t.localCompress.rotate}>
        <Chips
          items={(['0', '90', '180', '270'] as const).map((r) => [r, `${r}°`] as const)}
          value={String(rotate) as '0'}
          onChange={(r) => onRotate(Number(r) as 0)}
        />
      </Field>
      <Toggle checked={flip} onChange={onFlip} label={t.localCompress.flip} />
      {single && (
        <Field label={t.localCompress.trim} hint={t.localCompress.trimHint}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              {t.localCompress.trimFrom}
              <input
                className={box}
                value={trim.from}
                placeholder="0:00"
                inputMode="decimal"
                onChange={(e) => onTrim({ ...trim, from: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2">
              {t.localCompress.trimTo}
              <input
                className={box}
                value={trim.to}
                placeholder={clock(single.duration).replace(/\.\d$/, '')}
                inputMode="decimal"
                onChange={(e) => onTrim({ ...trim, to: e.target.value })}
              />
            </label>
          </div>
        </Field>
      )}
    </div>
  );
}

const MAX_SIDES = [0, 4096, 3840, 2560, 1920, 1600, 1280, 1024, 800];

export function ImageFields({
  value: s,
  onChange,
}: {
  value: ImageSettings;
  onChange: (s: ImageSettings) => void;
}) {
  const set = (p: Partial<ImageSettings>) => onChange({ ...s, ...p });
  const canLossless = s.type === 'image/jxl' || s.type === 'image/webp';
  const slow = s.type === 'image/jxl' || s.type === 'image/avif';
  return (
    <div className="space-y-3">
      <Field
        label={t.localCompress.imageFormat}
        hint={s.type === 'image/jxl' ? t.localCompress.jxlNote : undefined}
      >
        <Chips<ImageType>
          items={IMAGE_TYPES.map((x) => [x, IMAGE_LABEL[x]] as const)}
          value={s.type}
          onChange={(type) => set({ type, lossless: false })}
        />
      </Field>
      {canLossless && (
        <Toggle
          checked={s.lossless}
          onChange={(lossless) => set({ lossless })}
          label={t.localCompress.lossless}
        />
      )}
      {!noQuality(s.type) && !s.lossless && (
        <Slider
          label={t.localCompress.imageQuality}
          min={10}
          max={100}
          zero={80}
          value={Math.round(s.quality * 100)}
          onChange={(q) => set({ quality: q / 100 })}
        />
      )}
      {slow && (
        <>
          <Slider
            label={t.localCompress.effort}
            min={1}
            max={9}
            zero={4}
            value={s.effort}
            onChange={(effort) => set({ effort })}
          />
          <p className="text-[11px] text-[var(--fg-muted)]">{t.localCompress.effortHint}</p>
        </>
      )}
      <Field label={t.localCompress.maxSide}>
        <Chips
          items={MAX_SIDES.map((m) => [String(m), m ? `${m}px` : t.encode.original] as const)}
          value={String(s.maxSide)}
          onChange={(m) => set({ maxSide: Number(m) })}
        />
      </Field>
      <Toggle
        checked={s.keepIfBigger}
        onChange={(keepIfBigger) => set({ keepIfBigger })}
        label={t.localCompress.keepIfBigger}
      />
    </div>
  );
}
