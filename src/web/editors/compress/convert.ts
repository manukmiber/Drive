// The local compressor's engine (ADR-067): one video or audio file in, one smaller file out, with
// mediabunny (WebCodecs, plus the WebAssembly audio encoders). Drive files are read in ranges from
// the preview address, so a big file never has to fit in memory; files from this device are read
// straight from disk. No DOM here, so copying (remuxing) is tested in Node.
import {
  ALL_FORMATS,
  BufferTarget,
  Conversion,
  Input,
  Output,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type Rotation,
  type Source as MediaSource,
  type VideoCodec,
} from 'mediabunny';
import {
  audioHasBitrate,
  audioQuality,
  containerOf,
  ensureAudioEncoder,
  makeFormat,
  scaledSize,
  videoQuality,
  type EncodeSettings,
} from '../codecs/media';

export type CompressErrorCode = 'UNREADABLE' | 'CANNOT_ENCODE' | 'NO_TRACKS' | 'CANCELED';

export class CompressError extends Error {
  constructor(
    readonly code: CompressErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export interface MediaInfo {
  duration: number;
  /** Shown size, rotation applied; 0 without a picture. */
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  channels: number;
  sampleRate: number;
}

export async function probeMedia(source: MediaSource): Promise<MediaInfo> {
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new CompressError('UNREADABLE');
    let fps = 0;
    if (video) {
      const stats = await video.computePacketStats(120);
      fps = Math.round(stats.averagePacketRate * 100) / 100;
    }
    return {
      duration: await input.computeDuration(),
      width: video ? await video.getDisplayWidth() : 0,
      height: video ? await video.getDisplayHeight() : 0,
      fps,
      videoCodec: video ? await video.getCodec() : null,
      audioCodec: audio ? await audio.getCodec() : null,
      channels: audio ? await audio.getNumberOfChannels() : 0,
      sampleRate: audio ? await audio.getSampleRate() : 0,
    };
  } catch (e) {
    if (e instanceof CompressError) throw e;
    throw new CompressError('UNREADABLE', String(e));
  } finally {
    input.dispose();
  }
}

export interface CompressJob {
  settings: EncodeSettings;
  /** Seconds in the source; null for all of it. */
  trim?: { start: number; end: number } | null;
  /** Clockwise, on top of the file's own. */
  rotate?: Rotation;
  flip?: boolean;
}

export interface Compressed {
  blob: Blob;
  ext: string;
  mime: string;
}

/** The output's width and height for a source shown at w×h, turned by `rotate`. */
export function outputFrame(w: number, h: number, height: number, rotate: Rotation = 0) {
  const turned = rotate % 180 ? { w: h, h: w } : { w, h };
  return scaledSize(turned.w, turned.h, height);
}

export async function compressMedia(
  source: MediaSource,
  info: MediaInfo,
  job: CompressJob,
  opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<Compressed> {
  const { settings: s } = job;
  const container = containerOf(s.container);
  const input = new Input({ source, formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: makeFormat(s.container), target });
  try {
    const span = job.trim
      ? Math.max(0.1, Math.min(info.duration, job.trim.end) - job.trim.start)
      : info.duration;

    let video: ConversionVideoOptions;
    if (!container.video) video = { discard: true };
    else if (s.video.codec === 'copy') video = { rotate: job.rotate ?? 0, flip: job.flip };
    else {
      const codec: VideoCodec = s.video.codec;
      const size = outputFrame(info.width, info.height, s.video.height, job.rotate);
      video = {
        codec,
        width: size.w || undefined,
        height: size.h || undefined,
        fit: 'contain',
        rotate: job.rotate ?? 0,
        flip: job.flip,
        frameRate: s.video.fps || undefined,
        keyFrameInterval: s.video.keyframe,
        hardwareAcceleration: s.video.hw,
        quality: videoQuality(s.video, codec, {
          w: size.w,
          h: size.h,
          fps: s.video.fps || info.fps,
          seconds: span,
          audioKbps: s.audio.codec === 'none' ? 0 : s.audio.bitrate,
        }),
        forceTranscode: true,
      };
    }

    let audio: ConversionAudioOptions;
    if (s.audio.codec === 'none') audio = { discard: true };
    else if (s.audio.codec === 'copy') audio = {};
    else {
      const codec = s.audio.codec;
      if (!(await ensureAudioEncoder(codec))) throw new CompressError('CANNOT_ENCODE');
      // Opus only runs at 48 kHz.
      const sampleRate = codec === 'opus' ? 48_000 : s.audio.sampleRate || undefined;
      audio = {
        codec,
        sampleRate,
        numberOfChannels: s.audio.channels || undefined,
        quality: audioHasBitrate(codec) ? audioQuality(s.audio) : undefined,
        forceTranscode: true,
      };
    }

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video,
      audio,
      trim: job.trim ? { start: job.trim.start, end: job.trim.end } : undefined,
      showWarnings: false,
    });
    const used = conversion.utilizedTracks.length;
    if (!conversion.isValid || !used) {
      const cannot = conversion.discardedTracks.some(
        (d) => d.reason === 'no_encodable_target_codec' || d.reason === 'undecodable_source_codec',
      );
      throw new CompressError(cannot ? 'CANNOT_ENCODE' : 'NO_TRACKS');
    }
    conversion.onProgress = (p) => opts.onProgress?.(p);
    const abort = () => void conversion.cancel();
    opts.signal?.addEventListener('abort', abort);
    try {
      await conversion.execute();
    } finally {
      opts.signal?.removeEventListener('abort', abort);
    }
    if (opts.signal?.aborted) throw new CompressError('CANCELED');
    const mime = (await output.getMimeType()).split(';')[0]!;
    return {
      blob: new Blob([target.buffer!], { type: mime }),
      ext: container.ext,
      mime,
    };
  } catch (e) {
    if (opts.signal?.aborted) throw new CompressError('CANCELED');
    if (e instanceof CompressError) throw e;
    throw new CompressError('CANNOT_ENCODE', String(e));
  } finally {
    input.dispose();
  }
}
