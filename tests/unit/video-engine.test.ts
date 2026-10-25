// The fast (packet copy) path of the video editor (ADR-050). Fixtures: 15 fps H.264 with a key frame
// every second and B-frames; a.mp4/b.mp4 2 s with AAC, c 192×108, d = a's first second without sound.
import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { EditError, probe, render } from '../../src/web/editors/video/engine';
import type { Part } from '../../src/web/editors/video/timeline';

const clip = (name: string) =>
  new Blob([readFileSync(new URL(`../fixtures/video/${name}`, import.meta.url))], {
    type: 'video/mp4',
  });
const a = clip('a.mp4');
const b = clip('b.mp4');

async function packets(blob: Blob, kind: 'video' | 'audio') {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track =
    kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
  if (!track) return [];
  const out = [];
  for await (const p of new EncodedPacketSink(track).packets()) out.push(p);
  return out;
}

describe('video editor, fast path', () => {
  it('reads the clip', async () => {
    const info = await probe(a);
    expect(info.duration).toBeCloseTo(2, 1);
    expect(info).toMatchObject({ width: 160, height: 120, hasVideo: true, hasAudio: true });
  });

  it('cuts at the key frame before the start and joins parts in order', async () => {
    const progress: number[] = [];
    const out = await render(
      [
        { source: a, start: 0.5, end: 1.5 }, // key frame at 0 → 0–1.5
        { source: b, start: 0, end: 1 },
        { source: a, start: 1.5, end: 2 }, // key frame at 1 → 1–2
      ],
      { mode: 'fast', onProgress: (p) => progress.push(p) },
    );
    expect(out.ext).toBe('mp4');
    expect(out.mime).toBe('video/mp4');
    const info = await probe(out.blob);
    expect(info.duration).toBeGreaterThan(3.3);
    expect(info.duration).toBeLessThan(3.7);
    expect(info.hasAudio).toBe(true);

    const video = await packets(out.blob, 'video');
    // A part ends before the first frame at or after its end in decode order, so with B-frames
    // the last frame or two before the cut can go too.
    const keys = video.filter((p) => p.type === 'key').map((p) => p.timestamp);
    expect(keys).toHaveLength(4);
    [0, 1, 1.5, 2.5].forEach((want, i) => expect(Math.abs(keys[i]! - want)).toBeLessThan(0.15));
    expect(video.length).toBeGreaterThanOrEqual(50);
    expect(Math.min(...video.map((p) => p.timestamp))).toBeCloseTo(0, 3);

    const audio = await packets(out.blob, 'audio');
    for (let i = 1; i < audio.length; i++)
      expect(audio[i]!.timestamp).toBeGreaterThanOrEqual(audio[i - 1]!.timestamp);
    expect(progress.at(-1)).toBe(1);
  });

  it('refuses to copy videos stored differently, so the precise way is offered', async () => {
    await expect(
      render(
        [
          { source: a, start: 0, end: 1 },
          { source: clip('c-other-size.mp4'), start: 0, end: 1 },
        ],
        { mode: 'fast' },
      ),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE' });
  });

  it('joins a part without sound (silent there)', async () => {
    const out = await render(
      [
        { source: a, start: 0, end: 2 },
        { source: clip('d-silent.mp4'), start: 0, end: 1 },
      ],
      { mode: 'fast' },
    );
    const info = await probe(out.blob);
    expect(info.duration).toBeCloseTo(3, 0);
    expect(info.hasAudio).toBe(true);
  });

  it('stops when canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await render([{ source: a, start: 0, end: 2 }], {
      mode: 'fast',
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditError);
    expect((err as EditError).code).toBe('CANCELED');
  });
});

describe('video timeline', () => {
  it('splits, trims, moves and finds parts', async () => {
    const tl = await import('../../src/web/editors/video/timeline');
    let parts: Part[] = [
      { id: 'a', clip: 'x', start: 0, end: 10 },
      { id: 'b', clip: 'y', start: 2, end: 4 },
    ];
    expect(tl.total(parts)).toBe(12);
    expect(tl.locate(parts, 11)).toEqual({ index: 1, at: 3, offset: 10 });
    expect(tl.locate(parts, 99)).toEqual({ index: 1, at: 4, offset: 10 });
    parts = tl.split(parts, 4, 'c');
    expect(parts.map((p) => [p.id, p.start, p.end])).toEqual([
      ['a', 0, 4],
      ['c', 4, 10],
      ['b', 2, 4],
    ]);
    expect(tl.split(parts, 4.05, 'd')).toBe(parts); // too close to an edge
    parts = tl.move(parts, 'b', -1);
    expect(parts.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(tl.startOf(parts, 2)).toBe(6);
    parts = tl.trim(parts, 'c', 'start', 9.99);
    expect(parts[2]!.start).toBeCloseTo(9.9);
    parts = tl.remove(tl.remove(tl.remove(parts, 'a'), 'b'), 'c');
    expect(parts).toHaveLength(1); // the last part stays
    expect(tl.clock(75.25)).toBe('1:15.3');
  });
});
