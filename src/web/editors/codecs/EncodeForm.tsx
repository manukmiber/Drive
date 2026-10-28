// The encode settings (ADR-067): container, codecs, quality control, size, frame rate and the
// audio, shared by the local compressor and the video editor's export. Only what this browser can
// encode is offered; the rest shows why it isn't.
import type { AudioCodec, VideoCodec } from 'mediabunny';
import { useEffect, useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { t } from '../../lib/i18n';
import { Chips, Field, NumberBox, Select, Slider } from '../controls';
import {
  AUDIO_LABEL,
  CONTAINERS,
  RF,
  VIDEO_LABEL,
  audioCodecsOf,
  audioHasBitrate,
  containerOf,
  encodableAudio,
  encodableVideo,
  estimateBytes,
  videoCodecsOf,
  type ContainerId,
  type EncodeSettings,
  type HwPreference,
  type RateMode,
} from './media';

export const HEIGHTS = [0, 2160, 1440, 1080, 720, 576, 480, 360, 240];
export const FPS = [0, 60, 50, 30, 25, 24, 15];
const AUDIO_BITRATES = [32, 48, 64, 96, 128, 160, 192, 256, 320];
const KEYFRAMES = [1, 2, 5, 10];

export interface SourceInfo {
  w: number;
  h: number;
  fps: number;
  seconds: number;
  bytes: number;
}

/** What this browser can encode into `container` at about `w`×`h`; null while asking. */
export function useEncodable(container: ContainerId, w = 1920, h = 1080) {
  const [state, setState] = useState<{
    key: string;
    video: VideoCodec[];
    audio: AudioCodec[];
  } | null>(null);
  const key = `${container}:${w}x${h}`;
  useEffect(() => {
    let alive = true;
    void Promise.all([
      encodableVideo(videoCodecsOf(container), w || 1920, h || 1080),
      encodableAudio(audioCodecsOf(container)),
    ]).then(([video, audio]) => alive && setState({ key, video, audio }));
    return () => {
      alive = false;
    };
  }, [container, w, h, key]);
  return state?.key === key ? state : null;
}

/**
 * Keeps the settings inside what the container and browser allow: a codec it can't take becomes
 * the first one it can.
 */
export function fitSettings(
  s: EncodeSettings,
  can: { video: VideoCodec[]; audio: AudioCodec[] },
  allowCopy: boolean,
): EncodeSettings {
  const hasVideo = containerOf(s.container).video;
  let video = s.video;
  if (
    hasVideo &&
    !(allowCopy && video.codec === 'copy') &&
    !can.video.includes(video.codec as VideoCodec)
  ) {
    const codec = can.video[0];
    if (codec) video = { ...video, codec, rf: RF[codec]?.def ?? video.rf };
  }
  let audio = s.audio;
  const keep = audio.codec === 'none' || (allowCopy && audio.codec === 'copy');
  if (!keep && !can.audio.includes(audio.codec as AudioCodec))
    audio = { ...audio, codec: can.audio[0] ?? 'none' };
  return video === s.video && audio === s.audio ? s : { ...s, video, audio };
}

export function ContainerField({
  value,
  onChange,
  audioOnly = false,
}: {
  value: ContainerId;
  onChange: (c: ContainerId) => void;
  /** Offer only the audio containers. */
  audioOnly?: boolean;
}) {
  return (
    <Field label={t.encode.container}>
      <Select
        value={value}
        onChange={onChange}
        options={CONTAINERS.filter((c) => !audioOnly || !c.video).map(
          (c) => [c.id, `${c.label} (.${c.ext})`] as const,
        )}
      />
    </Field>
  );
}

/** Video codec, quality control, resolution, frame rate, key frames, encoder. */
export function VideoFields({
  value: s,
  onChange,
  allowCopy = false,
  source,
}: {
  value: EncodeSettings;
  onChange: (s: EncodeSettings) => void;
  allowCopy?: boolean;
  source?: SourceInfo | null;
}) {
  const can = useEncodable(s.container, source?.w, source?.h);
  const v = s.video;
  const set = (p: Partial<typeof v>) => onChange({ ...s, video: { ...v, ...p } });
  if (!containerOf(s.container).video)
    return <p className="text-sm text-[var(--fg-muted)]">{t.encode.audioOnly}</p>;
  if (!can) return <p className="text-sm text-[var(--fg-muted)]">{t.encode.checking}</p>;
  if (!can.video.length && !allowCopy)
    return <p className="text-sm text-red-600">{t.encode.noVideoEncoder}</p>;
  const all = videoCodecsOf(s.container);
  const copying = v.codec === 'copy';
  const rf = RF[v.codec] ?? RF.avc!;
  return (
    <div className="space-y-3">
      <Field label={t.encode.videoCodec}>
        <Select
          value={v.codec}
          onChange={(codec) =>
            set(codec === 'copy' ? { codec } : { codec, rf: RF[codec]?.def ?? v.rf })
          }
          options={[
            ...(allowCopy ? [['copy', t.encode.copy] as const] : []),
            ...all.map(
              (c) =>
                [
                  c,
                  can.video.includes(c)
                    ? VIDEO_LABEL[c]!
                    : `${VIDEO_LABEL[c]} — ${t.localCompress.unavailable}`,
                  !can.video.includes(c),
                ] as const,
            ),
          ]}
        />
      </Field>
      {!copying && (
        <>
          <Field
            label={t.encode.rate}
            hint={
              v.rate === 'quality'
                ? t.encode.rateQualityDesc
                : v.rate === 'bitrate'
                  ? t.encode.rateBitrateDesc
                  : t.encode.rateSizeDesc
            }
          >
            <Chips<RateMode>
              items={[
                ['quality', t.encode.rateQuality],
                ['bitrate', t.encode.rateBitrate],
                ['size', t.encode.rateSize],
              ]}
              value={v.rate}
              onChange={(rate) => set({ rate })}
            />
            {v.rate === 'quality' && (
              <>
                <Slider
                  label={t.encode.rf}
                  min={rf.min}
                  max={rf.max}
                  zero={rf.def}
                  value={Math.max(rf.min, Math.min(rf.max, v.rf))}
                  onChange={(n) => set({ rf: n })}
                />
                <p className="text-[11px] text-[var(--fg-muted)]">
                  {t.encode.rfHint(rf.min, rf.max)}
                </p>
              </>
            )}
            {v.rate === 'bitrate' && (
              <NumberBox
                label={t.encode.rateBitrate}
                value={v.bitrate}
                min={100}
                max={100_000}
                step={100}
                unit={t.encode.kbps}
                onChange={(bitrate) => set({ bitrate })}
              />
            )}
            {v.rate === 'size' && (
              <NumberBox
                label={t.encode.rateSize}
                value={v.sizeMb}
                min={1}
                max={100_000}
                unit={t.encode.mb}
                onChange={(sizeMb) => set({ sizeMb })}
              />
            )}
          </Field>
          <Field label={t.encode.resolution}>
            <Chips
              items={HEIGHTS.map((h) => [String(h), h ? `${h}p` : t.encode.original] as const)}
              value={String(v.height)}
              onChange={(h) => set({ height: Number(h) })}
            />
          </Field>
          <Field label={t.encode.fps}>
            <Chips
              items={FPS.map((f) => [String(f), f ? String(f) : t.encode.original] as const)}
              value={String(v.fps)}
              onChange={(f) => set({ fps: Number(f) })}
            />
          </Field>
          <details className="rounded-xl border border-[var(--border)] px-3 py-2">
            <summary className="cursor-pointer text-sm">{t.encode.advanced}</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label={t.encode.keyframe}>
                <Select
                  value={v.keyframe}
                  onChange={(keyframe) => set({ keyframe })}
                  options={KEYFRAMES.map((k) => [k, t.encode.seconds(k)] as const)}
                />
              </Field>
              <Field label={t.encode.hw}>
                <Select<HwPreference>
                  value={v.hw}
                  onChange={(hw) => set({ hw })}
                  options={[
                    ['no-preference', t.encode.hwAuto],
                    ['prefer-hardware', t.encode.hwHardware],
                    ['prefer-software', t.encode.hwSoftware],
                  ]}
                />
              </Field>
            </div>
          </details>
        </>
      )}
      <Estimate value={s} source={source} />
    </div>
  );
}

export function AudioFields({
  value: s,
  onChange,
  allowCopy = false,
  source,
}: {
  value: EncodeSettings;
  onChange: (s: EncodeSettings) => void;
  allowCopy?: boolean;
  source?: SourceInfo | null;
}) {
  const can = useEncodable(s.container);
  const a = s.audio;
  const set = (p: Partial<typeof a>) => onChange({ ...s, audio: { ...a, ...p } });
  if (!can) return <p className="text-sm text-[var(--fg-muted)]">{t.encode.checking}</p>;
  const audioOnly = !containerOf(s.container).video;
  const wasm = a.codec === 'mp3' || a.codec === 'aac' || a.codec === 'flac';
  return (
    <div className="space-y-3">
      <Field label={t.encode.audioCodec} hint={wasm ? t.encode.wasmNote : undefined}>
        <Select
          value={a.codec}
          onChange={(codec) => set({ codec })}
          options={[
            ...(allowCopy ? [['copy', t.encode.copy] as const] : []),
            ...can.audio.map((c) => [c, AUDIO_LABEL[c] ?? c] as const),
            ...(audioOnly ? [] : [['none', t.encode.noAudio] as const]),
          ]}
        />
      </Field>
      {a.codec !== 'none' && a.codec !== 'copy' && (
        <>
          {audioHasBitrate(a.codec) && (
            <Field label={t.encode.audioBitrate}>
              <Chips
                items={AUDIO_BITRATES.map((b) => [String(b), `${b}`] as const)}
                value={String(a.bitrate)}
                onChange={(b) => set({ bitrate: Number(b) })}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.encode.sampleRate}>
              <Select
                value={a.sampleRate}
                onChange={(sampleRate) => set({ sampleRate })}
                options={[
                  [0, t.encode.original],
                  [44_100, '44.1 kHz'],
                  [48_000, '48 kHz'],
                ]}
              />
            </Field>
            <Field label={t.encode.channels}>
              <Select
                value={a.channels}
                onChange={(channels) => set({ channels })}
                options={[
                  [0, t.encode.original],
                  [1, t.encode.mono],
                  [2, t.encode.stereo],
                ]}
              />
            </Field>
          </div>
        </>
      )}
      {audioOnly && <Estimate value={s} source={source} />}
    </div>
  );
}

function Estimate({ value, source }: { value: EncodeSettings; source?: SourceInfo | null }) {
  if (!source) return null;
  const bytes = estimateBytes(value, source);
  if (bytes == null) return null;
  return <p className="text-xs text-[var(--fg-muted)]">{t.encode.estimate(formatBytes(bytes))}</p>;
}
