// Zeiko S3 (ADR-044): buying a plan (ADR-047), the endpoint, this account's storage and plan, its
// access keys and buckets. A bucket's objects can be browsed, uploaded (one request each), linked
// and deleted here, and its CORS rules set (ADR-055); everything else goes through any S3 tool.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Copy,
  Database,
  FolderOpen,
  Globe,
  KeyRound,
  Lock,
  Plus,
  Receipt,
  Share2,
  Trash2,
} from 'lucide-react';
import type { CheckoutItem } from '../lib/types';
import { useState, type FormEvent, type ReactNode } from 'react';
import { OPERATOR_EMAIL } from '../../shared/constants';
import { formatBytes, formatDate, formatRupiah } from '../../shared/format';
import { Button } from '../components/Button';
import { Dialog, PromptDialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { t } from '../lib/i18n';
import { cn } from '../lib/cn';
import { useCatalog } from '../lib/catalog';
import { useCheckout } from './Billing';
import { NotFound } from './NotFound';
import { S3Browser } from './S3Browser';

interface S3Key {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface CorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds?: number;
}

interface S3Bucket {
  name: string;
  public: boolean;
  blocked: boolean;
  createdAt: number;
  cors: CorsRule[] | null;
}

const CORS_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'];
const csv = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** One CORS rule, the common case (ADR-055); more rules are for the S3 API. */
function CorsDialog({
  bucket,
  onClose,
  onSaved,
}: {
  bucket: S3Bucket;
  onClose: () => void;
  onSaved: () => void;
}) {
  const first = bucket.cors?.[0];
  const [origins, setOrigins] = useState(first?.allowedOrigins.join('\n') ?? '');
  const [methods, setMethods] = useState<string[]>(first?.allowedMethods ?? ['GET', 'HEAD']);
  const [headers, setHeaders] = useState(first?.allowedHeaders.join(', ') ?? '*');
  const [expose, setExpose] = useState(first?.exposeHeaders.join(', ') ?? 'ETag');
  const [maxAge, setMaxAge] = useState(String(first?.maxAgeSeconds ?? 3000));
  const [busy, setBusy] = useState(false);
  const path = `/api/s3/buckets/${encodeURIComponent(bucket.name)}/cors`;
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onSaved();
      onClose();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const field =
    'mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--fg)]';
  return (
    <Dialog
      open
      title={t.s3.corsTitle(bucket.name)}
      onClose={onClose}
      footer={
        <>
          {bucket.cors && (
            <Button
              variant="ghost"
              className="text-red-600"
              disabled={busy}
              onClick={() => void act(() => sendJson('DELETE', path), t.s3.corsRemoved)}
            >
              {t.s3.corsRemove}
            </Button>
          )}
          <Button
            disabled={busy || !csv(origins).length || !methods.length}
            onClick={() =>
              void act(
                () =>
                  sendJson('PUT', path, {
                    rules: [
                      {
                        allowedOrigins: csv(origins),
                        allowedMethods: methods,
                        allowedHeaders: csv(headers),
                        exposeHeaders: csv(expose),
                        ...(maxAge ? { maxAgeSeconds: Number(maxAge) } : {}),
                      },
                    ],
                  }),
                t.s3.corsSaved,
              )
            }
          >
            {t.s3.corsSave}
          </Button>
        </>
      }
    >
      <p className="text-[var(--fg-muted)]">{t.s3.corsBody}</p>
      {(bucket.cors?.length ?? 0) > 1 && (
        <p className="mt-2 text-xs text-amber-700">{t.s3.corsManyRules(bucket.cors!.length)}</p>
      )}
      <label className="mt-3 block text-xs text-[var(--fg-muted)]">
        {t.s3.corsOrigins}
        <textarea
          rows={3}
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          className={field}
          placeholder="https://app.contoh.com"
        />
      </label>
      <fieldset className="mt-3">
        <legend className="text-xs text-[var(--fg-muted)]">{t.s3.corsMethods}</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {CORS_METHODS.map((m) => (
            <label key={m} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={methods.includes(m)}
                onChange={(e) =>
                  setMethods((cur) => (e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))
                }
              />
              {m}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 block text-xs text-[var(--fg-muted)]">
        {t.s3.corsHeaders}
        <input value={headers} onChange={(e) => setHeaders(e.target.value)} className={field} />
      </label>
      <label className="mt-3 block text-xs text-[var(--fg-muted)]">
        {t.s3.corsExpose}
        <input value={expose} onChange={(e) => setExpose(e.target.value)} className={field} />
      </label>
      <label className="mt-3 block text-xs text-[var(--fg-muted)]">
        {t.s3.corsMaxAge}
        <input
          value={maxAge}
          onChange={(e) => setMaxAge(e.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          className={field}
        />
      </label>
    </Dialog>
  );
}

interface S3Plan {
  prices: {
    perGbMonthIdr: number;
    perGbMonth3xIdr: number;
    minGb: number;
    maxGb: number;
    threeCopies: boolean;
    egressFreeBytes: number;
    egressBlockBytes: number;
    egressBlockIdr: number;
  };
  billingState: 'ok' | 'readonly' | 'locked';
  creditIdr: number;
  plan: {
    gb: number;
    replicas: 1 | 3;
    periodStart: number;
    periodEnd: number;
    lapsed: boolean;
    next: { gb: number; replicas: 1 | 3 } | null;
    renewIdr: number | null;
  } | null;
  egress: { periodStart: number; bytes: number; billable: boolean; pendingIdr: number };
}

interface S3Url {
  hostname: string;
  kind: 'zeiko' | 'custom';
  status: 'pending' | 'active' | 'failed';
  url: string;
  records: Array<{ type: string; name: string; value: string }>;
  error: string | null;
}

interface S3UrlOptions {
  zeiko: { available: boolean; priceIdr: number; suffix: string | null };
  custom: { available: boolean; priceIdr: number; cnameTarget: string | null };
  releaseDays: number;
}

interface S3Overview {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  region: string;
  account: {
    status: 'active' | 'suspended';
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
    billingState: 'ok' | 'readonly' | 'locked';
  } | null;
  plan: S3Plan | null;
  url: S3Url | null;
  urlOptions: S3UrlOptions | null;
  keys: S3Key[];
  buckets: S3Bucket[];
}

const card = 'z-card rounded-2xl p-5';
const QUERY = ['s3'];

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast(t.s3.copied));
}

/** A value with a copy button; `wrap` shows all of it (a secret shown once must be readable whole). */
function CopyField({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-[var(--fg-muted)]">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 rounded-lg bg-[var(--bg-subtle)] px-3 py-2 text-sm ${wrap ? 'break-all' : 'truncate'}`}
        >
          {value}
        </code>
        <Button
          variant="secondary"
          className="h-9 px-3"
          onClick={() => copy(value)}
          aria-label={`${t.s3.copy} ${label}`}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  icon,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={card} aria-labelledby={id}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = e.data?.reason;
    if (reason === 'BucketAlreadyExists' || reason === 'BucketAlreadyOwnedByYou')
      return t.s3.nameTaken;
    if (reason === 'BucketNotEmpty') return t.s3.notEmpty;
    if (reason === 'InvalidBucketName') return t.s3.invalidName;
    if (reason === 'AccountProblem') return t.s3.unpaid;
    if (e.code === 'CONFLICT' && typeof e.data?.max === 'number')
      return t.s3.tooManyKeys(e.data.max);
  }
  return t.errors.generic;
}

const monthlyIdr = (p: S3Plan['prices'], gb: number, replicas: 1 | 3) =>
  gb * (replicas === 3 ? p.perGbMonth3xIdr : p.perGbMonthIdr);

/** Size and copies, with what that costs a month. */
function PlanForm({
  prices,
  initial,
  action,
  disabled,
  onSubmit,
}: {
  prices: S3Plan['prices'];
  initial: { gb: number; replicas: 1 | 3 };
  action: (amount: string) => string;
  disabled?: boolean;
  onSubmit: (gb: number, replicas: 1 | 3) => void;
}) {
  const [gbText, setGbText] = useState(String(initial.gb));
  const [replicas, setReplicas] = useState<1 | 3>(initial.replicas);
  const gb = Number(gbText);
  const valid = Number.isInteger(gb) && gb >= prices.minGb && gb <= prices.maxGb;
  const amount = formatRupiah(valid ? monthlyIdr(prices, gb, replicas) : 0);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(gb, replicas);
      }}
    >
      <label className="block">
        <span className="text-sm font-medium">{t.s3.size}</span>
        <input
          type="number"
          inputMode="numeric"
          min={prices.minGb}
          max={prices.maxGb}
          step={1}
          required
          value={gbText}
          onChange={(e) => setGbText(e.target.value)}
          aria-describedby="s3-size-hint"
          className="mt-1 h-10 w-40 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-sm"
        />
        <span id="s3-size-hint" className="mt-1 block text-xs text-[var(--fg-muted)]">
          {t.s3.sizeHint(prices.minGb, prices.maxGb)}
        </span>
      </label>
      {/* One copy only until the replica buckets exist (ADR-049): no choice to show. */}
      {(prices.threeCopies || initial.replicas === 3) && (
        <fieldset>
          <legend className="text-sm font-medium">{t.s3.copies}</legend>
          {([1, 3] as const).map((n) => (
            <label key={n} className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="replicas"
                checked={replicas === n}
                disabled={n === 3 && !prices.threeCopies}
                onChange={() => setReplicas(n)}
              />
              {t.s3.copyOption(
                n,
                formatRupiah(n === 3 ? prices.perGbMonth3xIdr : prices.perGbMonthIdr),
              )}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">{t.s3.monthly(amount)}</span>
        <Button type="submit" className="h-9 px-4" disabled={!valid || disabled}>
          {action(amount)}
        </Button>
      </div>
    </form>
  );
}

function PriceNotes({ p }: { p: S3Plan['prices'] }) {
  return (
    <div className="space-y-1 text-sm text-[var(--fg-muted)]">
      <p>
        {p.threeCopies
          ? t.s3.prices(formatRupiah(p.perGbMonthIdr), formatRupiah(p.perGbMonth3xIdr), p.minGb)
          : t.s3.priceOne(formatRupiah(p.perGbMonthIdr), p.minGb)}
      </p>
      <p>
        {t.s3.egressRule(
          formatBytes(p.egressFreeBytes),
          formatBytes(p.egressBlockBytes),
          formatRupiah(p.egressBlockIdr),
        )}
      </p>
    </div>
  );
}

/** First purchase: nothing of Zeiko S3 yet. */
function BuyCard({ plan }: { plan: S3Plan }) {
  const checkout = useCheckout();
  const buy = (gb: number, replicas: 1 | 3) => {
    const item: CheckoutItem = { kind: 's3_plan', gb, replicas };
    checkout.ask(
      t.s3.buyTitle,
      t.s3.buyBody(
        t.s3.planLine(gb, t.s3.copiesLabel(replicas)),
        formatRupiah(monthlyIdr(plan.prices, gb, replicas)),
      ),
      item,
    );
  };
  return (
    <div className={card}>
      <p className="text-sm">{t.s3.buyIntro}</p>
      <div className="mt-3">
        <PriceNotes p={plan.prices} />
      </div>
      <div className="mt-4">
        <PlanForm
          prices={plan.prices}
          initial={{ gb: Math.max(plan.prices.minGb, 10), replicas: 1 }}
          action={t.s3.buy}
          disabled={checkout.busy}
          onSubmit={buy}
        />
      </div>
      {checkout.ui}
    </div>
  );
}

/** The plan, its renewal, a change, and this period's egress. */
function PlanSection({ plan }: { plan: S3Plan }) {
  const checkout = useCheckout();
  const [changing, setChanging] = useState(false);
  const cur = plan.plan;
  const p = plan.prices;
  const change = (gb: number, replicas: 1 | 3) => {
    setChanging(false);
    const line = t.s3.planLine(gb, t.s3.copiesLabel(replicas));
    const amount = formatRupiah(monthlyIdr(p, gb, replicas));
    if (cur)
      checkout.ask(t.s3.changeTitle, t.s3.changeBody(line, amount), {
        kind: 's3_plan',
        gb,
        replicas,
      });
    else checkout.ask(t.s3.buyTitle, t.s3.buyBody(line, amount), { kind: 's3_plan', gb, replicas });
  };
  return (
    <Section
      id="s3-plan"
      title={t.s3.plan}
      icon={<Receipt className="h-4 w-4" aria-hidden="true" />}
    >
      {cur ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[12rem] flex-1">
            <p className="text-sm font-medium">
              {t.s3.planLine(cur.gb, t.s3.copiesLabel(cur.replicas))}
            </p>
            <p className={cn('text-xs', cur.lapsed ? 'text-amber-800' : 'text-[var(--fg-muted)]')}>
              {cur.lapsed
                ? t.s3.endedOn(formatDate(cur.periodEnd))
                : t.s3.activeUntil(formatDate(cur.periodEnd))}
            </p>
            {cur.next && (
              <p className="text-xs text-[var(--fg-muted)]">
                {t.s3.nextPlan(
                  t.s3.planLine(cur.next.gb, t.s3.copiesLabel(cur.next.replicas)),
                  formatDate(cur.periodEnd),
                )}
              </p>
            )}
          </div>
          {cur.renewIdr !== null && (
            <Button
              className="h-9 px-4"
              disabled={checkout.busy}
              onClick={() =>
                checkout.ask(t.s3.renewTitle, t.s3.renewBody(formatRupiah(cur.renewIdr!)), {
                  kind: 's3_renew',
                })
              }
            >
              {t.s3.renew(formatRupiah(cur.renewIdr))}
            </Button>
          )}
          <Button variant="secondary" className="h-9 px-3" onClick={() => setChanging((v) => !v)}>
            {t.s3.change}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-[12rem] flex-1 text-sm">{t.s3.granted}</p>
          <Button variant="secondary" className="h-9 px-3" onClick={() => setChanging((v) => !v)}>
            {t.s3.change}
          </Button>
        </div>
      )}
      {plan.egress.billable && (
        <p className="mt-3 rounded-xl bg-[var(--bg-subtle)] px-3 py-2 text-sm">
          {t.s3.egressNow(formatBytes(plan.egress.bytes), formatBytes(p.egressFreeBytes))}
          {plan.egress.pendingIdr > 0 &&
            ` · ${t.s3.egressPending(formatRupiah(plan.egress.pendingIdr))}`}
        </p>
      )}
      {changing && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <PriceNotes p={p} />
          <div className="mt-3">
            <PlanForm
              prices={p}
              initial={{
                gb: Math.max(p.minGb, cur?.gb ?? 10),
                replicas: cur?.replicas ?? 1,
              }}
              action={() => t.s3.change}
              disabled={checkout.busy}
              onSubmit={change}
            />
          </div>
        </div>
      )}
      {checkout.ui}
    </Section>
  );
}

/** The account's own address (ADR-048): what it is and its DNS, or buying one. */
function UrlSection({
  url,
  options,
  canBuy,
  onChanged,
}: {
  url: S3Url | null;
  options: S3UrlOptions;
  canBuy: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const checkout = useCheckout();
  const [type, setType] = useState<'zeiko' | 'custom'>(
    options.zeiko.available ? 'zeiko' : 'custom',
  );
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [releasing, setReleasing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!url && !(options.zeiko.available || options.custom.available)) return null;
  const zeikoHost = `s3.${name.trim().toLowerCase() || '…'}.${options.zeiko.suffix ?? ''}`;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      await onChanged();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const buy = (e: FormEvent) => {
    e.preventDefault();
    const zeiko = type === 'zeiko';
    const host = zeiko ? zeikoHost : hostname.trim().toLowerCase();
    const price = formatRupiah(zeiko ? options.zeiko.priceIdr : options.custom.priceIdr);
    checkout.ask(t.s3.urlBuyTitle, t.s3.urlBuyBody(host, price), {
      kind: 's3_url',
      url: zeiko ? { type: 'zeiko', name: name.trim() } : { type: 'custom', hostname: host },
    });
  };

  return (
    <Section
      id="s3-url"
      title={t.s3.urlTitle}
      icon={<Globe className="h-4 w-4" aria-hidden="true" />}
    >
      {url ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[12rem] flex-1">
              <CopyField label={url.hostname} value={url.url} wrap />
            </div>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px]',
                url.status === 'active'
                  ? 'bg-[var(--bg-subtle)] text-[var(--fg-muted)]'
                  : 'bg-amber-100 text-amber-900',
              )}
            >
              {t.s3.urlStatus[url.status]}
            </span>
          </div>
          {url.status !== 'active' && url.records.length > 0 && (
            <div className="text-sm">
              <p>{t.s3.urlDns}</p>
              <ul className="mt-1 space-y-1">
                {url.records.map((r) => (
                  <li key={`${r.type}${r.name}`}>
                    <code className="break-all text-xs">
                      {r.type} {r.name} → {r.value}
                    </code>
                  </li>
                ))}
              </ul>
              {url.error && <p className="mt-1 text-xs text-[var(--fg-muted)]">{url.error}</p>}
              <Button
                variant="secondary"
                className="mt-2 h-9 px-3"
                disabled={busy}
                onClick={() => void act(() => postJson('/api/s3/url/check', {}))}
              >
                {t.s3.urlCheck}
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            className="h-9 px-3 text-red-700"
            disabled={busy}
            onClick={() => setReleasing(true)}
          >
            {t.s3.urlRemove}
          </Button>
        </div>
      ) : canBuy ? (
        <form className="space-y-3" onSubmit={buy}>
          <p className="text-sm text-[var(--fg-muted)]">{t.s3.urlIntro(options.releaseDays)}</p>
          <fieldset className="space-y-1">
            {options.zeiko.available && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="url-type"
                  checked={type === 'zeiko'}
                  onChange={() => setType('zeiko')}
                />
                {t.s3.urlZeiko(formatRupiah(options.zeiko.priceIdr))}
              </label>
            )}
            {options.custom.available && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="url-type"
                  checked={type === 'custom'}
                  onChange={() => setType('custom')}
                />
                {t.s3.urlCustom(formatRupiah(options.custom.priceIdr))}
              </label>
            )}
          </fieldset>
          {type === 'zeiko' ? (
            <label className="block">
              <span className="text-sm font-medium">{t.s3.urlName}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={3}
                maxLength={32}
                pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
                aria-describedby="s3-url-hint"
                className="mt-1 h-10 w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-sm"
              />
              <span id="s3-url-hint" className="mt-1 block text-xs text-[var(--fg-muted)]">
                {t.s3.urlNameHint} {t.s3.urlPreview(zeikoHost)}
              </span>
            </label>
          ) : (
            <label className="block">
              <span className="text-sm font-medium">{t.s3.urlHostname}</span>
              <input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                required
                maxLength={253}
                placeholder="s3.tokobudi.com"
                aria-describedby="s3-url-hint"
                className="mt-1 h-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-sm"
              />
              <span id="s3-url-hint" className="mt-1 block text-xs text-[var(--fg-muted)]">
                {t.s3.urlHostnameHint(options.custom.cnameTarget ?? '')}
              </span>
            </label>
          )}
          <Button type="submit" className="h-9 px-4" disabled={checkout.busy}>
            {t.s3.urlBuy(
              formatRupiah(type === 'zeiko' ? options.zeiko.priceIdr : options.custom.priceIdr),
            )}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-[var(--fg-muted)]">{t.s3.urlNeedsPlan}</p>
      )}
      <Dialog
        open={releasing}
        title={t.s3.urlRemoveTitle}
        onClose={() => setReleasing(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReleasing(false)}>
              {t.common.cancel}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setReleasing(false);
                void act(() => sendJson('DELETE', '/api/s3/url'), t.s3.urlRemoved);
              }}
            >
              {t.s3.urlRemove}
            </Button>
          </>
        }
      >
        <p className="text-sm">{url ? t.s3.urlRemoveBody(url.hostname) : ''}</p>
      </Dialog>
      {checkout.ui}
    </Section>
  );
}

/** Hidden until Zeiko S3 works here (ADR-049). */
export function S3() {
  const catalog = useCatalog();
  if (catalog.data && !catalog.data.capabilities?.s3) return <NotFound />;
  return <S3Page />;
}

function S3Page() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUERY, queryFn: () => api<S3Overview>('/api/s3') });
  const [naming, setNaming] = useState(false);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [corsFor, setCorsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY });

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      await refresh();
      return true;
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createKey(label: string) {
    setNaming(false);
    await run(async () => {
      const r = await postJson<{ key: { id: string; secret: string } }>('/api/s3/keys', { label });
      setCreated({ id: r.key.id, secret: r.key.secret });
    });
  }

  async function createBucket(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const ok = await run(() =>
      postJson('/api/s3/buckets', {
        name: String(data.get('name') ?? '').trim(),
        public: data.get('public') === 'on',
      }),
    );
    if (ok) form.reset();
  }

  const header = (
    <>
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Database className="h-5 w-5" aria-hidden="true" />
        {t.s3.title}
      </h1>
      <p className="text-sm text-[var(--fg-muted)]">{t.s3.intro}</p>
    </>
  );

  if (q.isPending) return <p className="p-6 text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (q.isError || !q.data)
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {t.errors.generic}
        </p>
      </div>
    );
  const d = q.data;
  const terms = (
    <p className="text-xs text-[var(--fg-muted)]">
      {t.s3.termsBefore}
      <Link to="/kebijakan/$slug" params={{ slug: 'syarat' }} className="underline">
        {t.s3.terms}
      </Link>
      {t.s3.termsAnd}
      <Link to="/kebijakan/$slug" params={{ slug: 'privasi' }} className="underline">
        {t.s3.privacy}
      </Link>
      .
    </p>
  );

  if (!d.configured || !d.enabled || !d.account || !d.endpoint)
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {header}
        {d.configured && d.plan ? (
          <BuyCard plan={d.plan} />
        ) : (
          <div className={card}>
            <p className="text-sm">{t.s3.notAvailable}</p>
          </div>
        )}
        {terms}
      </div>
    );

  const acc = d.account;
  const suspended = acc.status !== 'active';
  const pct = acc.limitBytes
    ? Math.min(100, ((acc.usedBytes + acc.reservedBytes) / acc.limitBytes) * 100)
    : 100;
  const endpoint = d.endpoint;
  const exampleKey = d.keys[0]?.id ?? 'ZK…';

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      {header}
      {suspended && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {t.s3.suspended(OPERATOR_EMAIL)}
        </p>
      )}
      {!suspended && acc.billingState !== 'ok' && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {acc.billingState === 'locked' ? t.s3.lockedBanner : t.s3.readonlyBanner}
        </p>
      )}

      <Section
        id="s3-conn"
        title={t.s3.connection}
        icon={<Globe className="h-4 w-4" aria-hidden="true" />}
      >
        <div className="grid gap-3 md:grid-cols-[1fr_10rem]">
          <CopyField label={t.s3.endpoint} value={endpoint} />
          <CopyField label={t.s3.region} value={d.region} />
        </div>
        <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.s3.pathStyle}</p>
        <div className="mt-4">
          <p className="text-sm text-[var(--fg-muted)]">{t.s3.storage}</p>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--bg-subtle)]"
            role="presentation"
          >
            <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-sm">
            {t.s3.storageOf(formatBytes(acc.usedBytes), formatBytes(acc.limitBytes))}
          </p>
        </div>
      </Section>

      {d.plan && <PlanSection plan={d.plan} />}
      {d.urlOptions && (
        <UrlSection
          url={d.url}
          options={d.urlOptions}
          canBuy={Boolean(d.plan?.plan && !d.plan.plan.lapsed)}
          onChanged={refresh}
        />
      )}

      <Section
        id="s3-keys"
        title={t.s3.keys}
        icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
        action={
          <Button
            variant="secondary"
            className="h-9 px-3"
            disabled={busy || suspended}
            onClick={() => setNaming(true)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> {t.s3.newKey}
          </Button>
        }
      >
        <p className="text-sm text-[var(--fg-muted)]">{t.s3.keysHint}</p>
        {d.keys.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.s3.noKeys}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {d.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <code className="text-sm">{k.id}</code>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {[
                      k.label,
                      t.s3.created(formatDate(k.createdAt)),
                      k.lastUsedAt ? t.s3.lastUsed(formatDate(k.lastUsedAt)) : t.s3.neverUsed,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="h-9 px-3 text-red-600"
                  disabled={busy}
                  onClick={() => setRevoking(k.id)}
                >
                  {t.s3.revoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="s3-buckets"
        title={t.s3.buckets}
        icon={<Database className="h-4 w-4" aria-hidden="true" />}
      >
        {d.buckets.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">{t.s3.noBuckets}</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d.buckets.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-[12rem] flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {b.public ? (
                      <Globe className="h-4 w-4 shrink-0 text-brand-700" aria-hidden="true" />
                    ) : (
                      <Lock
                        className="h-4 w-4 shrink-0 text-[var(--fg-muted)]"
                        aria-hidden="true"
                      />
                    )}
                    {b.name}
                    <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                      {b.blocked ? t.s3.blocked : b.public ? t.s3.public : t.s3.private}
                    </span>
                    {b.cors && (
                      <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                        {t.s3.corsOn}
                      </span>
                    )}
                  </p>
                  {b.public && (
                    <p className="mt-0.5 truncate text-xs text-[var(--fg-muted)]">
                      {t.s3.publicUrl}: {endpoint}/{b.name}/…
                    </p>
                  )}
                </div>
                <Button
                  variant={browsing === b.name ? 'primary' : 'secondary'}
                  className="h-9 px-3"
                  disabled={suspended || acc.billingState === 'locked'}
                  onClick={() => setBrowsing(browsing === b.name ? null : b.name)}
                >
                  <FolderOpen className="h-4 w-4" aria-hidden="true" /> {t.s3.browse}
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 px-3"
                  disabled={busy || suspended}
                  onClick={() => setCorsFor(b.name)}
                  aria-label={`${t.s3.cors} ${b.name}`}
                  title={t.s3.cors}
                >
                  <Share2 className="h-4 w-4" aria-hidden="true" /> {t.s3.cors}
                </Button>
                {!b.blocked && (
                  <Button
                    variant="secondary"
                    className="h-9 px-3"
                    disabled={busy || suspended}
                    onClick={() =>
                      void run(() =>
                        sendJson('PATCH', `/api/s3/buckets/${encodeURIComponent(b.name)}`, {
                          public: !b.public,
                        }),
                      )
                    }
                  >
                    {b.public ? t.s3.makePrivate : t.s3.makePublic}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="h-9 px-3"
                  disabled={busy || suspended}
                  onClick={() => setDeleting(b.name)}
                  aria-label={`${t.s3.deleteBucket} ${b.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={(e) => void createBucket(e)}
          className="mt-4 space-y-2 border-t border-[var(--border)] pt-4"
        >
          <label className="block text-sm font-medium" htmlFor="s3-bucket-name">
            {t.s3.bucketName}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="s3-bucket-name"
              name="name"
              required
              minLength={3}
              maxLength={63}
              pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]"
              autoCapitalize="none"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500"
              aria-describedby="s3-bucket-hint"
            />
            <Button type="submit" disabled={busy || suspended}>
              {t.s3.newBucket}
            </Button>
          </div>
          <p id="s3-bucket-hint" className="text-xs text-[var(--fg-muted)]">
            {t.s3.bucketNameHint}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="public" className="mt-1" />
            <span>
              {t.s3.publicBucket}
              <span className="block text-xs text-[var(--fg-muted)]">{t.s3.publicHint}</span>
            </span>
          </label>
        </form>
      </Section>

      {browsing && d.buckets.some((b) => b.name === browsing) && (
        <S3Browser
          key={browsing}
          bucket={browsing}
          canWrite={!suspended && acc.billingState === 'ok'}
          hasKey={d.keys.length > 0}
          onClose={() => setBrowsing(null)}
        />
      )}

      <Section
        id="s3-howto"
        title={t.s3.howTo}
        icon={<Database className="h-4 w-4" aria-hidden="true" />}
      >
        <p className="text-xs font-medium text-[var(--fg-muted)]">aws-cli</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs">
          {`aws configure set aws_access_key_id ${exampleKey}
aws configure set aws_secret_access_key <secret>
aws configure set region ${d.region}
aws s3 ls --endpoint-url ${endpoint}`}
        </pre>
        <p className="mt-3 text-xs font-medium text-[var(--fg-muted)]">rclone</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs">
          {`[zeiko]
type = s3
provider = Other
access_key_id = ${exampleKey}
secret_access_key = <secret>
endpoint = ${endpoint}
region = ${d.region}
force_path_style = true`}
        </pre>
        <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.s3.limits}</p>
      </Section>

      {terms}

      <PromptDialog
        open={naming}
        title={t.s3.keyLabel}
        initial=""
        confirmLabel={t.s3.newKey}
        onCancel={() => setNaming(false)}
        onSubmit={(label) => void createKey(label)}
      />
      <Dialog open={created !== null} title={t.s3.keyCreatedTitle} onClose={() => setCreated(null)}>
        {created && (
          <div className="space-y-3">
            <p className="text-amber-800">{t.s3.keyCreatedBody}</p>
            <CopyField label={t.s3.accessKeyId} value={created.id} wrap />
            <CopyField label={t.s3.secretKey} value={created.secret} wrap />
          </div>
        )}
      </Dialog>
      <Dialog
        open={revoking !== null}
        title={t.s3.revokeTitle}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = revoking!;
                setRevoking(null);
                void run(
                  () => sendJson('DELETE', `/api/s3/keys/${encodeURIComponent(id)}`),
                  t.s3.revoked,
                );
              }}
            >
              {t.s3.revoke}
            </Button>
          </>
        }
      >
        {revoking && <p>{t.s3.revokeBody(revoking)}</p>}
      </Dialog>
      <Dialog
        open={deleting !== null}
        title={t.s3.deleteTitle}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const name = deleting!;
                setDeleting(null);
                void run(
                  () => sendJson('DELETE', `/api/s3/buckets/${encodeURIComponent(name)}`),
                  t.s3.deleted,
                );
              }}
            >
              {t.s3.deleteBucket}
            </Button>
          </>
        }
      >
        {deleting && <p>{t.s3.deleteBody(deleting)}</p>}
      </Dialog>
      {corsFor && d.buckets.some((b) => b.name === corsFor) && (
        <CorsDialog
          bucket={d.buckets.find((b) => b.name === corsFor)!}
          onClose={() => setCorsFor(null)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}
