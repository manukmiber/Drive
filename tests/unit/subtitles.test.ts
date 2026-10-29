import { describe, expect, it } from 'vitest';
import {
  decodeSubtitle,
  srtToVtt,
  subtitleLabel,
  subtitleMatch,
  toVtt,
} from '../../src/web/lib/subtitles';

const enc = (s: string) => new TextEncoder().encode(s);

describe('SRT → WebVTT (D13)', () => {
  it('converts times, keeps cue text and drops the numbers', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:04,500\r\nHalo\r\nsemua\r\n\r\n2\r\n00:01:02,03 --> 01:00:00,1\r\nDua\r\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.500\nHalo\nsemua\n\n00:01:02.030 --> 01:00:00.100\nDua\n',
    );
  });

  it('accepts minutes-only times, dots, extra spaces and the SRT box after the end time', () => {
    const srt = '7\n02:03,456-->  02:05.000   X1:10 X2:20 Y1:30 Y2:40\nA\n';
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n00:02:03.456 --> 00:02:05.000\nA\n');
  });

  it('skips broken blocks instead of failing the file', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:00,500\nend before start\n\nnot a cue\n\n2\n00:61:00,000 --> 00:62:00,000\nbad minutes\n\n3\n00:00:05,000 --> 00:00:06,000\nok\n\n4\n00:00:07,000 --> 00:00:08,000\n\n';
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nok\n');
  });

  it('keeps b/i/u, drops font tags and ASS overrides, escapes & and <, and defuses -->', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#ff0">Tom & Jerry</font> <i>x</i> <B>y</B>\na < b --> c\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry <i>x</i> <B>y</B>\na &lt; b → c\n',
    );
  });

  it('an empty or cue-less file is still valid WebVTT', () => {
    expect(srtToVtt('')).toBe('WEBVTT\n\n');
    expect(srtToVtt('\uFEFFhello\n')).toBe('WEBVTT\n\n');
  });
});

describe('subtitle bytes', () => {
  it('honours UTF-8, UTF-16LE and UTF-16BE byte order marks', () => {
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Halo ✓')]))).toBe('Halo ✓');
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0xe9, 0x00]);
    expect(decodeSubtitle(le)).toBe('Hé');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0xe9]);
    expect(decodeSubtitle(be)).toBe('Hé');
  });

  it('reads UTF-8 without a BOM and falls back to Windows-1252', () => {
    expect(decodeSubtitle(enc('Café — ok'))).toBe('Café — ok');
    // "Café “x”" in Windows-1252: é = E9, curly quotes = 93/94.
    expect(decodeSubtitle(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x78, 0x94]))).toBe(
      'Café “x”',
    );
  });

  it('toVtt keeps a .vtt, adds a missing header, and converts SRT whatever the extension', () => {
    const vtt = 'WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n';
    expect(toVtt('a.vtt', enc(`\uFEFF${vtt}`))).toBe('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
    expect(toVtt('a.vtt', enc('00:01.000 --> 00:02.000\nHi\n'))).toBe(
      'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n',
    );
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n';
    expect(toVtt('a.vtt', enc(srt))).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
    expect(toVtt('a.srt', enc(srt))).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
  });
});

describe('which subtitles belong to a video', () => {
  it('ranks the same base name over a tagged one and ignores others', () => {
    expect(subtitleMatch('Film.mp4', 'film.SRT')).toBe(2);
    expect(subtitleMatch('Film.mp4', 'Film.id.srt')).toBe(1);
    expect(subtitleMatch('Film.mp4', 'Film 2.srt')).toBe(0);
    expect(subtitleMatch('Film.mp4', 'Film.txt')).toBe(0);
    expect(subtitleLabel('Film.mp4', 'Film.en.forced.vtt')).toBe('en.forced');
    expect(subtitleLabel('Film.mp4', 'Other.srt')).toBe('Other');
  });
});
