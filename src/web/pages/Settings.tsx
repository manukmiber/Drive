import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Brain, CircleUser, KeyRound, Languages, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '../../shared/format';
import { lang, setLang, t, type Lang } from '../lib/i18n';
import { sitePage } from '../lib/zeiko';
import { Button } from '../components/Button';
import { TotpSetup } from '../components/TotpSetup';
import { api, ApiError, sendJson } from '../lib/api';
import { searchAreas } from '../lib/ads';
import { downloadZip } from '../lib/files';
import { authClient } from '../lib/auth-client';
import { meQueryKey, useMe } from '../lib/session';

const card = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const input =
  'h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500';

export function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
  });

  const saveName = useMutation({
    mutationFn: (value: string) => sendJson('PATCH', '/api/me', { name: value }),
    onSuccess: async () => {
      setMsg(t.settings.profileSaved);
      await qc.invalidateQueries({ queryKey: meQueryKey });
    },
  });

  if (!me.data) return null;
  const user = me.data.user;

  async function addPasskey() {
    setMsg(null);
    const res = await authClient.passkey.addPasskey({
      name: navigator.platform || t.settings.thisDevice,
    });
    if (res?.error) setMsg(t.settings.passkeyFailed);
    else {
      setMsg(t.settings.passkeyAdded);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['passkeys'] }),
        qc.invalidateQueries({ queryKey: meQueryKey }),
      ]);
    }
  }

  async function removePasskey(id: string) {
    await authClient.passkey.deletePasskey({ id });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['passkeys'] }),
      qc.invalidateQueries({ queryKey: meQueryKey }),
    ]);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <h1 className="text-xl font-semibold">{t.nav.settings}</h1>
      {msg && (
        <p role="status" className="rounded-xl bg-brand-50 px-4 py-2 text-sm text-brand-800">
          {msg}
        </p>
      )}

      <ZeikoAccount />
      <Language />

      <section className={card} aria-labelledby="profil">
        <h2 id="profil" className="font-medium">
          {t.settings.profile}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{user.email}</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name?.trim()) saveName.mutate(name.trim());
          }}
        >
          <input
            className={input}
            aria-label={t.a11y.name}
            value={name ?? user.name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <Button type="submit" disabled={saveName.isPending}>
            {t.common.save}
          </Button>
        </form>
      </section>

      <section className={card} aria-labelledby="keamanan">
        <h2 id="keamanan" className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {t.settings.security}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.settings.securityBody}</p>
        <ul className="mt-4 divide-y divide-[var(--border)]">
          {(passkeys.data ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between py-2 text-sm">
              <span className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {p.name || 'Passkey'}
                <span className="text-[var(--fg-muted)]">
                  · {formatDate(new Date(p.createdAt).getTime())}
                </span>
              </span>
              <button
                type="button"
                onClick={() => removePasskey(p.id)}
                aria-label={t.a11y.deletePasskey}
                className="p-2 text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" className="mt-3" onClick={addPasskey}>
          <KeyRound className="h-4 w-4" aria-hidden="true" /> {t.settings.addPasskey}
        </Button>
        <TotpSetup enabled={user.twoFactorEnabled} />
        {(user.role === 'admin' || user.role === 'moderator') &&
          !user.twoFactorEnabled &&
          !me.data.hasPasskey && (
            <p className="mt-3 text-sm text-amber-600">{t.settings.staffNeeds2fa}</p>
          )}
      </section>

      <NotificationPrefs />
      <AdLocation />

      <AccountData />

      <section className={card} aria-labelledby="telegram">
        <h2 id="telegram" className="flex items-center gap-2 font-medium">
          <Send className="h-4 w-4" aria-hidden="true" /> {t.settings.telegramTitle}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.settings.telegramBody}</p>
        <Button
          variant="secondary"
          className="mt-3"
          onClick={async () => {
            const { url } = await api<{ url: string }>('/api/shares/telegram/link');
            window.open(url, '_blank', 'noopener');
          }}
        >
          {t.settings.telegramLink}
        </Button>
      </section>
    </div>
  );
}

/** The account itself is Zeiko Accounts' (ADR-036); the other products are one tap away. */
function ZeikoAccount() {
  const links = useQuery({
    queryKey: ['zeiko-settings-link'],
    queryFn: () => sitePage('settings'),
    staleTime: Infinity,
  });
  return (
    <section className={card} aria-labelledby="zeiko-account">
      <h2 id="zeiko-account" className="flex items-center gap-2 font-medium">
        <CircleUser className="h-4 w-4" aria-hidden="true" /> {t.products.account}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.auth.managedThere}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {links.data && (
          <a
            href={links.data}
            className="inline-flex h-9 items-center rounded-full border border-[var(--border)] px-4 text-sm font-medium"
          >
            {t.auth.manageAccount}
          </a>
        )}
        <Link
          to="/ai"
          className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm font-medium"
        >
          <Brain className="h-4 w-4" aria-hidden="true" /> {t.products.ai}
        </Link>
      </div>
    </section>
  );
}

/** Indonesian or English, for every screen and for the emails we send. */
function Language() {
  async function choose(next: Lang) {
    if (next === lang) return;
    await sendJson('PATCH', '/api/me', { locale: next }).catch(() => undefined);
    setLang(next);
  }
  return (
    <section className={card} aria-labelledby="bahasa">
      <h2 id="bahasa" className="flex items-center gap-2 font-medium">
        <Languages className="h-4 w-4" aria-hidden="true" /> {t.lang.label}
      </h2>
      <div className="mt-3 flex gap-2" role="radiogroup" aria-labelledby="bahasa">
        {(['id', 'en'] as const).map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={lang === l}
            onClick={() => void choose(l)}
            className={`h-9 rounded-full border px-4 text-sm ${lang === l ? 'border-brand-500 bg-brand-50 font-medium text-brand-800 dark:bg-brand-800/40 dark:text-brand-100' : 'border-[var(--border)]'}`}
          >
            {t.lang[l]}
          </button>
        ))}
      </div>
    </section>
  );
}

/** "Lokasi untuk iklan lokal" (SPEC §10.3): optional city, stored only with consent, clearable. */
function AdLocation() {
  const me = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const current = me.data?.user.adCityCode ?? null;
  const areas = useQuery({
    queryKey: ['ad-areas', q],
    queryFn: () => searchAreas(q),
    enabled: q.length >= 2,
  });
  const currentName = useQuery({
    queryKey: ['ad-area-name', current],
    queryFn: async () =>
      (await searchAreas(current!)).areas.find((a) => a.code === current)?.name ?? current,
    enabled: Boolean(current),
  });
  const save = useMutation({
    mutationFn: (adCityCode: string | null) => sendJson('PATCH', '/api/me', { adCityCode }),
    onSuccess: async () => {
      setQ('');
      await qc.invalidateQueries({ queryKey: meQueryKey });
      await qc.invalidateQueries({ queryKey: ['ad'] });
    },
  });
  return (
    <section className={card} aria-labelledby="iklan-lokasi">
      <h2 id="iklan-lokasi" className="font-medium">
        {t.ads.settingsTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.ads.settingsBody}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className={`${input} max-w-xs`}
          placeholder={current ? (currentName.data ?? current) : t.ads.areaSearch}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t.ads.settingsTitle}
        />
        {current && (
          <Button variant="ghost" onClick={() => save.mutate(null)}>
            {t.ads.settingsClear}
          </Button>
        )}
      </div>
      {q.length >= 2 && (
        <ul className="mt-2 max-h-48 max-w-xs overflow-auto rounded-xl border border-[var(--border)] text-sm">
          {areas.data?.areas.map((a) => (
            <li key={a.code}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-[var(--bg-subtle)]"
                onClick={() => save.mutate(a.code)}
              >
                {a.name}
                {a.province && (
                  <span className="text-xs text-[var(--fg-muted)]"> · {a.province}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotificationPrefs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () =>
      api<{
        items: Array<{ type: string; email: boolean; telegram: boolean; emailLocked: boolean }>;
      }>('/api/notifications/prefs'),
  });
  const set = (type: string, channel: 'email' | 'telegram', enabled: boolean) =>
    void sendJson('PUT', '/api/notifications/prefs', { type, channel, enabled }).then(() =>
      qc.invalidateQueries({ queryKey: ['notification-prefs'] }),
    );
  return (
    <section className={card} aria-labelledby="notif">
      <h2 id="notif" className="font-medium">
        {t.notifications.prefsTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.notifications.prefsBody}</p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--fg-muted)]">
            <th className="py-1 font-normal" />
            <th className="w-20 font-normal">{t.notifications.email}</th>
            <th className="w-20 font-normal">{t.notifications.telegram}</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.items ?? []).map((p) => (
            <tr key={p.type} className="border-t border-[var(--border)]">
              <td className="py-2">{t.notifications.types[p.type] ?? p.type}</td>
              <td>
                {p.emailLocked ? (
                  <span className="text-xs text-[var(--fg-muted)]">{t.notifications.locked}</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={p.email}
                    onChange={(e) => set(p.type, 'email', e.target.checked)}
                    aria-label={`${t.notifications.email}: ${t.notifications.types[p.type]}`}
                  />
                )}
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={p.telegram}
                  onChange={(e) => set(p.type, 'telegram', e.target.checked)}
                  aria-label={`${t.notifications.telegram}: ${t.notifications.types[p.type]}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AccountData() {
  const qc = useQueryClient();
  const me = useMe();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!me.data) return null;
  const data = me.data;
  const pending = data.deleteRequestedAt;
  const days = 7;
  return (
    <section className={card} aria-labelledby="akun">
      <h2 id="akun" className="font-medium">
        {t.account.title}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.account.exportNote}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href="/api/me/export"
          className="inline-flex h-10 items-center rounded-full border border-[var(--border)] px-4 text-sm hover:bg-[var(--bg-subtle)]"
        >
          {t.account.exportJson}
        </a>
        <Button variant="secondary" onClick={() => void downloadZip([data.space.personalRootId])}>
          {t.account.exportFiles}
        </Button>
      </div>
      <hr className="my-5 border-[var(--border)]" />
      {pending ? (
        <div className="space-y-2">
          <p className="text-sm text-red-700">
            {t.account.deleteRequested(formatDate(new Date(pending).getTime() + days * 86_400_000))}
          </p>
          <Button
            variant="secondary"
            onClick={() =>
              void sendJson('DELETE', '/api/me/delete').then(() =>
                qc.invalidateQueries({ queryKey: meQueryKey }),
              )
            }
          >
            {t.account.cancelDelete}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-red-700">{t.account.delete}</p>
          <p className="text-sm text-[var(--fg-muted)]">{t.account.deleteBody(days)}</p>
          <input
            className={input}
            placeholder={t.account.confirmEmail}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            variant="danger"
            disabled={confirm.trim().toLowerCase() !== data.user.email.toLowerCase()}
            onClick={() =>
              void sendJson('POST', '/api/me/delete', { confirmEmail: confirm })
                .then(() => qc.invalidateQueries({ queryKey: meQueryKey }))
                .catch((e) =>
                  setError(
                    e instanceof ApiError && e.code === 'CONFLICT'
                      ? t.account.familyOwner
                      : t.errors.generic,
                  ),
                )
            }
          >
            {t.account.delete}
          </Button>
        </div>
      )}
    </section>
  );
}
