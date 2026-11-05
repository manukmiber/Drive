import { t } from '../lib/i18n';

// The Zeiko logo (proxychat/brand/zeiko, chosen by the owner on 2026-11-02): the kawung mark, four
// petals around the amber dot, and the "Zeiko" wordmark as outlines, whose i carries the same dot.
// The product's name follows in Plus Jakarta Sans at the wordmark's size and baseline. The tile is
// navy on both schemes; the words take the text colour, so they turn cream on the dark one.

const PETALS = (
  <g fill="#eee6d7">
    <ellipse cx="21" cy="21" rx="11" ry="6.6" transform="rotate(45 21 21)" />
    <ellipse cx="43" cy="43" rx="11" ry="6.6" transform="rotate(45 43 43)" />
    <ellipse cx="43" cy="21" rx="11" ry="6.6" transform="rotate(-45 43 21)" />
    <ellipse cx="21" cy="43" rx="11" ry="6.6" transform="rotate(-45 21 43)" />
  </g>
);

export function Mark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#1f2639" />
      {PETALS}
      <circle cx="32" cy="32" r="3.6" fill="#f0ae48" />
    </svg>
  );
}

const WORDMARK =
  'M106.69 49.88L80.53 49.88L80.53 43.88L96.80 20.60L81.49 20.60L81.49 14.12L106.21 14.12L106.21 20.12L89.98 43.40L106.69 43.40L106.69 49.88ZM121.76 50.46L121.76 50.46Q117.58 50.46 114.51 48.61Q111.44 46.76 109.76 43.64Q108.08 40.52 108.08 36.73L108.08 36.73Q108.08 32.79 109.83 29.72Q111.58 26.65 114.56 24.87Q117.54 23.10 121.28 23.10L121.28 23.10Q124.40 23.10 126.80 24.08Q129.20 25.06 130.86 26.84Q132.51 28.62 133.38 30.94Q134.24 33.27 134.24 36.01L134.24 36.01Q134.24 36.78 134.17 37.52Q134.10 38.26 133.90 38.79L133.90 38.79L114.27 38.79L114.27 33.51L129.82 33.51L126.42 36.01Q126.90 33.94 126.37 32.34Q125.84 30.73 124.52 29.79Q123.20 28.86 121.28 28.86L121.28 28.86Q119.41 28.86 118.06 29.77Q116.72 30.68 116.05 32.46Q115.38 34.23 115.52 36.78L115.52 36.78Q115.33 38.98 116.05 40.66Q116.77 42.34 118.26 43.28Q119.74 44.22 121.86 44.22L121.86 44.22Q123.78 44.22 125.14 43.45Q126.51 42.68 127.28 41.34L127.28 41.34L133.04 44.07Q132.27 45.99 130.62 47.43Q128.96 48.87 126.70 49.66Q124.45 50.46 121.76 50.46ZM144.94 49.88L137.74 49.88L137.74 23.67L144.94 23.67L144.94 49.88ZM156.70 49.88L149.50 49.88L149.50 13.54L156.70 13.54L156.70 36.82L154.02 35.96L165.58 23.67L174.46 23.67L164.96 34.23L174.42 49.88L166.26 49.88L158.34 36.58L162.51 35.53L154.50 44.26L156.70 40.09L156.70 49.88ZM189.44 50.46L189.44 50.46Q185.55 50.46 182.36 48.68Q179.17 46.90 177.27 43.81Q175.38 40.71 175.38 36.78L175.38 36.78Q175.38 32.79 177.27 29.72Q179.17 26.65 182.36 24.87Q185.55 23.10 189.44 23.10L189.44 23.10Q193.33 23.10 196.50 24.87Q199.66 26.65 201.56 29.72Q203.46 32.79 203.46 36.78L203.46 36.78Q203.46 40.71 201.56 43.81Q199.66 46.90 196.50 48.68Q193.33 50.46 189.44 50.46ZM189.44 43.98L189.44 43.98Q191.41 43.98 192.87 43.06Q194.34 42.15 195.18 40.52Q196.02 38.89 196.02 36.78L196.02 36.78Q196.02 34.66 195.18 33.06Q194.34 31.45 192.87 30.51Q191.41 29.58 189.44 29.58L189.44 29.58Q187.47 29.58 185.98 30.51Q184.50 31.45 183.66 33.06Q182.82 34.66 182.82 36.78L182.82 36.78Q182.82 38.89 183.66 40.52Q184.50 42.15 185.98 43.06Q187.47 43.98 189.44 43.98Z';

export function Logo({
  className = '',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  if (compact)
    return (
      <span className={`inline-flex ${className}`}>
        <Mark />
        <span className="sr-only">{t.app.name}</span>
      </span>
    );
  return (
    <span className={`inline-flex text-[var(--ink)] ${className}`}>
      {/* 48 units is the size the wordmark was set at: its capitals stand 35.76 units tall, and
          Plus Jakarta Sans's are 0.745 of the size. */}
      <svg
        viewBox="0 0 344 64"
        className="h-8 w-auto overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <rect width="64" height="64" rx="14" fill="#1f2639" />
        {PETALS}
        <circle cx="32" cy="32" r="3.6" fill="#f0ae48" />
        <path fill="currentColor" d={WORDMARK} />
        <circle cx="141.34" cy="17.72" r="3.89" fill="#f0ae48" />
        <text
          x="217"
          y="49.88"
          fill="currentColor"
          fontFamily="'Plus Jakarta Sans', system-ui, sans-serif"
          fontSize="48"
          fontWeight="500"
          letterSpacing="-0.5"
        >
          Drive
        </text>
      </svg>
      <span className="sr-only">{t.app.name}</span>
    </span>
  );
}
