// The UI language (ADR-036): Indonesian or English, chosen once at start from the `zk_lang` cookie
// (shared with the rest of zeiko.biz.id, so the website and Drive agree), else this browser's
// language. Changing it sets the cookie and reloads, so every string — module-level ones too — is
// read in the new language.
import { setDateLocale } from '../../shared/format';
import { en } from '../../shared/strings.en';
import { t as id, type Strings } from '../../shared/strings.id';

export type Lang = 'id' | 'en';
export const LANG_COOKIE = 'zk_lang';

function detect(): Lang {
  const m = new RegExp(`(?:^|; )${LANG_COOKIE}=(id|en)(?:;|$)`).exec(document.cookie);
  if (m) return m[1] as Lang;
  const nav = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
  return nav.startsWith('id') || nav.startsWith('ms') ? 'id' : 'en';
}

export const lang: Lang = typeof document === 'undefined' ? 'id' : detect();
export const t: Strings = lang === 'en' ? en : id;
/** For dates and numbers. */
export const locale = lang === 'en' ? 'en-GB' : 'id-ID';

if (typeof document !== 'undefined') document.documentElement.lang = lang;
setDateLocale(locale);

/** Remember `next` for this whole site (a year), then redraw everything in it. */
export function setLang(next: Lang): void {
  document.cookie = `${LANG_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
  location.reload();
}
