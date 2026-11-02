// /s3 → a bucket's event notifications (A6, ADR-094): which webhook hears about objects created or
// removed, with an optional prefix and suffix, and the S3 deliveries of the last 7 days.
import { useQuery } from '@tanstack/react-query';
import { Bell, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { t } from '../lib/i18n';
import { Button } from './Button';
import { toast } from './ui/Toast';
import { DeliveryList, fetchWebhooks, webhooksKey } from './WebhookSettings';

export interface NotificationRuleDto {
  id: string;
  webhookId: string;
  events: string[];
  prefix?: string;
  suffix?: string;
}

const CREATED = 's3:ObjectCreated:*';
const REMOVED = 's3:ObjectRemoved:*';

export function S3Notifications({
  bucket,
  rules,
  canWrite,
  onSaved,
}: {
  bucket: string;
  rules: NotificationRuleDto[];
  canWrite: boolean;
  onSaved: () => void;
}) {
  const hooks = useQuery({ queryKey: webhooksKey, queryFn: fetchWebhooks });
  const [adding, setAdding] = useState(false);
  const [hook, setHook] = useState('');
  const [events, setEvents] = useState<string[]>([CREATED]);
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const [showLog, setShowLog] = useState(false);
  const urlOf = (id: string) => hooks.data?.items.find((h) => h.id === id)?.url ?? id;
  async function save(next: NotificationRuleDto[]) {
    try {
      await api(`/api/s3/buckets/${encodeURIComponent(bucket)}/notifications`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: next }),
      });
      toast(t.webhooks.saved);
      setAdding(false);
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t.errors.generic, { tone: 'error' });
    }
  }
  const first = hooks.data?.items[0]?.id ?? '';
  return (
    <div className="mt-3 rounded-xl bg-[var(--bg-subtle)] px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Bell className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
        <span className="font-medium">{t.webhooks.bucketTitle}</span>
        <button
          type="button"
          className="ml-auto text-xs text-brand-700 hover:underline dark:text-brand-300"
          onClick={() => setShowLog((v) => !v)}
        >
          {t.webhooks.deliveries}
        </button>
      </div>
      <p className="mt-0.5 text-xs text-[var(--fg-muted)]">{t.webhooks.bucketIntro}</p>
      {rules.length ? (
        <ul className="mt-2 space-y-1">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono">{urlOf(r.webhookId)}</span>
                {' · '}
                {r.events
                  .map((e) =>
                    e === CREATED ? t.webhooks.created : e === REMOVED ? t.webhooks.removed : e,
                  )
                  .join(', ')}
                {r.prefix && ` · ${r.prefix}*`}
                {r.suffix && ` · *${r.suffix}`}
              </span>
              <button
                type="button"
                className="rounded-full p-1 text-red-600 hover:bg-[var(--bg)] disabled:opacity-40"
                disabled={!canWrite}
                aria-label={t.webhooks.remove}
                onClick={() => void save(rules.filter((x) => x.id !== r.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.webhooks.bucketNone}</p>
      )}
      {adding ? (
        hooks.data?.items.length ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select
              aria-label={t.webhooks.title}
              value={hook || first}
              onChange={(e) => setHook(e.target.value)}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-xs sm:col-span-2"
            >
              {hooks.data.items.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.url}
                </option>
              ))}
            </select>
            {[
              [CREATED, t.webhooks.created],
              [REMOVED, t.webhooks.removed],
            ].map(([e, label]) => (
              <label key={e} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={events.includes(e!)}
                  onChange={() =>
                    setEvents((v) => (v.includes(e!) ? v.filter((x) => x !== e) : [...v, e!]))
                  }
                />
                {label}
              </label>
            ))}
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={t.webhooks.prefix}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-xs"
            />
            <input
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
              placeholder={t.webhooks.suffix}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-xs"
            />
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setAdding(false)}>
                {t.common.cancel}
              </Button>
              <Button
                className="h-8 px-3 text-xs"
                disabled={!events.length}
                onClick={() =>
                  void save([
                    ...rules,
                    {
                      id: `rule-${Date.now().toString(36)}`,
                      webhookId: hook || first,
                      events,
                      ...(prefix ? { prefix } : {}),
                      ...(suffix ? { suffix } : {}),
                    },
                  ])
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-xs text-amber-700">{t.webhooks.bucketNeedHook}</p>
        )
      ) : (
        <Button
          variant="secondary"
          className="mt-2 h-8 px-3 text-xs"
          disabled={!canWrite}
          onClick={() => setAdding(true)}
        >
          {t.webhooks.bucketAdd}
        </Button>
      )}
      {showLog && (
        <div className="mt-2 rounded-lg bg-[var(--bg)] p-2">
          <DeliveryList s3 />
        </div>
      )}
    </div>
  );
}
