// The language of a page the Worker draws itself (share links, payment pages; ADR-036): the
// `zk_lang` cookie zeiko.biz.id shares, else the browser's Accept-Language, else Indonesian.
import { en } from '../../shared/strings.en';
import { t as id, type Strings } from '../../shared/strings.id';

export type Lang = 'id' | 'en';

export function requestLang(req: Request): Lang {
  const cookie = /(?:^|;\s*)zk_lang=(id|en)(?:;|$)/.exec(req.headers.get('cookie') ?? '');
  if (cookie) return cookie[1] as Lang;
  const first =
    (req.headers.get('accept-language') ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('en')) return 'en';
  return 'id';
}

export function strings(lang: Lang): Strings {
  return lang === 'en' ? en : id;
}
