// Settings → Tokens & apps (ADR-061): make an access token for the public API, see when each was
// last used, revoke. The secret is shown once, right after it is made.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { formatDate } from '../../shared/format';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { t } from '../lib/i18n';
import { Button } from './Button';
import { Dialog } from './ui/Dialog';
import { toast } from './ui/Toast';

const SCOPES = ['drive.read', 'drive.write', 'share', 'webdav', 's3.manage'] as const;
type Scope = (typeof SCOPES)[number];
const EXPIRY = [
  ['d30', 30],
  ['d90', 90],
  ['d365', 365],
  ['never', null],
] as const;

interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

const input =
  'h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500';

export function AccessTokens() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['tokens'],
    queryFn: () => api<{ tokens: TokenInfo[] }>('/api/tokens'),
  });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['drive.read']);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number][0]>('d90');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens'] });

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const made = await postJson<{ token: string }>('/api/tokens', {
        name: name.trim(),
        scopes,
        expiresInDays: EXPIRY.find(([k]) => k === expiry)![1],
      });
      setSecret(made.token);
      setName('');
      await refresh();
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'CONFLICT' ? t.tokens.tooMany : t.errors.generic,
        { tone: 'error' },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="token-akses">
      <h2 id="token-akses" className="flex items-center gap-2 font-medium">
        <KeyRound className="h-4 w-4" aria-hidden="true" /> {t.tokens.title}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.tokens.intro}</p>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.tokens.signOutNote}</p>
      <Link
        to="/developer"
        className="mt-2 inline-block text-sm text-brand-700 underline dark:text-brand-300"
      >
        {t.apiDocs.docsLink}
      </Link>

      {q.data && q.data.tokens.length > 0 ? (
        <ul className="mt-3 divide-y divide-[var(--border)]">
          {q.data.tokens.map((tk) => (
            <li key={tk.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{tk.name}</p>
                <p className="font-mono text-xs text-[var(--fg-muted)]">{tk.prefix}…</p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                  {tk.scopes.map((s) => t.tokens.scope[s]).join(' · ')}
                </p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                  {tk.lastUsedAt
                    ? t.tokens.lastUsed(formatDate(tk.lastUsedAt))
                    : t.tokens.neverUsed}
                  {' · '}
                  {tk.expiresAt ? t.tokens.expiresOn(formatDate(tk.expiresAt)) : t.tokens.noExpiry}
                </p>
              </div>
              <Button
                variant="ghost"
                className="h-9 px-3 text-red-600"
                onClick={() => setRevoking(tk)}
                aria-label={`${t.tokens.revoke} ${tk.name}`}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        q.data && <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.tokens.empty}</p>
      )}

      <form
        onSubmit={(e) => void create(e)}
        className="mt-4 space-y-3 border-t border-[var(--border)] pt-4"
      >
        <label className="block text-xs text-[var(--fg-muted)]">
          {t.tokens.name}
          <input
            className={`${input} mt-1`}
            value={name}
            maxLength={80}
            placeholder={t.tokens.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset>
          <legend className="text-xs text-[var(--fg-muted)]">{t.tokens.scopes}</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes((cur) =>
                      e.target.checked ? [...cur, s] : cur.filter((x) => x !== s),
                    )
                  }
                />
                <span>
                  {t.tokens.scope[s]}
                  <span className="block font-mono text-[11px] text-[var(--fg-muted)]">{s}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-xs text-[var(--fg-muted)]">
          {t.tokens.expires}
          <select
            className={`${input} mt-1`}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as typeof expiry)}
          >
            {EXPIRY.map(([k]) => (
              <option key={k} value={k}>
                {t.tokens.expiry[k]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
          {t.tokens.create}
        </Button>
      </form>

      <Dialog
        open={secret !== null}
        title={t.tokens.created}
        onClose={() => setSecret(null)}
        footer={<Button onClick={() => setSecret(null)}>{t.tokens.done}</Button>}
      >
        <p className="text-sm text-[var(--fg-muted)]">{t.tokens.copyNow}</p>
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            className={`${input} font-mono text-xs`}
            value={secret ?? ''}
            aria-label={t.tokens.title}
            onFocus={(e) => e.target.select()}
          />
          <Button
            variant="secondary"
            aria-label={t.tokens.copy}
            onClick={() =>
              void navigator.clipboard
                .writeText(secret ?? '')
                .then(() => toast(t.tokens.copied))
                .catch(() => toast(t.errors.generic, { tone: 'error' }))
            }
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={revoking !== null}
        title={revoking ? t.tokens.revokeTitle(revoking.name) : ''}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const tk = revoking;
                setRevoking(null);
                if (!tk) return;
                void sendJson('DELETE', `/api/tokens/${tk.id}`)
                  .then(() => {
                    toast(t.tokens.revoked);
                    return refresh();
                  })
                  .catch(() => toast(t.errors.generic, { tone: 'error' }));
              }}
            >
              {t.tokens.revoke}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t.tokens.revokeBody}</p>
      </Dialog>
    </section>
  );
}
