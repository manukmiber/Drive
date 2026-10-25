// Paket (SPEC §12, ADR-041): plan cards, add-ons and compress packs, each paid by QRIS when it is
// bought, and the next month renewed by hand. No balance, no history, no invoices.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, QrCode } from 'lucide-react';
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
import type {
  BillingSummary,
  Catalog,
  CheckoutItem,
  CheckoutResult,
  Plan,
  Topup,
} from '../lib/types';

const card = 'z-card rounded-2xl p-5';
const billingKey = ['billing'] as const;

function useBilling() {
  return useQuery({ queryKey: billingKey, queryFn: () => api<BillingSummary>('/api/billing') });
}

function errText(e: unknown): string {
  if (!(e instanceof ApiError)) return t.errors.generic;
  if (e.code === 'PAYMENT_UNAVAILABLE') return t.billing.payUnavailable;
  // Zeiko S3 plans (ADR-047) are bought through the same checkout.
  const reason = e.data?.reason;
  if (reason === 'S3_TOO_SMALL') return t.s3.tooSmall(formatBytes(Number(e.data?.usedBytes ?? 0)));
  if (reason === 'SAME_PLAN') return t.s3.samePlan;
  if (reason === 'NO_REPLICAS') return t.s3.threeUnavailable;
  if (reason === 'URL_TAKEN') return t.s3.urlTaken;
  if (reason === 'URL_INVALID') return t.s3.urlInvalid;
  if (reason === 'URL_RESERVED') return t.s3.urlReserved;
  if (reason === 'URL_EXISTS') return t.s3.urlExists;
  if (reason === 'NO_PLAN') return t.s3.urlNeedsPlan;
  if (e.code === 'VALIDATION' && e.data?.field === 'gb')
    return t.s3.sizeHint(Number(e.data.min), Number(e.data.max));
  return t.errors.generic;
}

type Started = { payment: Topup; creditUsedIdr: number };

/** One purchase's QRIS. It closes by itself once the payment lands (the server decides, never this page). */
function PayDialog({ pay, onClose }: { pay: Started; onClose: () => void }) {
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const { payment } = pay;
  useEffect(() => {
    if (payment.qrString)
      void QRCode.toDataURL(payment.qrString, { margin: 1, width: 260 }).then(setQr);
  }, [payment.qrString]);
  const status = useQuery({
    queryKey: ['payment', payment.paymentId],
    queryFn: () => api<{ status: string }>(`/api/billing/payments/${payment.paymentId}`),
    refetchInterval: 3000,
  });
  const now = status.data?.status;
  useEffect(() => {
    if (!now || now === 'pending') return;
    if (now === 'paid') toast(t.billing.paid);
    else toast(t.billing.expired, { tone: 'error' });
    void qc.invalidateQueries();
    onClose();
  }, [now, qc, onClose]);

  return (
    <Dialog open title={t.billing.payTitle} onClose={onClose}>
      <div className="space-y-4 text-center">
        <p className="text-2xl font-semibold">{formatRupiah(payment.amountIdr)}</p>
        {pay.creditUsedIdr > 0 && (
          <p className="text-xs text-[var(--fg-muted)]">
            {t.billing.creditUsed(formatRupiah(pay.creditUsedIdr))}
          </p>
        )}
        {qr && (
          <>
            <img src={qr} alt="QRIS" className="mx-auto h-64 w-64 rounded-xl bg-white p-2" />
            <p className="text-sm text-[var(--fg-muted)]">{t.billing.scanQr}</p>
          </>
        )}
        {payment.checkoutUrl && (
          <a
            href={payment.checkoutUrl}
            target="_blank"
            rel="noopener"
            className="inline-block rounded-full bg-brand-700 px-5 py-2 text-sm font-medium text-white"
          >
            {t.billing.openCheckout}
          </a>
        )}
        <p className="text-xs text-[var(--fg-muted)]">{t.billing.waiting}</p>
        <p className="text-xs text-[var(--fg-muted)]">
          {t.billing.validUntil(formatDateTime(payment.expiresAt))}
        </p>
        <p className="text-xs text-[var(--fg-muted)]">{t.billing.uniqueCode}</p>
      </div>
    </Dialog>
  );
}

/**
 * Buying anything: `ask` confirms, then the server either makes it at once (nothing to pay, or
 * credit covers it) or opens a QRIS for it. Render `ui` once in the page.
 */
export function useCheckout() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    item: CheckoutItem;
  } | null>(null);
  const [pay, setPay] = useState<Started | null>(null);
  const run = useMutation({
    mutationFn: (item: CheckoutItem) => postJson<CheckoutResult>('/api/billing/checkout', { item }),
    onSuccess: async (r) => {
      if (r.status === 'payment') {
        setPay(r);
        return;
      }
      toast(t.billing.done[r.done.kind] ?? t.billing.done.subscribed!);
      await qc.invalidateQueries();
    },
    onError: (e) => toast(errText(e), { tone: 'error' }),
  });
  const ask = (title: string, body: string, item: CheckoutItem) =>
    setConfirm({ title, body, item });
  const ui = (
    <>
      {pay && <PayDialog pay={pay} onClose={() => setPay(null)} />}
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
              disabled={run.isPending}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c) run.mutate(c.item);
              }}
            >
              {t.common.ok}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirm?.body}</p>
      </Dialog>
    </>
  );
  return { ask, buyNow: (item: CheckoutItem) => run.mutate(item), busy: run.isPending, ui };
}

export function Billing() {
  const qc = useQueryClient();
  const b = useBilling();
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
  });
  const { ask, buyNow, busy, ui } = useCheckout();
  useEffect(() => void (document.title = `${t.billing.title} · Zeiko`), []);

  if (b.isPending || catalog.isPending)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (!b.data || !catalog.data)
    return <p className="p-6 text-sm text-red-600">{t.errors.generic}</p>;
  const data = b.data;

  const plans = catalog.data.plans.filter((p) => p.kind === 'personal');
  const sub = data.subscription;
  const active = sub?.status === 'active';
  const current = plans.find((p) => p.code === sub?.planCode);
  const next = plans.find((p) => p.code === sub?.nextPlanCode);

  const choose = (p: Plan) => {
    const isUp = current && active && p.priceIdr > current.priceIdr;
    const isDown = current && active && p.priceIdr < current.priceIdr;
    ask(
      p.name,
      isUp
        ? t.billing.confirmUpgrade(p.name)
        : isDown
          ? t.billing.confirmDowngrade(p.name, formatDate(sub!.periodEnd))
          : t.billing.confirmPlan(p.name, formatRupiah(p.priceIdr)),
      { kind: 'plan', code: p.code },
    );
  };
  const renewPrice = data.renewIdr === null ? null : formatRupiah(data.renewIdr);

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
                {t.billing.perMonth} · {t.billing.activeUntil(formatDate(sub.periodEnd))}
              </p>
              {!active && (
                <p className="mt-1 text-sm text-amber-700">{t.billing.banner[sub.status]}</p>
              )}
              {next && (
                <p className="mt-1 text-sm text-amber-700">
                  {t.billing.nextPlan(next.name, formatDate(sub.periodEnd))}
                </p>
              )}
              <div className="mt-4">
                <StorageMeter storage={data.storage} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {renewPrice && (
                  <Button
                    disabled={busy || !data.canPay}
                    onClick={() =>
                      ask(
                        current.name,
                        active
                          ? t.billing.confirmRenew(renewPrice)
                          : t.billing.confirmRestore(renewPrice),
                        { kind: 'renew' },
                      )
                    }
                  >
                    {active ? t.billing.renew(renewPrice) : t.billing.restore(renewPrice)}
                  </Button>
                )}
                {next && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => buyNow({ kind: 'plan', code: current.code })}
                  >
                    {t.billing.cancelDowngrade}
                  </Button>
                )}
              </div>
              {active && (
                <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.billing.renewNote}</p>
              )}
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
            <QrCode className="h-4 w-4" aria-hidden="true" /> {t.billing.paying}
          </h2>
          <p className="mt-2 text-sm text-[var(--fg-muted)]">{t.billing.payingBody}</p>
          {data.creditIdr > 0 && (
            <p className="mt-3 text-sm">{t.billing.credit(formatRupiah(data.creditIdr))}</p>
          )}
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
              const isCurrent = p.code === sub?.planCode && active;
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
                    disabled={isCurrent || busy || !data.canPay}
                    onClick={() => choose(p)}
                  >
                    {isCurrent ? (
                      <>
                        <Check className="h-4 w-4" /> {t.billing.current}
                      </>
                    ) : current && active ? (
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

      {active && !data.managedByFamily && (
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
                  disabled={busy || !data.canPay}
                  onClick={() =>
                    ask(a.name, t.billing.confirmAddon(a.name), { kind: 'addon', code: a.code })
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
                        }).then(() => qc.invalidateQueries())
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
              disabled={busy || !data.canPay}
              onClick={() =>
                ask(
                  t.billing.compressPack(p.credits),
                  t.billing.confirmCompress(
                    t.billing.compressPack(p.credits),
                    formatRupiah(p.priceIdr),
                  ),
                  { kind: 'compress', code: p.code },
                )
              }
              className="rounded-xl border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--bg-subtle)] disabled:opacity-50"
            >
              <span className="block font-medium">{t.billing.compressPack(p.credits)}</span>
              <span className="text-[var(--fg-muted)]">{formatRupiah(p.priceIdr)}</span>
            </button>
          ))}
        </div>
      </section>

      {ui}
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
