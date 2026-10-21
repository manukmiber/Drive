import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { Button } from '../components/Button';
import { TotpSetup } from '../components/TotpSetup';
import { api, sendJson } from '../lib/api';
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
      setMsg('Profil disimpan.');
      await qc.invalidateQueries({ queryKey: meQueryKey });
    },
  });

  if (!me.data) return null;
  const user = me.data.user;

  async function addPasskey() {
    setMsg(null);
    const res = await authClient.passkey.addPasskey({
      name: navigator.platform || 'Perangkat ini',
    });
    if (res?.error) setMsg('Gagal menambah passkey.');
    else {
      setMsg('Passkey ditambahkan.');
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

      <section className={card} aria-labelledby="profil">
        <h2 id="profil" className="font-medium">
          Profil
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
            aria-label="Nama"
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
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Keamanan
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          Zeiko tidak memakai password. Tambahkan passkey supaya bisa masuk dengan sidik jari atau
          kunci layar.
        </p>
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
                aria-label="Hapus passkey"
                className="p-2 text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" className="mt-3" onClick={addPasskey}>
          <KeyRound className="h-4 w-4" aria-hidden="true" /> Tambah passkey
        </Button>
        <TotpSetup enabled={user.twoFactorEnabled} />
        {(user.role === 'admin' || user.role === 'moderator') &&
          !user.twoFactorEnabled &&
          !me.data.hasPasskey && (
            <p className="mt-3 text-sm text-amber-600">
              Akun staf wajib memakai passkey atau TOTP sebelum bisa membuka panel admin.
            </p>
          )}
      </section>

      <NotificationPrefs />

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
