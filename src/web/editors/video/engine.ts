// Cut, split and merge video in the browser (ADR-050). Two ways to make the result:
// - fast: packets are copied as they are. Cuts start at the key frame at or before the chosen
//   time, and only videos stored the same way (codec, size, settings) can be joined;
// - precise: every part is re-encoded with WebCodecs to one size and format first, then joined
//   the fast way. Frame-exact, joins anything, but slower and only where the browser can encode.
// No DOM here (only Blob and mediabunny), so the fast path is tested in Node.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type Rotation,
  type VideoCodec,
} from 'mediabunny';

export interface ClipInfo {
  duration: number;
  /** As shown, rotation applied. */
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface RenderPart {
  source: Blob;
  /** Seconds in the source. */
  start: number;
  end: number;
}

export type RenderMode = 'fast' | 'precise';

export interface Rendered {
  blob: Blob;
  ext: string;
  mime: string;
}

export type EditErrorCode = 'UNREADABLE' | 'INCOMPATIBLE' | 'CANNOT_ENCODE' | 'CANCELED';

export class EditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

interface Opened {
  part: RenderPart;
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
}

async function open(part: RenderPart): Promise<Opened> {
  const input = new Input({ source: new BlobSource(part.source), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new EditError('UNREADABLE');
    return { part, input, video, audio };
  } catch (e) {
    input.dispose();
    if (e instanceof EditError) throw e;
    throw new EditError('UNREADABLE', String(e));
  }
}

export async function probe(source: Blob): Promise<ClipInfo> {
  const o = await open({ source, start: 0, end: Infinity });
  try {
    return {
      duration: await o.input.computeDuration(),
      width: o.video ? await o.video.getDisplayWidth() : 0,
      height: o.video ? await o.video.getDisplayHeight() : 0,
      hasVideo: Boolean(o.video),
      hasAudio: Boolean(o.audio),
    };
  } finally {
    o.input.dispose();
  }
}

function bytesOf(d: ArrayBufferLike | ArrayBufferView | undefined): Uint8Array {
  if (!d) return new Uint8Array();
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A key that is equal only when two tracks' packets can follow each other in one track. */
async function videoKey(t: InputVideoTrack) {
  const c = await t.getDecoderConfig();
  return {
    codec: c?.codec ?? '',
    width: c?.codedWidth ?? 0,
    height: c?.codedHeight ?? 0,
    rotation: await t.getRotation(),
    description: bytesOf(c?.description),
  };
}

async function audioKey(t: InputAudioTrack) {
  const c = await t.getDecoderConfig();
  return {
    codec: c?.codec ?? '',
    sampleRate: c?.sampleRate ?? 0,
    channels: c?.numberOfChannels ?? 0,
    description: bytesOf(c?.description),
  };
}

function formatFor(video: VideoCodec | null, audio: AudioCodec | null): OutputFormat | null {
  for (const f of [new Mp4OutputFormat(), new WebMOutputFormat()]) {
    if (video && !f.getSupportedVideoCodecs().includes(video)) continue;
    if (audio && !f.getSupportedAudioCodecs().includes(audio)) continue;
    return f;
  }
  return null;
}

function extFor(format: OutputFormat, hasVideo: boolean): string {
  if (format instanceof WebMOutputFormat) return hasVideo ? 'webm' : 'weba';
  return hasVideo ? 'mp4' : 'm4a';
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EditError('CANCELED');
}

/**
 * Joins the parts by copying their packets. Each part starts at the key frame at or before its
 * `start` (earlier frames can't be decoded) and stops before the first frame at or after its `end`.
 */
async function joinByCopying(
  parts: RenderPart[],
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Rendered> {
  const opened: Opened[] = [];
  try {
    for (const p of parts) opened.push(await open(p));
    const withVideo = opened.filter((o) => o.video);
    const withAudio = opened.filter((o) => o.audio);
    // Video can't come and go between parts; audio can (a part without sound is silent).
    if (withVideo.length && withVideo.length !== opened.length) throw new EditError('INCOMPATIBLE');
    const vRef = withVideo[0] ? await videoKey(withVideo[0].video!) : null;
    for (const o of withVideo.slice(1)) {
      const k = await videoKey(o.video!);
      if (
        k.codec !== vRef!.codec ||
        k.width !== vRef!.width ||
        k.height !== vRef!.height ||
        k.rotation !== vRef!.rotation ||
        !sameBytes(k.description, vRef!.description)
      )
        throw new EditError('INCOMPATIBLE');
    }
    const aRef = withAudio[0] ? await audioKey(withAudio[0].audio!) : null;
    for (const o of withAudio.slice(1)) {
      const k = await audioKey(o.audio!);
      if (
        k.codec !== aRef!.codec ||
        k.sampleRate !== aRef!.sampleRate ||
        k.channels !== aRef!.channels ||
        !sameBytes(k.description, aRef!.description)
      )
        throw new EditError('INCOMPATIBLE');
    }

    const vCodec = withVideo[0] ? await withVideo[0].video!.getCodec() : null;
    const aCodec = withAudio[0] ? await withAudio[0].audio!.getCodec() : null;
    if ((withVideo.length && !vCodec) || (withAudio.length && !aCodec))
      throw new EditError('UNREADABLE');
    const format = formatFor(vCodec, aCodec);
    if (!format) throw new EditError('INCOMPATIBLE');

    const target = new BufferTarget();
    const output = new Output({ format, target });
    const vOut = vCodec ? new EncodedVideoPacketSource(vCodec) : null;
    const aOut = aCodec ? new EncodedAudioPacketSource(aCodec) : null;
    if (vOut) output.addVideoTrack(vOut, { rotation: vRef!.rotation as Rotation });
    if (aOut) output.addAudioTrack(aOut);
    await output.start();

    const vConfig = withVideo[0] ? await withVideo[0].video!.getDecoderConfig() : null;
    const aConfig = withAudio[0] ? await withAudio[0].audio!.getDecoderConfig() : null;
    let vMeta = false;
    let aMeta = false;
    let cursor = 0;
    let audioEnd = 0;
    let seq = 0;
    const span = (p: RenderPart) => (Number.isFinite(p.end) ? Math.max(0, p.end - p.start) : 0);
    const total = parts.reduce((s, p) => s + span(p), 0) || 1;
    let done = 0;

    for (const o of opened) {
      const { start, end } = o.part;
      let from = start;
      let to = end;
      if (o.video) {
        const sink = new EncodedPacketSink(o.video);
        const key = (await sink.getKeyPacket(start)) ?? (await sink.getFirstKeyPacket());
        if (!key) throw new EditError('UNREADABLE');
        from = key.timestamp;
        to = from;
        for await (const pkt of sink.packets(key)) {
          checkAbort(signal);
          if (pkt.timestamp >= end) break;
          // Leading frames of an open GOP need the GOP before, which isn't there.
          if (pkt.timestamp < from) continue;
          await vOut!.add(
            pkt.clone({ timestamp: cursor + pkt.timestamp - from, sequenceNumber: seq++ }),
            vMeta ? undefined : { decoderConfig: vConfig! },
          );
          vMeta = true;
          to = Math.max(to, pkt.timestamp + pkt.duration);
          onProgress(Math.min(1, (done + Math.max(0, pkt.timestamp - start)) / total));
        }
      } else {
        to = Math.min(end, await o.input.computeDuration());
      }
      if (o.audio) {
        const sink = new EncodedPacketSink(o.audio);
        const first = (await sink.getPacket(from)) ?? (await sink.getFirstPacket());
        if (first) {
          for await (const pkt of sink.packets(first)) {
            checkAbort(signal);
            if (pkt.timestamp >= to) break;
            let ts = cursor + pkt.timestamp - from;
            // The packet straddling the cut would overlap the previous part: nudge it after.
            if (ts < audioEnd) {
              if (ts + pkt.duration <= audioEnd) continue;
              ts = audioEnd;
            }
            await aOut!.add(
              pkt.clone({ timestamp: ts, sequenceNumber: seq++ }),
              aMeta ? undefined : { decoderConfig: aConfig! },
            );
            aMeta = true;
            audioEnd = ts + pkt.duration;
            if (!o.video)
              onProgress(Math.min(1, (done + Math.max(0, pkt.timestamp - start)) / total));
          }
        }
      }
      cursor += Math.max(0, to - from);
      done += span(o.part);
    }
    if (!vMeta && !aMeta) throw new EditError('UNREADABLE');
    await output.finalize();
    onProgress(1);
    const mime = await output.getMimeType();
    return {
      blob: new Blob([target.buffer!], { type: mime.split(';')[0] }),
      ext: extFor(format, Boolean(vOut)),
      mime: mime.split(';')[0]!,
    };
  } finally {
    for (const o of opened) o.input.dispose();
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Can this browser re-encode (the precise way)? */
export async function canReencode(): Promise<boolean> {
  if (!('VideoEncoder' in globalThis)) return false;
  const f = new Mp4OutputFormat();
  return Boolean(
    await getFirstEncodableVideoCodec(f.getSupportedVideoCodecs(), { width: 1280, height: 720 }),
  );
}

async function reencodeAll(
  parts: RenderPart[],
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<RenderPart[]> {
  // The first part with a picture sets the size and frame rate; the others fit inside it.
  let width = 0;
  let height = 0;
  let fps = 30;
  for (const p of parts) {
    const o = await open(p);
    try {
      if (o.video) {
        width = even(await o.video.getDisplayWidth());
        height = even(await o.video.getDisplayHeight());
        const stats = await o.video.computePacketStats(100);
        if (stats.averagePacketRate > 0) fps = Math.min(60, Math.round(stats.averagePacketRate));
        break;
      }
    } finally {
      o.input.dispose();
    }
  }
  const format = new Mp4OutputFormat();
  const vCodec = width
    ? await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width, height })
    : null;
  if (width && !vCodec) throw new EditError('CANNOT_ENCODE');
  const aCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), {
    numberOfChannels: 2,
    sampleRate: 48_000,
  });

  const out: RenderPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    checkAbort(signal);
    const p = parts[i]!;
    const input = new Input({ source: new BlobSource(p.source), formats: ALL_FORMATS });
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    try {
      const conversion = await Conversion.init({
        input,
        output,
        trim: { start: p.start, end: p.end },
        copy: false,
        showWarnings: false,
        video: vCodec
          ? { width, height, fit: 'contain', frameRate: fps, codec: vCodec, bitrate: QUALITY_HIGH }
          : { discard: true },
        audio: aCodec
          ? { codec: aCodec, sampleRate: 48_000, numberOfChannels: 2, bitrate: QUALITY_HIGH }
          : { discard: true },
      });
      if (!conversion.isValid) throw new EditError('CANNOT_ENCODE');
      conversion.onProgress = (v) => onProgress((i + v) / parts.length);
      const abort = () => void conversion.cancel();
      signal?.addEventListener('abort', abort);
      try {
        await conversion.execute();
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      checkAbort(signal);
      out.push({ source: new Blob([target.buffer!]), start: 0, end: Infinity });
    } catch (e) {
      if (e instanceof EditError) throw e;
      checkAbort(signal);
      throw new EditError('CANNOT_ENCODE', String(e));
    } finally {
      input.dispose();
    }
  }
  return out;
}

/** Makes one file out of the parts, in order. */
export async function render(
  parts: RenderPart[],
  opts: { mode: RenderMode; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<Rendered> {
  if (!parts.length) throw new EditError('UNREADABLE');
  const report = opts.onProgress ?? (() => undefined);
  if (opts.mode === 'fast') return joinByCopying(parts, report, opts.signal);
  // Re-encoding is most of the work; joining the results is quick.
  const ready = await reencodeAll(parts, (p) => report(p * 0.95), opts.signal);
  return joinByCopying(ready, (p) => report(0.95 + p * 0.05), opts.signal);
}
