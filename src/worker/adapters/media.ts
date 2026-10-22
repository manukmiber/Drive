// Media compression adapter (SPEC §11). `cloudflare` = Images binding (images ≤ 20 MB), Media
// Transformations (videos ≤ 60 s and < 100 MB) and Container `media` (everything else).
// `mock` = deterministic stand-in for dev/tests (no bindings on Node, ADR-001).

export type ImageFormat = 'avif' | 'webp' | 'jpeg';
export type Quality = 'hemat' | 'seimbang' | 'tinggi';
export type VideoPreset = '1080p' | '720p' | '480p';

export const QUALITY_VALUE: Record<Quality, number> = { hemat: 60, seimbang: 75, tinggi: 88 };
export const CRF: Record<Quality, number> = { hemat: 30, seimbang: 26, tinggi: 22 };
const PRESET_HEIGHT: Record<VideoPreset, number> = { '1080p': 1080, '720p': 720, '480p': 480 };

export interface MediaOutput {
  /** Fully buffered (binding outputs have no known length; R2 needs one). */
  bytes?: Uint8Array;
  /** Known-length stream (container responses) + hashes computed by the container. */
  stream?: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  sha256?: string;
  crc32?: number;
}

export interface MediaProcessor {
  readonly name: string;
  /** Container-backed paths are available (long videos, huge images). */
  readonly hasContainer: boolean;
  image(
    input: ReadableStream<Uint8Array>,
    o: {
      format: ImageFormat;
      quality: Quality;
      maxWidth?: number | undefined;
      viaContainer: boolean;
    },
  ): Promise<MediaOutput>;
  video(
    input: ReadableStream<Uint8Array>,
    o: { preset: VideoPreset; quality: Quality; viaContainer: boolean },
  ): Promise<MediaOutput>;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class CloudflareMediaProcessor implements MediaProcessor {
  readonly name = 'cloudflare';
  constructor(
    private images: ImagesBinding,
    private media: MediaBinding,
    private container?: DurableObjectNamespace,
  ) {}

  get hasContainer(): boolean {
    return Boolean(this.container);
  }

  private async viaContainer(
    path: string,
    input: ReadableStream<Uint8Array>,
    query: Record<string, string>,
  ): Promise<MediaOutput> {
    if (!this.container) throw new Error('media container not deployed');
    const stub = this.container.get(
      this.container.idFromName(`media-${Math.floor(Math.random() * 3)}`),
    );
    const res = await stub.fetch(`http://media/${path}?${new URLSearchParams(query)}`, {
      method: 'POST',
      body: input,
    });
    if (!res.ok || !res.body)
      throw new Error(`media container ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return {
      stream: res.body,
      size: Number(res.headers.get('content-length')),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      sha256: res.headers.get('x-sha256') ?? undefined,
      crc32: Number(res.headers.get('x-crc32')),
    };
  }

  async image(
    input: ReadableStream<Uint8Array>,
    o: {
      format: ImageFormat;
      quality: Quality;
      maxWidth?: number | undefined;
      viaContainer: boolean;
    },
  ): Promise<MediaOutput> {
    if (o.viaContainer) {
      return this.viaContainer('image', input, {
        format: o.format,
        quality: String(QUALITY_VALUE[o.quality]),
        width: String(o.maxWidth ?? 0),
      });
    }
    let t = this.images.input(input);
    if (o.maxWidth) t = t.transform({ width: o.maxWidth, fit: 'scale-down' });
    // Non-JPEG outputs drop all metadata; JPEG keeps only the copyright tag (GPS removed).
    const result = await t.output({
      format: `image/${o.format}`,
      quality: QUALITY_VALUE[o.quality],
    });
    const bytes = await readAll(result.image());
    return { bytes, size: bytes.length, contentType: result.contentType() };
  }

  async video(
    input: ReadableStream<Uint8Array>,
    o: { preset: VideoPreset; quality: Quality; viaContainer: boolean },
  ): Promise<MediaOutput> {
    if (o.viaContainer)
      return this.viaContainer('video', input, { preset: o.preset, crf: String(CRF[o.quality]) });
    const result = this.media
      .input(input)
      .transform({ height: PRESET_HEIGHT[o.preset], fit: 'scale-down' })
      .output({ mode: 'video' });
    const bytes = await readAll(await result.media());
    return { bytes, size: bytes.length, contentType: await result.contentType() };
  }
}

/**
 * Dev/test stand-in: "compresses" by keeping a fraction of the bytes (hemat 40 %, seimbang 60 %,
 * tinggi 80 %). Inputs containing the marker `ZK-NOSHRINK` come back larger, to exercise the
 * "result not smaller → keep original, refund" path. Long videos need `hasContainer`.
 */
export class MockMediaProcessor implements MediaProcessor {
  readonly name = 'mock';
  constructor(readonly hasContainer = true) {}

  private async fake(
    input: ReadableStream<Uint8Array>,
    quality: Quality,
    contentType: string,
  ): Promise<MediaOutput> {
    const src = await readAll(input);
    const marker = new TextDecoder('latin1').decode(src.subarray(0, 64)).includes('ZK-NOSHRINK');
    const ratio = { hemat: 0.4, seimbang: 0.6, tinggi: 0.8 }[quality];
    const bytes = marker
      ? new Uint8Array([...src, 0])
      : src.subarray(0, Math.max(1, Math.floor(src.length * ratio)));
    return { bytes: new Uint8Array(bytes), size: bytes.length, contentType };
  }

  image(
    input: ReadableStream<Uint8Array>,
    o: { format: ImageFormat; quality: Quality },
  ): Promise<MediaOutput> {
    return this.fake(input, o.quality, `image/${o.format}`);
  }

  video(
    input: ReadableStream<Uint8Array>,
    o: { quality: Quality; viaContainer: boolean },
  ): Promise<MediaOutput> {
    if (o.viaContainer && !this.hasContainer) throw new Error('media container not deployed');
    return this.fake(input, o.quality, 'video/mp4');
  }
}
