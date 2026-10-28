// The local compressor (ADR-067): what can be checked without WebCodecs (copying packets into
// another container, trimming, taking the sound out), the size maths, and JPEG XL recognition.
import { readFileSync } from 'node:fs';
import { BlobSource } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { previewContentType, previewKind } from '../../src/shared/preview';
import { jxlSignature } from '../../src/web/editors/codecs/signature';
import {
  DEFAULT_SETTINGS,
  audioCodecsOf,
  bitrateForSize,
  estimateBytes,
  scaledSize,
  videoCodecsOf,
  type EncodeSettings,
} from '../../src/web/editors/codecs/media';
import {
  CompressError,
  compressMedia,
  outputFrame,
  probeMedia,
} from '../../src/web/editors/compress/convert';
import { PRESETS } from '../../src/web/editors/compress/presets';
import { sniffMime } from '../../src/worker/lib/sniff';

const clip = (name: string) =>
  new Blob([readFileSync(new URL(`../fixtures/video/${name}`, import.meta.url))], {
    type: 'video/mp4',
  });
const a = clip('a.mp4');

const copy = (container: EncodeSettings['container']): EncodeSettings => ({
  container,
  video: { ...DEFAULT_SETTINGS.video, codec: 'copy' },
  audio: { ...DEFAULT_SETTINGS.audio, codec: 'copy' },
});

describe('local compressor, without re-encoding', () => {
  it('reads what the file is', async () => {
    const info = await probeMedia(new BlobSource(a));
    expect(info).toMatchObject({
      width: 160,
      height: 120,
      videoCodec: 'avc',
      audioCodec: 'aac',
    });
    expect(info.duration).toBeCloseTo(2, 1);
    expect(info.fps).toBeCloseTo(15, 0);
  });

  it('copies the packets into another container', async () => {
    const info = await probeMedia(new BlobSource(a));
    const progress: number[] = [];
    const out = await compressMedia(
      new BlobSource(a),
      info,
      { settings: copy('mov') },
      {
        onProgress: (p) => progress.push(p),
      },
    );
    expect(out.ext).toBe('mov');
    expect(out.mime).toBe('video/quicktime');
    const back = await probeMedia(new BlobSource(out.blob));
    expect(back).toMatchObject({ width: 160, height: 120, videoCodec: 'avc', audioCodec: 'aac' });
    expect(back.duration).toBeCloseTo(2, 1);
    expect(progress.at(-1)).toBe(1);

    // AAC with priming can't be copied into Matroska as it is (the browser re-encodes it; Node
    // has no audio decoder), so here the picture goes alone.
    const mkv = await compressMedia(new BlobSource(a), info, {
      settings: { ...copy('mkv'), audio: { ...DEFAULT_SETTINGS.audio, codec: 'none' } },
    });
    expect(mkv.mime).toBe('video/x-matroska');
    expect(await probeMedia(new BlobSource(mkv.blob))).toMatchObject({
      videoCodec: 'avc',
      audioCodec: null,
    });
  });

  it('trims, and takes the sound out on its own', async () => {
    const info = await probeMedia(new BlobSource(a));
    const cut = await compressMedia(new BlobSource(a), info, {
      settings: copy('mp4'),
      trim: { start: 1, end: 2 },
    });
    const back = await probeMedia(new BlobSource(cut.blob));
    expect(back.duration).toBeGreaterThan(0.8);
    expect(back.duration).toBeLessThan(1.3);

    const sound = await compressMedia(new BlobSource(a), info, { settings: copy('m4a') });
    expect(sound.ext).toBe('m4a');
    const s = await probeMedia(new BlobSource(sound.blob));
    expect(s).toMatchObject({ width: 0, videoCodec: null, audioCodec: 'aac' });
  });

  it('says so when nothing is left to write', async () => {
    const info = await probeMedia(new BlobSource(clip('d-silent.mp4')));
    const settings = { ...copy('m4a') };
    await expect(
      compressMedia(new BlobSource(clip('d-silent.mp4')), info, { settings }),
    ).rejects.toBeInstanceOf(CompressError);
  });
});

describe('compressor sizes', () => {
  it('scales the short side down, never up, to even numbers', () => {
    expect(scaledSize(1920, 1080, 720)).toEqual({ w: 1280, h: 720 });
    expect(scaledSize(1080, 1920, 720)).toEqual({ w: 720, h: 1280 });
    expect(scaledSize(640, 360, 1080)).toEqual({ w: 640, h: 360 });
    expect(scaledSize(1001, 563, 0)).toEqual({ w: 1002, h: 564 });
    expect(outputFrame(1920, 1080, 720, 90)).toEqual({ w: 720, h: 1280 });
  });

  it('a target size gives a bitrate that fits, sound included', () => {
    const bps = bitrateForSize(10, 60, 96);
    const bytes = ((bps + 96_000) * 60) / 8;
    expect(bytes).toBeLessThan(10 * 2 ** 20);
    expect(bytes).toBeGreaterThan(9 * 2 ** 20);
    const est = estimateBytes(PRESETS.send10, { w: 1920, h: 1080, fps: 30, seconds: 60, bytes: 0 });
    expect(est).toBeLessThan(10 * 2 ** 20);
    expect(est).toBeGreaterThan(9 * 2 ** 20);
  });

  it('a lower RF is a bigger estimate; copying has none', () => {
    const src = { w: 1920, h: 1080, fps: 30, seconds: 10, bytes: 0 };
    const at = (rf: number) =>
      estimateBytes({ ...PRESETS.fast1080, video: { ...PRESETS.fast1080.video, rf } }, src)!;
    expect(at(18)).toBeGreaterThan(at(24));
    expect(estimateBytes(copy('mp4'), src)).toBeNull();
  });

  it('offers only codecs the container holds', () => {
    expect(videoCodecsOf('webm')).toEqual(['vp9', 'av1', 'vp8']);
    expect(videoCodecsOf('mp4')).toContain('hevc');
    expect(videoCodecsOf('mp3')).toEqual([]);
    expect(audioCodecsOf('opus')).toEqual(['opus']);
    expect(audioCodecsOf('mp3')).toEqual(['mp3']);
    expect(audioCodecsOf('webm')).not.toContain('aac');
    for (const p of Object.values(PRESETS)) {
      if (p.container !== 'mp3' && p.container !== 'm4a')
        expect(videoCodecsOf(p.container)).toContain(p.video.codec);
      expect(audioCodecsOf(p.container)).toContain(p.audio.codec);
    }
  });
});

describe('JPEG XL', () => {
  const box = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
  it('is recognised by its bytes, bare or boxed', () => {
    expect(jxlSignature(new Uint8Array([0xff, 0x0a, 1, 2]))).toBe(true);
    expect(jxlSignature(new Uint8Array(box))).toBe(true);
    expect(jxlSignature(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    expect(sniffMime(new Uint8Array(box))).toBe('image/jxl');
    expect(sniffMime(new Uint8Array([0xff, 0x0a, 0, 0]))).toBe('image/jxl');
    // JPEG still wins its own bytes.
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('is previewed as a picture, with or without a type', () => {
    expect(previewKind('image/jxl', 'a.jxl', 10, 100)).toBe('image');
    expect(previewKind(null, 'a.jxl', 10, 100)).toBe('image');
    expect(previewKind('application/octet-stream', 'a.JXL', 10, 100)).toBe('image');
    expect(previewContentType('image', null)).toBe('image/jxl');
    expect(previewContentType('image', 'image/png')).toBe('image/png');
    expect(previewKind(null, 'a.bin', 10, 100)).toBeNull();
  });
});
