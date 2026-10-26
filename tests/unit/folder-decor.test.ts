import { describe, expect, it } from 'vitest';
import { FOLDER_ICONS, isFolderIcon, isOneEmoji } from '../../src/shared/folder-decor';
import { folderBadge } from '../../src/worker/lib/folder-icons';

describe('folder decoration rules (ADR-058)', () => {
  it('takes exactly one emoji, flags and joined emoji included', () => {
    for (const ok of ['📚', '🏖️', '👨‍👩‍👧', '🇮🇩', '❤️']) expect(isOneEmoji(ok), ok).toBe(true);
    for (const bad of ['', 'a', '😀😀', 'ab', '1', '📚 ', '<b>'])
      expect(isOneEmoji(bad), bad).toBe(false);
    expect(isFolderIcon('camera')).toBe(true);
    expect(isFolderIcon('skull')).toBe(false);
  });

  it('draws every icon on the list as SVG paths for the share page', () => {
    for (const name of FOLDER_ICONS) {
      const html = folderBadge('teal', name);
      expect(html, name).toMatch(
        /^<span class="decor" style="--dl:#[0-9a-f]{6};--dd:#[0-9a-f]{6}"><svg [^>]+>(<(path|circle|rect|line|polyline|polygon|ellipse) [^>]+\/>)+<\/svg><\/span>$/,
      );
    }
    expect(folderBadge(null, null)).toBe('');
    expect(folderBadge('nope', '<script>')).toContain('<svg'); // unknown parts fall back, nothing raw
    expect(folderBadge(null, '🎒')).toBe(
      '<span class="decor"><span aria-hidden="true">🎒</span></span>',
    );
  });
});
