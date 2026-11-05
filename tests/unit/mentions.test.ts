// W4 (ADR-098): mentions as the box shows them and as the room keeps them, and links in messages.
import { describe, expect, it } from 'vitest';
import { fromWire, mentionQuery, parts, toWire } from '../../src/web/lib/mentions';

describe('Space message mentions and links (ADR-098)', () => {
  it('turns picked names into ids and back', () => {
    const picks = [
      { id: 'u1', label: 'Ana' },
      { id: 'u2', label: 'Ana Bell' },
    ];
    const wire = toWire('Halo @Ana Bell dan @Ana, cek ini.', picks);
    expect(wire).toBe('Halo <@u2> dan <@u1>, cek ini.');
    const names: Record<string, string> = { u1: 'Ana', u2: 'Ana Bell' };
    const back = fromWire(wire, (id) => names[id] ?? null);
    expect(back.text).toBe('Halo @Ana Bell dan @Ana, cek ini.');
    expect(toWire(back.text, back.picks)).toBe(wire);
  });

  it('leaves alone what was not picked, email addresses, and names inside words', () => {
    const picks = [{ id: 'u1', label: 'Ana' }];
    expect(toWire('tulis ke ana@Ana.id atau @Anak', picks)).toBe('tulis ke ana@Ana.id atau @Anak');
    expect(toWire('@Budi', picks)).toBe('@Budi');
    expect(fromWire('<@gone>', () => null).text).toBe('<@gone>');
  });

  it('knows when an @ is being typed', () => {
    expect(mentionQuery('halo @an')).toBe('an');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('email@an')).toBeNull();
    expect(mentionQuery('halo @ana ')).toBeNull();
  });

  it('finds web links and mentions, without the sentence’s punctuation', () => {
    expect(parts('lihat https://zeiko.biz.id/drive. <@u1> ya')).toEqual([
      { kind: 'text', text: 'lihat ' },
      { kind: 'link', href: 'https://zeiko.biz.id/drive', text: 'https://zeiko.biz.id/drive' },
      { kind: 'text', text: '. ' },
      { kind: 'mention', id: 'u1' },
      { kind: 'text', text: ' ya' },
    ]);
    expect(parts('(https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toMatchObject({
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
    expect(parts('javascript:alert(1) <b>x</b>')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) <b>x</b>' },
    ]);
  });
});
