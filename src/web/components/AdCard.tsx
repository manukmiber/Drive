// One small, clearly labelled ad (SPEC §10.1). Never rendered on upload/download UI.
// ADR-043: the card plays a rotation, one ad every `rotateSeconds`; it only swaps the content (no
// animation) and holds still while the tab is hidden. An impression is the ad shown ≥ 50 % for
// ≥ 1 s; "Sembunyikan" hides a creative for good on this browser.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EyeOff, Flag, Megaphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { getRotation, type Placement } from '../lib/ads';
import { useCatalog } from '../lib/catalog';

const HIDDEN_KEY = 'zk.ads.hidden';

function readHidden(): string[] {
  try {
    const v = localStorage.getItem(HIDDEN_KEY);
    return v ? (JSON.parse(v) as string[]) : [];
  } catch {
    return [];
  }
}

function writeHidden(value: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: the ad is hidden until the page reloads.
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
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const q = useQuery({
    queryKey: ['ads', placement, hidden],
    queryFn: () => getRotation(placement, hidden),
    enabled,
    staleTime: 5 * 60_000,
  });
  const ads = q.data?.ads ?? [];
  const seconds = q.data?.rotateSeconds ?? 15;
  const [turn, setTurn] = useState(0);
  const ad = ads.length ? ads[turn % ads.length]! : null;
  const ref = useRef<HTMLElement>(null);

  // Next ad every `seconds`, only while the page is in front; at the end, ask for a fresh rotation.
  const { refetch } = q;
  useEffect(() => {
    if (ads.length < 2) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTurn((n) => n + 1);
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [ads.length, seconds]);
  useEffect(() => {
    if (ads.length > 1 && turn > 0 && turn % ads.length === 0) void refetch();
  }, [turn, ads.length, refetch]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ad?.campaignId || !ad.token || !ad.area) return;
    const body = JSON.stringify({ c: ad.campaignId, a: ad.area, t: ad.token });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && document.visibilityState === 'visible') {
          timer = setTimeout(() => {
            navigator.sendBeacon?.('/ad/i', new Blob([body], { type: 'application/json' }));
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
    // A new turn is a new showing, even of the same ad.
  }, [ad?.campaignId, ad?.token, ad?.area, turn]);

  if (!enabled || !ad) return null;

  const hide = () => {
    if (!ad.creativeId) return;
    const next = [...hidden, ad.creativeId].slice(-20);
    writeHidden(next);
    setHidden(next);
    setTurn(0);
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
            className="h-10 w-10 shrink-0 rounded-lg bg-brand-50 dark:bg-brand-800/40 p-2 text-brand-700"
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
