// Settings → Webhooks (A6, ADR-094): endpoints that get Drive events (and S3 events their buckets
// point at them), the signing secret shown once, and each endpoint's deliveries of the last 7 days.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime } from '../../shared/format';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import { Button } from './Button';
import { Dialog } from './ui/Dialog';
import { toast } from './ui/Toast';

export interface WebhookDto {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  enabled: boolean;
  disabledReason: string | null;
  failures: number;
  lastSuccessAt: number | null;
  createdAt: number;
}

export interface DeliveryDto {
  id: string;
  webhookId: string;
  event: string;
  count: number;
  status: 'pending' | 'ok' | 'retrying' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: number;
}

export const webhooksKey = ['webhooks'];

export const fetchWebhooks = () => api<{ items: WebhookDto[]; events: string[] }>('/api/webhooks');

const send = (path: string, method: string, body?: unknown) =>
  api<unknown>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.data as { reason?: string } | undefined)?.reason;
    if (reason && reason in t.webhooks.urlErrors)
      return t.webhooks.urlErrors[reason as keyof typeof t.webhooks.urlErrors];
    if (reason === 'WEBHOOK_LIMIT') return t.webhooks.limit;
    return e.message || t.errors.generic;
  }
  return t.errors.generic;
}

const STATUS_TONE: Record<DeliveryDto['status'], string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  pending: 'text-[var(--fg-muted)]',
  retrying: 'text-amber-700 dark:text-amber-400',
  failed: 'text-red-600',
};

/** One endpoint's (or all S3) deliveries of the last 7 days. */
export function DeliveryList({ webhookId, s3 }: { webhookId?: string; s3?: boolean }) {
  const q = useQuery({
    queryKey: ['webhook-deliveries', webhookId ?? '', s3 ? 1 : 0],
    queryFn: () =>
      api<{ items: DeliveryDto[] }>(
        `/api/webhooks/deliveries?${new URLSearchParams({
          ...(webhookId ? { webhookId } : {}),
          ...(s3 ? { s3: '1' } : {}),
          limit: '20',
        })}`,
      ),
  });
  const items = q.data?.items ?? [];
  if (q.isPending) return <p className="text-xs text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (!items.length)
    return <p className="text-xs text-[var(--fg-muted)]">{t.webhooks.noDeliveries}</p>;
  return (
    <ul className="divide-y divide-[var(--border)] text-xs">
      {items.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
          <span className="font-mono">{d.event}</span>
          {d.count > 1 && <span className="text-[var(--fg-muted)]">+{d.count - 1}</span>}
          <span className={cn('font-medium', STATUS_TONE[d.status])}>
            {t.webhooks.status[d.status]}
            {d.responseStatus ? ` · ${d.responseStatus}` : ''}
          </span>
          {d.error && d.status !== 'ok' && (
            <span className="min-w-0 truncate text-[var(--fg-muted)]" title={d.error}>
              {d.error}
            </span>
          )}
          <span className="ml-auto tabular-nums text-[var(--fg-muted)]">
            {formatDateTime(d.createdAt)}
            {d.attempts > 1 && ` · ${t.webhooks.attempts(d.attempts)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SecretBox({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      title={t.webhooks.secretTitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t.common.close}</Button>}
    >
      <p className="text-sm">{t.webhooks.secretBody}</p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--bg-subtle)] px-3 py-2 font-mono text-sm">
          {secret}
        </code>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-sm text-brand-700 hover:bg-[var(--bg-subtle)] dark:text-brand-300"
          onClick={() =>
            void navigator.clipboard?.writeText(secret).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? t.webdav.copied : t.webdav.copy}
        </button>
      </div>
      <p className="mt-3 text-xs text-[var(--fg-muted)]">{t.webhooks.verifyHint}</p>
    </Dialog>
  );
}

export function WebhookSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: webhooksKey, queryFn: fetchWebhooks });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['drive.file.uploaded']);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: webhooksKey });
  const all = q.data?.events ?? [];
  async function create() {
    setBusy(true);
    try {
      const r = (await send('/api/webhooks', 'POST', { url, events })) as { secret: string };
      setSecret(r.secret);
      setAdding(false);
      setUrl('');
      refresh();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast(done);
      refresh();
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }
  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="webhook">
      <h2 id="webhook" className="flex items-center gap-2 font-medium">
        <Webhook className="h-4 w-4 text-brand-600" aria-hidden="true" /> {t.webhooks.title}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.webhooks.intro}</p>
      <ul className="mt-3 space-y-3">
        {(q.data?.items ?? []).map((h) => (
          <li key={h.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{h.url}</span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs',
                  h.enabled
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-200',
                )}
              >
                {h.enabled
                  ? t.webhooks.on
                  : h.disabledReason === 'failing'
                    ? t.webhooks.offFailing
                    : t.webhooks.off}
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {h.events.length
                ? h.events
                    .map((e) => t.webhooks.eventNames[e as keyof typeof t.webhooks.eventNames] ?? e)
                    .join(', ')
                : t.webhooks.s3Only}
            </p>
            <p className="mt-0.5 font-mono text-[11px] break-all text-[var(--fg-muted)]">
              arn:zeiko:webhook:::{h.id}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="h-8 px-3 text-xs"
                onClick={() =>
                  void act(() => send(`/api/webhooks/${h.id}/test`, 'POST'), t.webhooks.testSent)
                }
                disabled={!h.enabled}
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" /> {t.webhooks.test}
              </Button>
              <Button
                variant="ghost"
                className="h-8 px-3 text-xs"
                onClick={() =>
                  void act(() => send(`/api/webhooks/${h.id}`, 'PATCH', { enabled: !h.enabled }))
                }
              >
                {h.enabled ? t.webhooks.turnOff : t.webhooks.turnOn}
              </Button>
              <Button
                variant="ghost"
                className="h-8 px-3 text-xs"
                onClick={() =>
                  void send(`/api/webhooks/${h.id}/rotate`, 'POST')
                    .then((r) => setSecret((r as { secret: string }).secret))
                    .catch((e: unknown) => toast(errorText(e), { tone: 'error' }))
                }
              >
                {t.webhooks.rotate}
              </Button>
              <Button
                variant="ghost"
                className="h-8 px-3 text-xs"
                onClick={() => setOpen(open === h.id ? null : h.id)}
              >
                {t.webhooks.deliveries}
              </Button>
              <Button
                variant="ghost"
                className="ml-auto h-8 px-3 text-xs text-red-600"
                onClick={() =>
                  void act(() => send(`/api/webhooks/${h.id}`, 'DELETE'), t.webhooks.deleted)
                }
                aria-label={t.webhooks.delete}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            {open === h.id && (
              <div className="mt-2 rounded-lg bg-[var(--bg-subtle)] p-2">
                <DeliveryList webhookId={h.id} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="mt-3 rounded-xl border border-[var(--border)] p-3">
          <label className="block text-sm">
            {t.webhooks.url}
            <input
              autoFocus
              type="url"
              inputMode="url"
              placeholder="https://contoh.id/zeiko-webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 font-mono text-sm outline-none focus:border-brand-500"
            />
          </label>
          <fieldset className="mt-3 text-sm">
            <legend className="text-[var(--fg-muted)]">{t.webhooks.events}</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {all.map((e) => (
                <label key={e} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={events.includes(e)}
                    onChange={() =>
                      setEvents((v) => (v.includes(e) ? v.filter((x) => x !== e) : [...v, e]))
                    }
                  />
                  {t.webhooks.eventNames[e as keyof typeof t.webhooks.eventNames] ?? e}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.webhooks.s3Hint}</p>
          </fieldset>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={busy || !url.trim()} onClick={() => void create()}>
              {t.webhooks.add}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" className="mt-3 h-9 px-3" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {t.webhooks.add}
        </Button>
      )}
      {secret && <SecretBox secret={secret} onClose={() => setSecret(null)} />}
    </section>
  );
}
