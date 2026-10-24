// Policy pages (SPEC §14.5): Terms of Service and Privacy Policy as the owner wrote them (2026-10-25,
// ADR-045) and the Ad Policy, each in Indonesian and English. Bodies are a small Markdown subset
// (components/Markdown.tsx). The content policy is the Terms' Section 3, so its old address shows
// the Terms.
import * as iklanEn from './iklan.en';
import * as iklanId from './iklan.id';
import * as privasiEn from './privasi.en';
import * as privasiId from './privasi.id';
import * as syaratEn from './syarat.en';
import * as syaratId from './syarat.id';

export interface LegalDoc {
  title: string;
  body: string;
}

export interface LegalEntry {
  /** Date it takes effect, YYYY-MM-DD. */
  effective: string;
  id: LegalDoc;
  en: LegalDoc;
}

export const LEGAL = {
  syarat: { effective: '2026-10-25', id: syaratId, en: syaratEn },
  privasi: { effective: '2026-10-25', id: privasiId, en: privasiEn },
  'kebijakan-iklan': { effective: '2026-10-24', id: iklanId, en: iklanEn },
} satisfies Record<string, LegalEntry>;

export type LegalSlug = keyof typeof LEGAL;

/** Older addresses that now show another page. */
const ALIASES: Record<string, LegalSlug> = { 'kebijakan-konten': 'syarat' };

export function legalEntry(slug: string): LegalEntry | null {
  const key = (slug in LEGAL ? slug : ALIASES[slug]) as LegalSlug | undefined;
  return key ? LEGAL[key] : null;
}
