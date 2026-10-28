// /iklan (ADR-043): the rules and prices, the way to order (email the operator), and for anyone with
// an ad in their name, their dashboard: each campaign, where it stands, and how often it was seen
// and clicked per day and per city. Ordering and paying are by email; nothing is bought here.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Megaphone, MessageCircle } from 'lucide-react';
import { AD_CONTACT, SUPPORT_WHATSAPP_URL } from '../../shared/constants';
import { formatPercent, formatRupiah } from '../../shared/format';
import { t } from '../lib/i18n';
import { dashboard, type MyCampaign, type Stat } from '../lib/ads';
import { ApiError } from '../lib/api';
import { useCatalog } from '../lib/catalog';

const card = 'z-card rounded-2xl p-5';
const KEY = ['advertiser'] as const;

export function adError(e: unknown): string {
  if (e instanceof ApiError) {
    return t.ads.errors[e.message] ?? t.ads.errors[e.code] ?? t.errors.generic;
  }
  return t.errors.generic;
}

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00+07:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  });

export function Advertiser() {
  const catalog = useCatalog();
  const cfg = catalog.data?.config;
  const n = (k: string, d: number) => Number((cfg as Record<string, unknown> | undefined)?.[k] ?? d);
  const city = formatRupiah(n('ad_price_city_idr', 1000));
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <section className={card}>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Megaphone className="h-5 w-5 text-brand-600" />
          {t.ads.contactTitle}
        </h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">{t.ads.contactBody}</p>
        <a
          href={`${SUPPORT_WHATSAPP_URL}?text=${encodeURIComponent(t.ads.contactTitle)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="z-primary mt-4 inline-flex h-10 items-center gap-2 rounded-xl px-5 text-sm font-semibold"
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" /> {t.ads.contactButton(AD_CONTACT)}
        </a>
      </section>

      <Mine />

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="font-medium">{t.ads.pricesTitle}</h2>
          <ul className="mt-3 space-y-1.5 text-sm">
            <li>{t.ads.priceCity(city)}</li>
            <li>
              {t.ads.priceBundle(
                n('ad_bundle_cities', 10),
                formatRupiah(n('ad_price_bundle_idr', 3000)),
              )}
            </li>
            <li>{t.ads.priceNational(formatRupiah(n('ad_price_national_idr', 10000)))}</li>
          </ul>
          <p className="mt-3 text-xs text-[var(--fg-muted)]">
            {t.ads.priceNote(city, n('ad_bundle_cities', 10))}
          </p>
        </section>
        <section className={card}>
          <h2 className="font-medium">{t.ads.rulesTitle}</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
            {[...t.ads.rules, t.ads.ruleRotate(n('ad_rotate_seconds', 15)), t.ads.ruleDashboard].map(
              (r) => (
                <li key={r}>{r}</li>
              ),
            )}
          </ol>
          <p className="mt-3">
            <Link
              to="/kebijakan/$slug"
              params={{ slug: 'kebijakan-iklan' }}
              className="text-sm text-brand-700 hover:underline"
            >
              {t.ads.policyLink}
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}

/** Rule 6: the advertiser's own numbers. Shown only to someone with an ad in their name. */
function Mine() {
  const q = useQuery({ queryKey: KEY, queryFn: dashboard });
  if (!q.data?.advertiser) return null;
  return (
    <section className="space-y-3">
      <h2 className="px-1 font-medium">
        {t.ads.mineTitle} · {q.data.advertiser.businessName}
      </h2>
      {q.data.campaigns.length === 0 && (
        <p className={`${card} text-sm text-[var(--fg-muted)]`}>{t.ads.mineEmpty}</p>
      )}
      {q.data.campaigns.map((k) => (
        <Campaign key={k.id} k={k} />
      ))}
    </section>
  );
}

function statusTone(s: string): string {
  if (s === 'live') return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200';
  if (s === 'awaiting_payment')
    return 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200';
  if (s === 'rejected' || s === 'suspended' || s === 'expired')
    return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
  return 'bg-[var(--bg-subtle)] text-[var(--fg-muted)]';
}

function Numbers({ s }: { s: Stat }) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-center">
      {(
        [
          [t.ads.impressions, s.impressions.toLocaleString()],
          [t.ads.clicks, s.clicks.toLocaleString()],
          [t.ads.ctr, formatPercent(s.ctr)],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="rounded-xl bg-[var(--bg-subtle)] p-2">
          <dt className="text-[11px] text-[var(--fg-muted)]">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Breakdown({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: Array<Stat & { key: string; label: string }>;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-medium text-[var(--fg-muted)]">{title}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-left text-[var(--fg-muted)]">
            <tr>
              <th className="py-1 pr-2 font-normal">{head}</th>
              <th className="py-1 pr-2 text-right font-normal">{t.ads.impressions}</th>
              <th className="py-1 pr-2 text-right font-normal">{t.ads.clicks}</th>
              <th className="py-1 text-right font-normal">{t.ads.ctr}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-[var(--border)]">
                <td className="py-1 pr-2">{r.label}</td>
                <td className="py-1 pr-2 text-right">{r.impressions.toLocaleString()}</td>
                <td className="py-1 pr-2 text-right">{r.clicks.toLocaleString()}</td>
                <td className="py-1 text-right">{formatPercent(r.ctr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Campaign({ k }: { k: MyCampaign }) {
  const where =
    k.scope === 'national'
      ? t.ads.national
      : k.areas.length === 1
        ? k.areas[0]!.name
        : t.ads.cities(k.areas.length);
  return (
    <article className={`${card} space-y-3 text-sm`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{k.title}</h3>
          <p className="text-xs text-[var(--fg-muted)]">
            {where} · {t.ads.dates(fmtDay(k.startDate), fmtDay(k.endDate), k.days)} ·{' '}
            {t.ads.perDay(formatRupiah(k.pricePerDayIdr))}
          </p>
          {k.scope === 'cities' && k.areas.length > 1 && (
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {k.areas.map((a) => a.name).join(', ')}
            </p>
          )}
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone(k.status)}`}>
          {t.ads.statuses[k.status] ?? k.status}
        </span>
      </div>
      {k.reason && <p className="text-xs text-[var(--fg-muted)]">{t.ads.reason(k.reason)}</p>}
      {k.status === 'awaiting_payment' && (
        <p className="rounded-xl bg-[var(--bg-subtle)] p-3 text-xs">
          {t.ads.payByEmail(formatRupiah(k.payIdr), fmtDay(k.startDate))}
        </p>
      )}
      {['live', 'completed', 'suspended'].includes(k.status) && (
        <>
          <Numbers s={k} />
          {k.impressions + k.clicks === 0 ? (
            <p className="text-xs text-[var(--fg-muted)]">{t.ads.noStats}</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Breakdown
                title={t.ads.byDay}
                head={t.ads.date}
                rows={k.byDay.map((d) => ({ ...d, key: d.date, label: fmtDay(d.date) }))}
              />
              <Breakdown
                title={t.ads.byCity}
                head={t.ads.city}
                rows={k.byArea.map((a) => ({ ...a, key: a.code, label: a.name }))}
              />
            </div>
          )}
        </>
      )}
    </article>
  );
}
