// Paket & tagihan (SPEC §12): plan cards, Saldo + top-up (QRIS/VA), add-ons, compress packs,
// ledger and invoices.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Printer, Wallet } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { formatBytes, formatDate, formatDateTime, formatRupiah } from '../../shared/format';
import { lang, t } from '../lib/i18n';
import { Button } from '../components/Button';
import { StorageMeter } from '../components/StorageMeter';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { cn } from '../lib/cn';
import type { BillingSummary, Catalog, Invoice, Plan, Topup } from '../lib/types';

const card = 'z-card rounded-2xl p-5';
const billingKey = ['billing'] as const;

type Then = { kind: 'plan' | 'addon' | 'compress'; code: string };

function useBilling() {
  return useQuery({ queryKey: billingKey, queryFn: () => api<BillingSummary>('/api/billing') });
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INSUFFICIENT_BALANCE')
      return t.billing.notEnough(
        formatRupiah(Number((e.data as { needIdr?: number })?.needIdr ?? 0)),
      );
    if (e.code === 'PAYMENT_UNAVAILABLE') return 'Pembayaran belum tersedia. Coba lagi nanti.';
    if (e.code === 'VALIDATION') return 'Periksa lagi nominal dan metode pembayaran.';
  }
  return t.errors.generic;
}

function TopupDialog({
  open,
  onClose,
  then,
  suggested,
}: {
  open: boolean;
  onClose: () => void;
  then?: Then | undefined;
  suggested?: number | undefined;
}) {
  const qc = useQueryClient();
  const b = useBilling();
  const methods = b.data?.paymentMethods ?? [];
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState('qris');
  const [charge, setCharge] = useState<Topup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const min = Math.max(
    b.data?.minTopupIdr ?? 10_000,
    methods.find((m) => m.code === method)?.minIdr ?? 0,
  );
  const value = amount ?? Math.max(min, suggested ?? 0);
  const create = useMutation({
    mutationFn: () =>
      postJson<Topup>('/api/billing/topups', {
        amountIdr: value,
        method,
        ...(then ? { then } : {}),
      }),
    onSuccess: async (c) => {
      setCharge(c);
      if (c.qrString) setQr(await QRCode.toDataURL(c.qrString, { margin: 1, width: 260 }));
    },
    onError: (e) => toast(errText(e), { tone: 'error' }),
  });
  // Poll until the webhook lands (status is never trusted from the client).
  const status = useQuery({
    queryKey: ['payment', charge?.paymentId],
    queryFn: () => api<BillingSummary>('/api/billing'),
    enabled: Boolean(charge),
    refetchInterval: 3000,
  });
  const stillPending = status.data?.pendingPayments.some((p) => p.id === charge?.paymentId);
  useEffect(() => {
    if (charge && status.data && !stillPending) {
      toast(t.billing.paid);
      void qc.invalidateQueries();
      onClose();
    }
  }, [charge, status.data, stillPending, qc, onClose]);

  return (
    <Dialog open={open} title={t.billing.topupTitle} onClose={onClose}>
      {!charge ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {[10_000, 25_000, 50_000, 100_000].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(v)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-sm',
                  value === v
                    ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100'
                    : 'border-[var(--border)]',
                )}
              >
                {formatRupiah(v)}
              </button>
            ))}
          </div>
          <label className="block text-xs text-[var(--fg-muted)]">
            {t.billing.amount}
            <input
              inputMode="numeric"
              value={value}
              onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)}
              className="mt-1 h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-base text-[var(--fg)]"
            />
            <span className="mt-1 block">{t.billing.minAmount(formatRupiah(min))}</span>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-xs text-[var(--fg-muted)]">{t.billing.method}</legend>
            {methods.map((m) => (
              <label
                key={m.code}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-3 text-sm',
                  value < m.minIdr ? 'opacity-50' : '',
                  method === m.code ? 'border-brand-500' : 'border-[var(--border)]',
                )}
              >
                <input
                  type="radio"
                  name="method"
                  value={m.code}
                  checked={method === m.code}
                  disabled={value < m.minIdr}
                  onChange={() => setMethod(m.code)}
                />
                <span className="flex-1">{m.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">
                  {t.billing.minAmount(formatRupiah(m.minIdr))}
                </span>
              </label>
            ))}
          </fieldset>
          <Button
            className="w-full"
            disabled={value < min || create.isPending}
            onClick={() => create.mutate()}
          >
            {t.billing.payNow} {formatRupiah(value)}
          </Button>
        </div>
      ) : (
        <div className="space-y-4 text-center">
          <p className="text-2xl font-semibold">{formatRupiah(charge.amountIdr)}</p>
          {qr && (
            <>
              <img src={qr} alt="QRIS" className="mx-auto h-64 w-64 rounded-xl bg-white p-2" />
              <p className="text-sm text-[var(--fg-muted)]">{t.billing.scanQr}</p>
            </>
          )}
          {charge.checkoutUrl && (
            <a
              href={charge.checkoutUrl}
              target="_blank"
              rel="noopener"
              className="inline-block rounded-full bg-brand-700 px-5 py-2 text-sm font-medium text-white"
            >
              {t.billing.openCheckout}
            </a>
          )}
          <p className="text-xs text-[var(--fg-muted)]">{t.billing.waiting}</p>
          <p className="text-xs text-[var(--fg-muted)]">
            {t.billing.validUntil(formatDateTime(charge.expiresAt))}
          </p>
          {method === 'qris' && (
            <p className="text-xs text-[var(--fg-muted)]">{t.billing.uniqueCode}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function Billing() {
  const qc = useQueryClient();
  const b = useBilling();
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
  });
  const ledger = useQuery({
    queryKey: ['billing', 'ledger'],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          deltaIdr: number;
          balanceAfter: number;
          reason: string;
          createdAt: number;
        }>;
      }>('/api/billing/ledger'),
  });
  const invoices = useQuery({
    queryKey: ['billing', 'invoices'],
    queryFn: () =>
      api<{ items: Array<{ id: string; number: string; totalIdr: number; issuedAt: number }> }>(
        '/api/billing/invoices',
      ),
  });
  const [topup, setTopup] = useState<{ then?: Then; suggested?: number } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    run: () => Promise<void>;
  } | null>(null);
  useEffect(() => void (document.title = `${t.billing.title} · Zeiko`), []);

  const refresh = () => qc.invalidateQueries();
  const pay = async (fn: () => Promise<unknown>, then: Then, price: number) => {
    try {
      const r = (await fn()) as { kind?: string } | undefined;
      toast(t.billing.done[r?.kind ?? 'subscribed'] ?? t.billing.done.subscribed!);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_BALANCE') {
        setTopup({ then, suggested: Math.max(price - (b.data?.balanceIdr ?? 0), 0) });
      } else toast(errText(e), { tone: 'error' });
    }
  };

  const plans = (catalog.data?.plans ?? []).filter((p) => p.kind === 'personal');
  const sub = b.data?.subscription;
  const current = plans.find((p) => p.code === sub?.planCode);
  const next = plans.find((p) => p.code === sub?.nextPlanCode);

  const choose = (p: Plan) => {
    const isUp = current && p.priceIdr > current.priceIdr && sub?.status === 'active';
    const isDown = current && p.priceIdr < current.priceIdr && sub?.status === 'active';
    setConfirm({
      title: p.name,
      body: isUp
        ? t.billing.confirmUpgrade(p.name)
        : isDown
          ? t.billing.confirmDowngrade(p.name, formatDate(sub!.periodEnd))
          : t.billing.confirmPlan(p.name, formatRupiah(p.priceIdr)),
      run: () =>
        pay(
          () => postJson('/api/billing/plan', { planCode: p.code }),
          { kind: 'plan', code: p.code },
          p.priceIdr,
        ),
    });
  };

  if (b.isPending || catalog.isPending)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (!b.data || !catalog.data)
    return <p className="p-6 text-sm text-red-600">{t.errors.generic}</p>;
  const data = b.data;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <h1 className="text-xl font-semibold">{t.billing.title}</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="font-medium">{t.billing.yourPlan}</h2>
          {current && sub ? (
            <>
              <p className="mt-2 text-2xl font-semibold">{current.name}</p>
              <p className="text-sm text-[var(--fg-muted)]">
                {formatRupiah(current.priceIdr)}
                {t.billing.perMonth} ·{' '}
                {sub.cancelAtPeriodEnd
                  ? t.billing.endsOn(formatDate(sub.periodEnd))
                  : t.billing.renewsOn(formatDate(sub.periodEnd))}
              </p>
              {next && (
                <p className="mt-1 text-sm text-amber-700">
                  {t.billing.nextPlan(next.name, formatDate(sub.periodEnd))}
                </p>
              )}
              <div className="mt-4">
                <StorageMeter storage={data.storage} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {next && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void pay(
                        () => postJson('/api/billing/plan', { planCode: current.code }),
                        { kind: 'plan', code: current.code },
                        0,
                      )
                    }
                  >
                    {t.billing.cancelDowngrade}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() =>
                    void sendJson('POST', '/api/billing/plan/renewal', {
                      cancelAtPeriodEnd: !sub.cancelAtPeriodEnd,
                    })
                      .then(refresh)
                      .catch((e) => toast(errText(e), { tone: 'error' }))
                  }
                >
                  {sub.cancelAtPeriodEnd ? t.billing.resumeRenewal : t.billing.stopRenewal}
                </Button>
              </div>
            </>
          ) : data.managedByFamily ? (
            <p className="mt-2 text-sm">{t.billing.familyManaged}</p>
          ) : (
            <>
              <p className="mt-2 text-lg font-medium">{t.billing.noPlanTitle}</p>
              <p className="text-sm text-[var(--fg-muted)]">{t.billing.noPlanBody}</p>
            </>
          )}
        </section>

        <section className={card}>
          <h2 className="flex items-center gap-2 font-medium">
            <Wallet className="h-4 w-4" aria-hidden="true" /> {t.billing.balance}
          </h2>
          <p className="mt-2 text-2xl font-semibold">{formatRupiah(data.balanceIdr)}</p>
          <p className="text-xs text-[var(--fg-muted)]">{t.billing.balanceNote}</p>
          <Button className="mt-4" onClick={() => setTopup({})}>
            {t.billing.topup}
          </Button>
          {data.pendingPayments.length > 0 && (
            <p className="mt-3 text-xs text-amber-700">
              {t.billing.pending}:{' '}
              {data.pendingPayments.map((p) => formatRupiah(p.amountIdr)).join(', ')}
            </p>
          )}
          <p className="mt-3 text-xs text-[var(--fg-muted)]">
            {t.billing.compressCredits(data.compressCredits)}
          </p>
        </section>
      </div>

      {!data.managedByFamily && (
        <section>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {plans.map((p) => {
              const isCurrent = p.code === sub?.planCode && sub?.status === 'active';
              return (
                <div
                  key={p.code}
                  className={cn(
                    card,
                    'flex flex-col',
                    isCurrent &&
                      'border-brand-500 shadow-[0_18px_44px_-22px_rgba(99,102,241,0.75)] ring-1 ring-brand-500',
                  )}
                >
                  <p className="font-medium">{p.name}</p>
                  <p className="mt-1 text-3xl font-bold tracking-tight">
                    {formatBytes(p.storageBytes)}
                  </p>
                  <p className="text-sm">
                    {formatRupiah(p.priceIdr)}
                    <span className="text-[var(--fg-muted)]">{t.billing.perMonth}</span>
                  </p>
                  {p.compressQuota > 0 && (
                    <p className="mt-1 text-xs text-[var(--fg-muted)]">
                      {t.billing.compressPerMonth(
                        p.compressQuota.toLocaleString(lang === 'id' ? 'id-ID' : 'en-US'),
                      )}
                    </p>
                  )}
                  <div className="flex-1" />
                  <Button
                    className="mt-4"
                    variant={isCurrent ? 'secondary' : 'primary'}
                    disabled={isCurrent}
                    onClick={() => choose(p)}
                  >
                    {isCurrent ? (
                      <>
                        <Check className="h-4 w-4" /> {t.billing.current}
                      </>
                    ) : current && sub?.status === 'active' ? (
                      p.priceIdr > current.priceIdr ? (
                        t.billing.upgrade
                      ) : (
                        t.billing.downgrade
                      )
                    ) : (
                      t.billing.choose
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {sub?.status === 'active' && !data.managedByFamily && (
        <section className={card}>
          <h2 className="font-medium">{t.billing.addons}</h2>
          <p className="text-xs text-[var(--fg-muted)]">{t.billing.addonNote}</p>
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {catalog.data.addons.map((a) => (
              <li key={a.code} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">
                  {a.name} · {formatRupiah(a.priceIdr)}
                  {t.billing.perMonth}
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void pay(
                      () => postJson('/api/billing/addons', { addonCode: a.code }),
                      { kind: 'addon', code: a.code },
                      a.priceIdr,
                    )
                  }
                >
                  {t.billing.buy}
                </Button>
              </li>
            ))}
          </ul>
          {data.addons.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {data.addons.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-600" />{' '}
                  <span className="flex-1">{a.name}</span>
                  <label className="flex items-center gap-1 text-xs text-[var(--fg-muted)]">
                    <input
                      type="checkbox"
                      checked={Boolean(a.cancelAtPeriodEnd)}
                      onChange={(e) =>
                        void sendJson('PATCH', `/api/billing/addons/${a.id}`, {
                          cancelAtPeriodEnd: e.target.checked,
                        }).then(refresh)
                      }
                    />
                    {t.billing.stopAtEnd}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={card}>
        <h2 className="font-medium">{t.billing.compress}</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          {catalog.data.compressPacks.map((p) => (
            <button
              key={p.code}
              type="button"
              onClick={() =>
                void pay(
                  () => postJson('/api/billing/compress-packs', { packCode: p.code }),
                  { kind: 'compress', code: p.code },
                  p.priceIdr,
                )
              }
              className="rounded-xl border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--bg-subtle)]"
            >
              <span className="block font-medium">{p.credits} kompres</span>
              <span className="text-[var(--fg-muted)]">{formatRupiah(p.priceIdr)}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="font-medium">{t.billing.history}</h2>
          <ul className="mt-2 divide-y divide-[var(--border)] text-sm">
            {(ledger.data?.items ?? []).map((l) => (
              <li key={l.id} className="flex items-center gap-2 py-2">
                <span className="flex-1">
                  {t.billing.reasons[l.reason] ?? l.reason}
                  <span className="block text-xs text-[var(--fg-muted)]">
                    {formatDateTime(l.createdAt)}
                  </span>
                </span>
                <span className={l.deltaIdr >= 0 ? 'text-green-700' : ''}>
                  {l.deltaIdr >= 0 ? '+' : '−'}
                  {formatRupiah(Math.abs(l.deltaIdr))}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className={card}>
          <h2 className="font-medium">{t.billing.invoices}</h2>
          <ul className="mt-2 divide-y divide-[var(--border)] text-sm">
            {(invoices.data?.items ?? []).map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-2">
                <Link
                  to="/paket/invoice/$id"
                  params={{ id: i.id }}
                  className="flex-1 text-brand-700 hover:underline dark:text-brand-100"
                >
                  {i.number}
                </Link>
                <span className="text-xs text-[var(--fg-muted)]">{formatDate(i.issuedAt)}</span>
                <span>{formatRupiah(i.totalIdr)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {topup && (
        <TopupDialog
          open
          onClose={() => setTopup(null)}
          then={topup.then}
          suggested={topup.suggested}
        />
      )}
      <Dialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ''}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                void c?.run();
              }}
            >
              {t.common.ok}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirm?.body}</p>
      </Dialog>
    </div>
  );
}

export function InvoicePage({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api<Invoice>(`/api/billing/invoices/${id}`),
  });
  const inv = q.data;
  if (!inv) return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  return (
    <div className="mx-auto max-w-2xl p-4 md:p-8">
      <div className="mb-4 flex justify-end print:hidden">
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> {t.billing.print}
        </Button>
      </div>
      <article className="rounded-2xl border border-[var(--border)] bg-white p-8 text-gray-900 print:border-0 print:p-0">
        <header className="flex items-start justify-between">
          <div>
            <p className="text-lg font-bold text-brand-700">Zeiko</p>
            <p className="text-xs text-gray-500">zeiko.biz.id</p>
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold">{t.billing.invoiceTitle}</p>
            <p className="text-sm">{inv.number}</p>
            <p className="text-xs text-gray-500">{formatDateTime(inv.issuedAt)}</p>
          </div>
        </header>
        <p className="mt-6 text-sm">
          {inv.customer.name || inv.customer.email}
          <br />
          <span className="text-gray-500">{inv.customer.email}</span>
        </p>
        <table className="mt-6 w-full text-sm">
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} className="border-b border-gray-200">
                <td className="py-2">{l.label}</td>
                <td className="py-2 text-right">{formatRupiah(l.amountIdr)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-3 text-gray-500">{t.billing.subtotal}</td>
              <td className="pt-3 text-right">{formatRupiah(inv.subtotalIdr)}</td>
            </tr>
            <tr>
              <td className="text-gray-500">{t.billing.tax(inv.taxRatePct)}</td>
              <td className="text-right">{formatRupiah(inv.taxIdr)}</td>
            </tr>
            <tr className="font-semibold">
              <td className="pt-2">{t.billing.total}</td>
              <td className="pt-2 text-right">{formatRupiah(inv.totalIdr)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-6 inline-block rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
          {t.billing.paidStatus}
        </p>
      </article>
    </div>
  );
}

/** Top-of-app banner: no plan yet, or overdue states (SPEC §12.5). */
export function BillingBanner() {
  const b = useBilling();
  const sub = b.data?.subscription;
  const key =
    !b.data || b.data.managedByFamily
      ? null
      : !sub
        ? 'noPlan'
        : sub.status === 'active'
          ? null
          : sub.status;
  if (!key) return null;
  const tone =
    key === 'noPlan'
      ? 'bg-brand-50 text-brand-900 dark:bg-brand-800/40 dark:text-brand-100'
      : key === 'grace'
        ? 'bg-amber-50 text-amber-900'
        : 'bg-red-50 text-red-900';
  return (
    <div className={cn('flex flex-wrap items-center gap-3 px-4 py-2 text-sm', tone)} role="status">
      <span className="flex-1">{t.billing.banner[key]}</span>
      <Link
        to="/paket"
        className="rounded-full bg-brand-700 px-4 py-1 text-xs font-medium text-white"
      >
        {t.billing.banner.action}
      </Link>
    </div>
  );
}
