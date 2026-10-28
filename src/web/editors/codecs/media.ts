// Video and audio formats for the local compressor and the video editor's export (ADR-067): which
// containers and codecs there are, which this browser can encode, and the settings in between.
// Encoding is WebCodecs through mediabunny; MP3 always, and AAC and FLAC where the browser has no
// encoder of its own, come from WebAssembly encoders that load only when chosen.
import {
  AdtsOutputFormat,
  FlacOutputFormat,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  OggOutputFormat,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';

export type ContainerId =
  'mp4' | 'mov' | 'webm' | 'mkv' | 'ts' | 'm4a' | 'mp3' | 'ogg' | 'opus' | 'flac' | 'wav' | 'aac';

export interface Container {
  id: ContainerId;
  label: string;
  ext: string;
  /** Holds a picture. Audio-only ones drop it. */
  video: boolean;
}

export const CONTAINERS: Container[] = [
  { id: 'mp4', label: 'MP4', ext: 'mp4', video: true },
  { id: 'mov', label: 'MOV (QuickTime)', ext: 'mov', video: true },
  { id: 'webm', label: 'WebM', ext: 'webm', video: true },
  { id: 'mkv', label: 'MKV (Matroska)', ext: 'mkv', video: true },
  { id: 'ts', label: 'MPEG-TS', ext: 'ts', video: true },
  { id: 'm4a', label: 'M4A (AAC)', ext: 'm4a', video: false },
  { id: 'mp3', label: 'MP3', ext: 'mp3', video: false },
  { id: 'ogg', label: 'Ogg', ext: 'ogg', video: false },
  { id: 'opus', label: 'Opus', ext: 'opus', video: false },
  { id: 'flac', label: 'FLAC', ext: 'flac', video: false },
  { id: 'wav', label: 'WAV', ext: 'wav', video: false },
  { id: 'aac', label: 'AAC (ADTS)', ext: 'aac', video: false },
];

export const containerOf = (id: ContainerId) => CONTAINERS.find((c) => c.id === id)!;

export function makeFormat(id: ContainerId): OutputFormat {
  switch (id) {
    case 'mp4':
    case 'm4a':
      return new Mp4OutputFormat({ fastStart: 'in-memory' });
    case 'mov':
      return new MovOutputFormat({ fastStart: 'in-memory' });
    case 'webm':
      return new WebMOutputFormat();
    case 'mkv':
      return new MkvOutputFormat();
    case 'ts':
      return new MpegTsOutputFormat();
    case 'mp3':
      return new Mp3OutputFormat();
    case 'ogg':
    case 'opus':
      return new OggOutputFormat();
    case 'flac':
      return new FlacOutputFormat();
    case 'wav':
      return new WavOutputFormat();
    case 'aac':
      return new AdtsOutputFormat();
  }
}

export const VIDEO_LABEL: Record<string, string> = {
  avc: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
};

export const AUDIO_LABEL: Record<string, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  'pcm-s16': 'PCM 16-bit',
  'pcm-s24': 'PCM 24-bit',
  'pcm-f32': 'PCM 32-bit float',
};

/** The video codecs worth offering, best first. */
const VIDEO_ORDER: VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1', 'vp8'];
const AUDIO_ORDER: AudioCodec[] = [
  'aac',
  'opus',
  'mp3',
  'vorbis',
  'flac',
  'pcm-s16',
  'pcm-s24',
  'pcm-f32',
];

/** What `container` can hold, in our order (before asking the browser). */
export function videoCodecsOf(id: ContainerId): VideoCodec[] {
  if (!containerOf(id).video) return [];
  const ok = makeFormat(id).getSupportedVideoCodecs();
  return VIDEO_ORDER.filter((c) => ok.includes(c));
}

export function audioCodecsOf(id: ContainerId): AudioCodec[] {
  const ok = makeFormat(id).getSupportedAudioCodecs();
  // Ogg holds both; ".opus" is Opus alone.
  const own = id === 'opus' ? ['opus'] : id === 'ogg' ? ['vorbis', 'opus', 'flac'] : null;
  return AUDIO_ORDER.filter((c) => ok.includes(c) && (!own || own.includes(c)));
}

/** Quantizer ("RF", like HandBrake's) range and a sensible middle, per codec. */
export const RF: Record<string, { min: number; max: number; def: number }> = {
  avc: { min: 10, max: 51, def: 23 },
  hevc: { min: 10, max: 51, def: 28 },
  vp8: { min: 4, max: 63, def: 30 },
  vp9: { min: 10, max: 63, def: 34 },
  av1: { min: 10, max: 63, def: 34 },
};

const WASM_AUDIO: Partial<Record<AudioCodec, () => Promise<void>>> = {
  mp3: () => import('@mediabunny/mp3-encoder').then((m) => m.registerMp3Encoder()),
  aac: () => import('@mediabunny/aac-encoder').then((m) => m.registerAacEncoder()),
  flac: () => import('@mediabunny/flac-encoder').then((m) => m.registerFlacEncoder()),
};
const registered = new Set<AudioCodec>();

/** Loads the WebAssembly encoder for `codec` when the browser has none of its own. */
export async function ensureAudioEncoder(codec: AudioCodec): Promise<boolean> {
  if (registered.has(codec)) return true;
  const native = await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48_000 }).catch(
    () => false,
  );
  if (native) return true;
  const load = WASM_AUDIO[codec];
  if (!load) return false;
  await load();
  registered.add(codec);
  return true;
}

/** Audio codecs this browser can write: its own, plus the WebAssembly ones (not loaded yet). */
export async function encodableAudio(codecs: AudioCodec[]): Promise<AudioCodec[]> {
  const out: AudioCodec[] = [];
  for (const c of codecs) {
    if (c.startsWith('pcm-') || WASM_AUDIO[c] || registered.has(c)) out.push(c);
    else if (
      await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48_000 }).catch(() => false)
    )
      out.push(c);
  }
  return out;
}

const videoCache = new Map<string, Promise<boolean>>();
/** Video codecs this browser can write at about this size. */
export async function encodableVideo(
  codecs: VideoCodec[],
  width = 1920,
  height = 1080,
): Promise<VideoCodec[]> {
  if (!('VideoEncoder' in globalThis)) return [];
  const out: VideoCodec[] = [];
  for (const c of codecs) {
    const key = `${c}:${width}x${height}`;
    let ok = videoCache.get(key);
    if (!ok) {
      ok = canEncodeVideo(c, { width, height }).catch(() => false);
      videoCache.set(key, ok);
    }
    if (await ok) out.push(c);
  }
  return out;
}

export type RateMode = 'quality' | 'bitrate' | 'size';
export type HwPreference = 'no-preference' | 'prefer-hardware' | 'prefer-software';

export interface VideoSettings {
  /** 'copy' keeps the packets as they are (the compressor, when nothing else changes). */
  codec: VideoCodec | 'copy';
  rate: RateMode;
  /** Quantizer, in the codec's RF range. */
  rf: number;
  /** kbit/s. */
  bitrate: number;
  /** Target size of the whole file, MB (2^20 bytes). */
  sizeMb: number;
  /** Short side in pixels; 0 = as it is. Never made bigger. */
  height: number;
  /** 0 = as it is. */
  fps: number;
  /** Seconds between key frames. */
  keyframe: number;
  hw: HwPreference;
}

export interface AudioSettings {
  codec: AudioCodec | 'copy' | 'none';
  /** kbit/s, for lossy codecs. */
  bitrate: number;
  /** 0 = as it is. */
  sampleRate: number;
  /** 0 = as it is. */
  channels: number;
}

export interface EncodeSettings {
  container: ContainerId;
  video: VideoSettings;
  audio: AudioSettings;
}

export const DEFAULT_SETTINGS: EncodeSettings = {
  container: 'mp4',
  video: {
    codec: 'avc',
    rate: 'quality',
    rf: 23,
    bitrate: 4000,
    sizeMb: 25,
    height: 1080,
    fps: 0,
    keyframe: 2,
    hw: 'no-preference',
  },
  audio: { codec: 'aac', bitrate: 160, sampleRate: 0, channels: 0 },
};

/** Output size for a source of w×h: the short side at most `height`, even numbers. */
export function scaledSize(w: number, h: number, height: number): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (!w || !h) return { w: 0, h: 0 };
  const k = height ? Math.min(1, height / Math.min(w, h)) : 1;
  return { w: even(w * k), h: even(h * k) };
}

/** Bits per pixel per frame that an RF gives about, for the fallback bitrate. */
function bitsPerPixel(codec: VideoCodec, rf: number): number {
  const r = RF[codec] ?? RF.avc!;
  // Each 6 steps of RF about halve the size; newer codecs need less for the same picture.
  const base = codec === 'avc' ? 0.1 : codec === 'vp8' ? 0.11 : 0.065;
  return base * 2 ** ((r.def - rf) / 6);
}

/** The video bitrate (bit/s) that makes the file about `sizeMb` with this audio. */
export function bitrateForSize(sizeMb: number, seconds: number, audioKbps: number): number {
  const bits = sizeMb * 2 ** 20 * 8 * 0.95; // a little room for the container
  return Math.max(80_000, Math.round(bits / Math.max(0.5, seconds) - audioKbps * 1000));
}

/** mediabunny's quality for these settings. */
export function videoQuality(
  v: VideoSettings,
  codec: VideoCodec,
  frame: { w: number; h: number; fps: number; seconds: number; audioKbps: number },
): Quality {
  if (v.rate === 'bitrate') return new Quality({ bitrate: v.bitrate * 1000 });
  if (v.rate === 'size')
    return new Quality({
      bitrate: bitrateForSize(v.sizeMb, frame.seconds, frame.audioKbps),
      bitrateMode: 'constant',
    });
  // Constant quality where the encoder can; else a bitrate of about the same.
  const fallback = Math.round(frame.w * frame.h * (frame.fps || 30) * bitsPerPixel(codec, v.rf));
  return new Quality({ quantizer: v.rf, bitrate: Math.max(150_000, fallback) });
}

export const audioQuality = (a: AudioSettings) => new Quality({ bitrate: a.bitrate * 1000 });

/** Lossless and PCM codecs have no bitrate to choose. */
export const audioHasBitrate = (codec: string) => !codec.startsWith('pcm-') && codec !== 'flac';

/** About how big the result is (bytes), for the size estimate; null when it can't be told. */
export function estimateBytes(
  s: EncodeSettings,
  src: { w: number; h: number; fps: number; seconds: number; bytes: number },
): number | null {
  const audio =
    s.audio.codec === 'none'
      ? 0
      : s.audio.codec === 'copy' || !audioHasBitrate(s.audio.codec)
        ? null
        : s.audio.bitrate * 125 * src.seconds;
  if (!containerOf(s.container).video || !src.w) return audio;
  if (s.video.codec === 'copy') return null;
  const size = scaledSize(src.w, src.h, s.video.height);
  const fps = s.video.fps || src.fps || 30;
  const bps =
    s.video.rate === 'bitrate'
      ? s.video.bitrate * 1000
      : s.video.rate === 'size'
        ? bitrateForSize(s.video.sizeMb, src.seconds, audio == null ? 128 : s.audio.bitrate)
        : size.w * size.h * fps * bitsPerPixel(s.video.codec, s.video.rf);
  return Math.round((bps / 8) * src.seconds + (audio ?? 0));
}
