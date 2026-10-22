// One small, static, clearly labelled ad (SPEC §10.1). Never rendered on upload/download UI.
// Impression = ≥ 50 % visible for ≥ 1 s; frequency cap per session; "Sembunyikan" per creative.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EyeOff, Flag, Megaphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { getAd, type Placement } from '../lib/ads';
import { useCatalog } from '../lib/catalog';

const HIDDEN_KEY = 'zk.ads.hidden';
const SEEN_KEY = 'zk.ads.seen';

function readJson<T>(store: () => Storage, key: string, fallback: T): T {
  try {
    const v = store().getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(store: () => Storage, key: string, value: unknown): void {
  try {
    store().setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: ads just aren't capped or hidden across reloads.
  }
}

export function AdCard({
  placement,
  className = '',
}: {
  placement: Placement;
  className?: string;
}) {
  const catalog = useCatalog();
  const enabled = catalog.data?.config.features.ads !== false;
  const cap = Number(catalog.data?.config.ad_frequency_cap_per_session ?? 3);
  const [hidden, setHidden] = useState<string[]>(() =>
    readJson(() => localStorage, HIDDEN_KEY, []),
  );
  const q = useQuery({
    queryKey: ['ad', placement, hidden],
    queryFn: () => getAd(placement, hidden),
    enabled,
    staleTime: 5 * 60_000,
  });
  const ad = q.data?.ad ?? null;
  const ref = useRef<HTMLElement>(null);
  const seen = readJson<Record<string, number>>(() => sessionStorage, SEEN_KEY, {});
  const capped = Boolean(ad?.bookingId && (seen[ad.bookingId] ?? 0) >= cap);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ad?.bookingId || !ad.token || capped) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          timer = setTimeout(() => {
            const counts = readJson<Record<string, number>>(() => sessionStorage, SEEN_KEY, {});
            counts[ad.bookingId!] = (counts[ad.bookingId!] ?? 0) + 1;
            writeJson(() => sessionStorage, SEEN_KEY, counts);
            navigator.sendBeacon?.(
              '/ad/i',
              new Blob([JSON.stringify({ b: ad.bookingId, t: ad.token })], {
                type: 'application/json',
              }),
            );
            obs.disconnect();
          }, 1000);
        } else if (timer) clearTimeout(timer);
      },
      { threshold: 0.5 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [ad?.bookingId, ad?.token, capped]);

  if (!enabled || !ad || capped) return null;

  const hide = () => {
    if (!ad.creativeId) return;
    const next = [...hidden, ad.creativeId].slice(-20);
    writeJson(() => localStorage, HIDDEN_KEY, next);
    setHidden(next);
  };

  return (
    <aside
      ref={ref}
      aria-label={ad.label}
      className={`rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-xs ${className}`}
    >
      <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--fg-muted)]">
        <span>{ad.label}</span>
        {ad.creativeId && (
          <span className="flex gap-1">
            <button
              type="button"
              onClick={hide}
              title={t.ads.hide}
              aria-label={t.ads.hide}
              className="rounded p-0.5 hover:bg-[var(--bg-subtle)]"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
            <a
              href={`/lapor?ad=${ad.creativeId}`}
              title={t.ads.report}
              aria-label={t.ads.report}
              className="rounded p-0.5 hover:bg-[var(--bg-subtle)]"
            >
              <Flag className="h-3.5 w-3.5" />
            </a>
          </span>
        )}
      </div>
      {ad.internal ? (
        <Link to="/iklan" className="flex gap-3">
          <Megaphone
            className="h-10 w-10 shrink-0 rounded-lg bg-brand-50 p-2 text-brand-700"
            aria-hidden="true"
          />
          <span>
            <b className="block text-[13px] text-[var(--fg)]">{ad.title}</b>
            <span className="text-[var(--fg-muted)]">{ad.body}</span>
          </span>
        </Link>
      ) : (
        <a
          href={ad.clickUrl}
          target="_blank"
          rel="sponsored noopener noreferrer"
          className="flex gap-3"
        >
          {ad.imageUrl && (
            <img
              src={ad.imageUrl}
              alt=""
              width={56}
              height={56}
              loading="lazy"
              className="h-14 w-14 shrink-0 rounded-lg object-cover"
            />
          )}
          <span className="min-w-0">
            <b className="block truncate text-[13px] text-[var(--fg)]">{ad.title}</b>
            <span className="line-clamp-2 text-[var(--fg-muted)]">{ad.body}</span>
            <span className="mt-1 inline-block font-medium text-brand-700">{ad.ctaLabel} →</span>
          </span>
        </a>
      )}
    </aside>
  );
}
