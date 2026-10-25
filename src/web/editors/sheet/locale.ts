// FortuneSheet in the app's language (ADR-051). FortuneSheet has no Indonesian and picks its words
// from a table it doesn't let us add to, so the editor always asks for English and our words are put
// over that English once, before the first sheet is drawn. The language only changes with a reload.
import { locale } from '@fortune-sheet/core';
import { lang } from '../../lib/i18n';
import { FORMAT_NAMES_ID, FORTUNE_EN, FORTUNE_ID } from './fortune-id';

type Tree = Record<string, unknown>;

/** Puts `from`'s words over `into`'s, key by key (lists item by item); other keys are kept. */
export function overlay(into: Tree, from: Tree): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k];
    if (Array.isArray(v) && Array.isArray(cur))
      v.forEach((item, i) => {
        if (item && typeof item === 'object' && cur[i] && typeof cur[i] === 'object')
          overlay(cur[i] as Tree, item as Tree);
        else cur[i] = item;
      });
    else if (v && typeof v === 'object' && cur && typeof cur === 'object')
      overlay(cur as Tree, v as Tree);
    else into[k] = v;
  }
}

let done = false;

export function localizeFortuneSheet(): void {
  if (done) return;
  done = true;
  // locale() hands out FortuneSheet's own English table, the one its parts read from.
  const english = locale({ lang: 'en' } as Parameters<typeof locale>[0]) as unknown as Tree;
  overlay(english, (lang === 'id' ? FORTUNE_ID : FORTUNE_EN) as Tree);
  if (lang !== 'id') return;
  const formats = english.defaultFmt as (currency: string) => Array<{ text: string }>;
  english.defaultFmt = (currency: string) =>
    formats(currency).map((f) => ({ ...f, text: FORMAT_NAMES_ID[f.text] ?? f.text }));
}
