// Ad content policy (SPEC §10.8): shown on /kebijakan/iklan. Every ad is checked by a person (ADR-043);
// `bannedTopic` only flags words for that check and never decides.
export const AD_PLACEMENTS = ['explorer_sidebar', 'share_page'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export const AD_CTA_TYPES = [
  'web',
  'whatsapp',
  'instagram',
  'tiktok',
  'shopee',
  'tokopedia',
] as const;
export type AdCtaType = (typeof AD_CTA_TYPES)[number];

export const AD_CATEGORIES = [
  'kuliner',
  'fashion',
  'jasa',
  'pendidikan',
  'kesehatan_kecantikan',
  'elektronik',
  'rumah_tangga',
  'event',
  'lainnya',
] as const;
export type AdCategory = (typeof AD_CATEGORIES)[number];

export const AD_TITLE_MAX = 40;
export const AD_BODY_MAX = 90;

/** Prohibited topics → patterns (lowercased, diacritics stripped, leetspeak folded). */
export const AD_BANNED: Array<{ topic: string; patterns: RegExp[] }> = [
  {
    topic: 'judi/slot/togel',
    patterns: [
      /\bjudi\b/,
      /\bslot\s*(gacor|online|88)?\b/,
      /\btogel\b/,
      /\bcasino\b|\bkasino\b/,
      /\bgacor\b/,
      /\bmaxwin\b/,
      /\bscatter\b/,
      /\btaruhan\b/,
      /\bsabung\b/,
      /\bpoker\b/,
      /\bdomino\s*qq\b/,
    ],
  },
  {
    topic: 'pinjol ilegal',
    patterns: [
      /\bpinjol\b/,
      /pinjaman\s+(online|cepat|tanpa\s+(jaminan|bi\s*checking))/,
      /\bcair\s+(cepat|dalam)\b/,
    ],
  },
  {
    topic: 'investasi bodong',
    patterns: [
      /\brobot\s+trading\b/,
      /\bprofit\s+\d+\s*%/,
      /\bpasti\s+untung\b/,
      /\bpassive\s+income\b/,
      /\bbinary\s+option\b/,
      /\bdoubler\b/,
      /\bpenggandaan\s+uang\b/,
    ],
  },
  {
    topic: 'ponzi/MLM',
    patterns: [/\bponzi\b/, /\bmlm\b/, /\bmember\s+get\s+member\b/, /\barisan\s+online\b/],
  },
  {
    topic: 'kripto spekulatif',
    patterns: [/\b(pump|airdrop|presale)\b/, /\bkoin\s+baru\b/, /\b100x\b/],
  },
  {
    topic: 'obat keras/klaim kesehatan',
    patterns: [
      /\bobat\s+kuat\b/,
      /\bobat\s+(aborsi|penggugur)\b/,
      /\bcytotec\b/,
      /\btramadol\b/,
      /\bpeninggi\s+badan\b/,
      /\bsembuh\s+total\b/,
      /\bpelangsing\s+(instan|ekstrem)\b/,
    ],
  },
  {
    topic: 'rokok/vape/alkohol',
    patterns: [
      /\brokok\b/,
      /\bvape\b|\bvapor\b|\bliquid\s+vape\b|\bpod\s+vape\b/,
      /\bmiras\b/,
      /\bwhisk(e)?y\b/,
      /\bvodka\b/,
      /\bsoju\b/,
    ],
  },
  {
    topic: 'konten dewasa',
    patterns: [
      /\bbokep\b/,
      /\bopen\s*bo\b/,
      /\bvcs\b/,
      /\bpijat\s*\+\+/,
      /\bdewasa\s*18\b/,
      /\bsex\b|\bseks\b/,
      /\bporn/,
    ],
  },
  {
    topic: 'senjata',
    patterns: [/\bsenjata\s+api\b/, /\bsenpi\b/, /\bairsoft\s*gun\b/, /\bpeluru\s+tajam\b/],
  },
  {
    topic: 'barang palsu/bajakan',
    patterns: [
      /\bkw\s*(super|1|premium)\b/,
      /\bbajakan\b/,
      /\bcrack(ed)?\b/,
      /\bakun\s+premium\s+murah\b/,
    ],
  },
  {
    topic: 'joki tugas/ujian',
    patterns: [/\bjoki\b/, /\bjasa\s+(skripsi|tugas|ujian)\b/, /\bbocoran\s+soal\b/],
  },
  {
    topic: 'politik/SARA',
    patterns: [/\bpilih\s+(paslon|caleg|capres)\b/, /\bcoblos\b/, /\bkafir\b/],
  },
  {
    topic: 'penipuan/phishing',
    patterns: [
      /\bhadiah\s+(langsung|undian)\b/,
      /\bklaim\s+saldo\b/,
      /\bverifikasi\s+akun\b/,
      /\bmenang\s+undian\b/,
    ],
  },
];

export function normalizeAdText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z0-9%+\s]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** First prohibited topic found, or null. Digits are folded, so "s1ot" matches "slot". */
export function bannedTopic(...texts: string[]): string | null {
  const raw = texts.join(' ');
  // Check both the folded text (leetspeak) and the plain lowercase text (numbers like "100x", "88").
  const variants = [normalizeAdText(raw), raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')];
  for (const rule of AD_BANNED) {
    if (rule.patterns.some((p) => variants.some((v) => p.test(v)))) return rule.topic;
  }
  return null;
}

/** The prices `adCampaignPricePerDay` reads (app config, ADR-043). */
export interface AdPrices {
  ad_price_city_idr: number;
  ad_price_bundle_idr: number;
  ad_bundle_cities: number;
  ad_price_national_idr: number;
}

/**
 * What one day of a campaign costs (ADR-043). National is its own price. Cities: every full bundle
 * of `ad_bundle_cities` costs the bundle price, the rest cost a city each but never more than a
 * bundle, and no set of cities costs more than national. With the defaults: 1 city Rp1.000,
 * 2 Rp2.000, 3–10 Rp3.000, 12 Rp5.000, 40 or more Rp10.000.
 */
export function adCampaignPricePerDay(
  p: AdPrices,
  scope: 'cities' | 'national',
  cities: number,
): number {
  if (scope === 'national') return p.ad_price_national_idr;
  const n = Math.max(0, Math.floor(cities));
  const bundle = Math.max(1, p.ad_bundle_cities);
  const full = Math.floor(n / bundle);
  const rest = n % bundle;
  const price =
    full * p.ad_price_bundle_idr + Math.min(rest * p.ad_price_city_idr, p.ad_price_bundle_idr);
  return Math.min(price, p.ad_price_national_idr);
}
