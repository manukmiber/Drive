// D8 (ADR-091): capture time, size and length from the first bytes of photos and videos, with
// fixtures built byte by byte (orientation, no EXIF, offsets, HEIC items, MOV at the end).
import { describe, expect, it } from 'vitest';
import { exifDate, headMeta, mp4Meta, readTiff } from '../../src/worker/lib/media-meta';
import { box, cat, enc, jpeg, tiff, u16be, u32be } from '../helpers/media';

describe('media metadata', () => {
  it('reads a JPEG: time with its offset, orientation turning the size, GPS never followed', () => {
    const m = headMeta(
      jpeg(tiff({ orientation: 6, date: '2024:05:01 13:45:10', offset: '+02:00' }), 4000, 3000),
    );
    expect(m.meta).toEqual({
      takenAt: Date.UTC(2024, 4, 1, 11, 45, 10),
      width: 3000,
      height: 4000,
      durationMs: 0,
    });
  });

  it('takes WIB when the camera gives no offset, and nothing from a photo without EXIF', () => {
    expect(headMeta(jpeg(tiff({ date: '2023:12:31 23:00:00' }), 10, 20)).meta?.takenAt).toBe(
      Date.UTC(2023, 11, 31, 16),
    );
    expect(headMeta(jpeg(null, 640, 480)).meta).toEqual({
      takenAt: null,
      width: 640,
      height: 480,
      durationMs: 0,
    });
    expect(exifDate('0000:00:00 00:00:00', null)).toBeNull();
    expect(exifDate('1970:01:01 00:00:00', null)).toBeNull();
  });

  it('reads PNG eXIf and WebP EXIF', () => {
    const t = tiff({ orientation: 8, date: '2022:02:02 02:02:02', offset: '-05:00' });
    const ihdr = cat(
      u32be(13),
      enc('IHDR'),
      u32be(300),
      u32be(200),
      new Array(5).fill(0),
      u32be(0),
    );
    const exif = cat(u32be(t.length), enc('eXIf'), t, u32be(0));
    const png = cat([0x89], enc('PNG\r\n\x1a\n'), ihdr, exif);
    expect(headMeta(png).meta).toEqual({
      takenAt: Date.UTC(2022, 1, 2, 7, 2, 2),
      width: 200,
      height: 300,
      durationMs: 0,
    });
    const vp8x = cat(enc('VP8X'), [10, 0, 0, 0], [0x08, 0, 0, 0], [0xff, 0x03, 0], [0xff, 0x01, 0]);
    const exifChunk = cat(
      enc('EXIF'),
      [t.length & 255, t.length >> 8, 0, 0],
      t,
      t.length & 1 ? [0] : [],
    );
    const body = cat(enc('WEBP'), vp8x, exifChunk);
    const webp = cat(enc('RIFF'), [body.length & 255, (body.length >> 8) & 255, 0, 0], body);
    expect(headMeta(webp).meta).toEqual({
      takenAt: Date.UTC(2022, 1, 2, 7, 2, 2),
      width: 512,
      height: 1024,
      durationMs: 0,
    });
  });

  it('finds the Exif item of a HEIC, in the head or past it', () => {
    const t = tiff({ date: '2021:07:04 10:00:00', offset: '+07:00' });
    const exifItem = cat(u32be(0), t);
    const ftyp = box('ftyp', enc('heic'), u32be(0), enc('mif1heic'));
    const infe = box('infe', [2, 0, 0, 0], u16be(2), u16be(0), enc('Exif'), [0]);
    const iinf = box('iinf', [0, 0, 0, 0], u16be(1), infe);
    const ispe = box('ispe', [0, 0, 0, 0], u32be(4032), u32be(3024));
    const irot = box('irot', [1]);
    const iprp = box('iprp', box('ipco', ispe, irot));
    const make = (exifOffset: number) =>
      box(
        'meta',
        [0, 0, 0, 0],
        iinf,
        iprp,
        box(
          'iloc',
          [0, 0, 0, 0],
          [0x44, 0x00],
          u16be(1),
          u16be(2),
          u16be(0),
          u16be(1),
          u32be(exifOffset),
          u32be(exifItem.length),
        ),
      );
    const probe = make(0);
    const at = ftyp.length + probe.length;
    const file = cat(ftyp, make(at), exifItem);
    expect(headMeta(file).meta).toEqual({
      takenAt: Date.UTC(2021, 6, 4, 3),
      width: 3024,
      height: 4032,
      durationMs: 0,
    });
    const far = headMeta(cat(ftyp, make(5_000_000)));
    expect(far.more).toEqual({ offset: 5_000_000, length: exifItem.length });
  });

  it('reads a video: length and time from mvhd, a portrait size from tkhd, or asks for the tail', () => {
    const created = (Date.UTC(2025, 0, 2, 3, 4, 5) / 1000 + 2_082_844_800) >>> 0;
    const mvhd = box(
      'mvhd',
      [0, 0, 0, 0],
      u32be(created),
      u32be(created),
      u32be(1000),
      u32be(12_345),
      new Array(80).fill(0),
    );
    const matrix = cat(
      u32be(0),
      u32be(0x10000),
      u32be(0),
      u32be(0xffff0000),
      u32be(0),
      u32be(0),
      u32be(0),
      u32be(0),
      u32be(0x40000000),
    );
    const tkhd = box(
      'tkhd',
      [0, 0, 0, 7],
      u32be(0),
      u32be(0),
      u32be(1),
      u32be(0),
      u32be(12_345),
      new Array(8).fill(0),
      new Array(8).fill(0),
      matrix,
      u32be(1920 << 16),
      u32be(1080 << 16),
    );
    const mp4 = cat(box('ftyp', enc('isom'), u32be(0)), box('moov', mvhd, box('trak', tkhd)));
    expect(headMeta(mp4).meta).toEqual({
      takenAt: Date.UTC(2025, 0, 2, 3, 4, 5),
      width: 1080,
      height: 1920,
      durationMs: 12_345,
    });
    const atEnd = cat(box('ftyp', enc('qt  '), u32be(0)), box('mdat', new Array(64).fill(0)));
    expect(headMeta(atEnd)).toEqual({ meta: null, tail: true });
    expect(mp4Meta(new Uint8Array(10))).toBeNull();
  });

  it('never throws on junk', () => {
    for (const junk of [
      new Uint8Array(0),
      new Uint8Array([0xff, 0xd8]),
      enc('RIFF....WEBPVP8X'),
      enc('xxxxftypheic'),
      new Uint8Array(4096).fill(0xff),
    ])
      expect(() => headMeta(junk)).not.toThrow();
    expect(readTiff(enc('II*\0\xff\xff\xff\xff'))).toMatchObject({ takenAt: null });
  });
});
