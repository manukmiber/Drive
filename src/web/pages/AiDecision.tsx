import { useQuery } from '@tanstack/react-query';
import { Brain, Copy, Eye, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '../../shared/format';
import { Button } from '../components/Button';
import { toast } from '../components/ui/Toast';
import { t } from '../lib/i18n';
import { door, sitePage, zeikoConfig } from '../lib/zeiko';

const card = 'z-card rounded-2xl p-5';
const linkBtn =
  'inline-flex h-9 items-center rounded-full border border-[var(--border)] px-4 text-sm font-medium hover:bg-[var(--bg-subtle)]';

/** What the door's /v1/account says, as far as this page reads it. */
interface DoorAccount {
  plan?: { name?: string; paygo?: boolean; requests?: number; expiresAt?: number | null };
  usage?: { used: number; amount: number; resetsAt: number } | null;
  balance?: { text?: string };
  key?: { masked?: string; enabled?: boolean } | null;
  chat?: { planName?: string } | null;
}

/**
 * The other Zeiko products, in the same dashboard (ADR-036): Pranata V1's plan, what is left of it,
 * the dollar balance and the key — read straight from the Zeiko Accounts door with this browser's
 * own session. Buying and rotating stay on the website's account pages.
 */
export function AiDecision() {
  const [shown, setShown] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['zeiko-account'],
    queryFn: async () => {
      const [r, cfg, plans, key, docs] = await Promise.all([
        door('GET', '/account'),
        zeikoConfig(),
        sitePage('plans'),
        sitePage('key'),
        zeikoConfig().then((c) => (c.siteUrl ? `${c.siteUrl.replace(/\/+$/, '')}/docs/` : null)),
      ]);
      if (r.status !== 200 || !r.data) throw new Error(String(r.status));
      return { a: r.data as DoorAccount, chatUrl: cfg.chatUrl, plans, key, docs };
    },
    retry: false,
  });

  async function reveal() {
    const r = await door('GET', '/key');
    if (r.status === 200 && typeof r.data?.key === 'string') setShown(r.data.key);
    else toast(t.ai.unavailable, { tone: 'error' });
  }

  if (q.isPending) return <p className="p-6 text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (q.isError || !q.data)
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {t.ai.unavailable}
        </p>
      </div>
    );
  const { a, chatUrl, plans, key, docs } = q.data;
  const u = a.usage;
  const left = u ? Math.max(0, u.amount - u.used) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Brain className="h-5 w-5" aria-hidden="true" />
        {t.ai.title}
      </h1>
      <p className="text-sm text-[var(--fg-muted)]">{t.ai.intro}</p>

      <section className={card} aria-labelledby="ai-plan">
        <h2 id="ai-plan" className="text-sm text-[var(--fg-muted)]">
          {t.ai.plan}
        </h2>
        <p className="mt-1 text-lg font-semibold">{a.plan?.name ?? t.ai.noPlan}</p>
        {a.plan?.expiresAt ? (
          <p className="text-sm text-[var(--fg-muted)]">{t.ai.endsOn(formatDate(a.plan.expiresAt))}</p>
        ) : null}
        {u && left !== null && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
              <div
                className="h-full bg-brand-600"
                style={{ width: `${u.amount ? Math.min(100, (left / u.amount) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-1 text-sm">{t.ai.requestsLeft(left.toLocaleString())}</p>
          </div>
        )}
        <p className="mt-3 text-sm">
          {t.ai.balance}: <strong>{a.balance?.text ?? '$0'}</strong>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {plans && (
            <a href={plans} className={linkBtn}>
              {t.ai.buy}
            </a>
          )}
          {docs && (
            <a href={docs} className={linkBtn}>
              {t.ai.docs}
            </a>
          )}
        </div>
      </section>

      <section className={card} aria-labelledby="ai-key">
        <h2 id="ai-key" className="font-medium">
          {t.ai.key}
        </h2>
        {a.key ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--bg-subtle)] px-3 py-2 text-sm">
              {shown ?? a.key.masked}
            </code>
            {shown ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(shown).then(() => toast(t.ai.copied));
                }}
              >
                <Copy className="h-4 w-4" aria-hidden="true" /> {t.ai.copy}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void reveal()}>
                <Eye className="h-4 w-4" aria-hidden="true" /> {t.ai.reveal}
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">{t.ai.noKey}</p>
        )}
        {key && (
          <a href={key} className={`${linkBtn} mt-3`}>
            {t.ai.manageKey}
          </a>
        )}
      </section>

      <section className={card} aria-labelledby="ai-chat">
        <h2 id="ai-chat" className="flex items-center gap-2 font-medium">
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          {t.ai.chatTitle}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.ai.chatBody}</p>
        {a.chat?.planName && <p className="mt-2 text-sm">{t.ai.chatPlan(a.chat.planName)}</p>}
        <a href={chatUrl} className={`${linkBtn} mt-3`} rel="noopener">
          {t.ai.openChat}
        </a>
      </section>
    </div>
  );
}
