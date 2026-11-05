// /minta/{r64}/{s32} — the public side of a file request link (D3, ADR-086): anyone may send files
// into the owner's folder without an account, and sees nothing of it. No ads on this upload path.
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatBytes, formatDateTime } from '../../shared/format';
import { t } from '../lib/i18n';
import { api, ApiError, postJson } from '../lib/api';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { Turnstile, useTurnstileSiteKey } from '../components/Turnstile';

interface PublicRequest {
  title: string;
  message: string | null;
  ownerName: string | null;
  deadlineAt: number | null;
  maxFileBytes: number | null;
  filesLeft: number | null;
  requireName: boolean;
  hasPassword: boolean;
  state: 'open' | 'revoked' | 'expired' | 'full' | 'unavailable';
}

interface Item {
  file: File;
  state: 'waiting' | 'sending' | 'sent' | 'failed';
  progress: number;
  error?: string;
}

const field =
  'mt-1 h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.data?.reason === 'PASSWORD') return t.requests.wrongPassword;
    if (e.status === 410) return t.requests.closed;
  }
  return e instanceof Error ? e.message : t.errors.generic;
}

export function RequestUpload({ id, sig }: { id: string; sig: string }) {
  const base = `/api/public/requests/${id}/${sig}`;
  const q = useQuery({
    queryKey: ['file-request', id],
    queryFn: () => api<PublicRequest>(base),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const needsCaptcha = Boolean(useTurnstileSiteKey());
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const patch = (i: number, p: Partial<Item>) =>
    setItems((list) => list.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function sendAll() {
    const r = q.data!;
    setBusy(true);
    setError(null);
    let pass: string;
    try {
      pass = (
        await postJson<{ pass: string }>(`${base}/pass`, {
          password: r.hasPassword ? password : null,
          turnstileToken: captcha,
        })
      ).pass;
    } catch (e) {
      setError(message(e));
      setBusy(false);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.state === 'sent') continue;
      patch(i, { state: 'sending', progress: 0 });
      try {
        const s = await postJson<{
          uploadId: string;
          token: string;
          partSize: number;
          totalParts: number;
        }>(`${base}/uploads`, {
          name: it.file.name,
          size: it.file.size,
          mime: it.file.type || null,
          lastModified: it.file.lastModified || null,
          uploaderName: name.trim() || null,
          pass,
        });
        const headers = { 'x-drop-token': s.token };
        for (let n = 1; n <= s.totalParts; n++) {
          const part = it.file.slice((n - 1) * s.partSize, n * s.partSize);
          await api(`${base}/uploads/${s.uploadId}/parts/${n}`, {
            method: 'PUT',
            body: part,
            headers,
          });
          patch(i, { progress: n / s.totalParts });
        }
        await api(`${base}/uploads/${s.uploadId}/complete`, { method: 'POST', headers });
        patch(i, { state: 'sent', progress: 1 });
      } catch (e) {
        patch(i, { state: 'failed', error: message(e) });
      }
    }
    setBusy(false);
    void q.refetch();
  }

  const r = q.data;
  const allSent = items.length > 0 && items.every((x) => x.state === 'sent');
  const tooBig = (f: File) => r?.maxFileBytes != null && f.size > r.maxFileBytes;
  const ready =
    items.some((x) => x.state !== 'sent') &&
    !items.some((x) => tooBig(x.file)) &&
    (!r?.requireName || name.trim()) &&
    (!r?.hasPassword || password) &&
    (!needsCaptcha || captcha);

  return (
    <div className="flex min-h-screen items-start justify-center bg-[var(--bg-subtle)] p-4 sm:items-center">
      <main className="w-full max-w-md z-card rounded-2xl p-6">
        <Logo />
        {q.isPending ? (
          <p className="mt-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : !r ? (
          <p className="mt-6 text-sm">{t.requests.notFound}</p>
        ) : (
          <>
            <h1 className="mt-6 text-2xl break-words">{r.title}</h1>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              {[
                r.ownerName && t.requests.from(r.ownerName),
                r.deadlineAt && t.requests.until(formatDateTime(r.deadlineAt)),
                r.filesLeft !== null && t.requests.left(r.filesLeft),
                r.maxFileBytes && t.requests.maxSize(formatBytes(r.maxFileBytes)),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {r.message && <p className="mt-3 text-sm whitespace-pre-line">{r.message}</p>}
            {r.state !== 'open' && !allSent ? (
              <p className="mt-6 rounded-xl bg-[var(--bg-subtle)] p-4 text-sm">
                {t.requests.closed}
              </p>
            ) : allSent ? (
              <p className="mt-6 flex items-center gap-2 rounded-xl bg-[var(--bg-subtle)] p-4 text-sm">
                <CheckCircle2 className="h-5 w-5 text-brand-600" /> {t.requests.done}
              </p>
            ) : (
              <form
                className="mt-6 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (ready && !busy) void sendAll();
                }}
              >
                <label className="block text-sm">
                  {t.requests.yourName}
                  <input
                    value={name}
                    maxLength={100}
                    required={r.requireName}
                    autoComplete="name"
                    onChange={(e) => setName(e.target.value)}
                    className={field}
                  />
                </label>
                {r.hasPassword && (
                  <label className="block text-sm">
                    {t.requests.passwordAsk}
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={field}
                    />
                  </label>
                )}
                <input
                  ref={input}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    setItems((list) => [
                      ...list.filter((x) => x.state === 'sent'),
                      ...files.map((file) => ({ file, state: 'waiting' as const, progress: 0 })),
                    ]);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Upload className="h-4 w-4" /> {t.requests.pick}
                </Button>
                {items.length > 0 && (
                  <ul className="space-y-1 text-sm">
                    {items.map((x, i) => (
                      <li key={`${x.file.name}-${i}`} className="flex items-center gap-2">
                        {x.state === 'sent' ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-600" />
                        ) : x.state === 'failed' || tooBig(x.file) ? (
                          <XCircle className="h-4 w-4 shrink-0 text-red-600" />
                        ) : (
                          <span className="h-4 w-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{x.file.name}</span>
                        <span className="shrink-0 text-xs text-[var(--fg-muted)]">
                          {x.state === 'sending'
                            ? `${Math.round(x.progress * 100)}%`
                            : x.state === 'failed'
                              ? (x.error ?? t.requests.failed)
                              : tooBig(x.file)
                                ? t.requests.maxSize(formatBytes(r.maxFileBytes!))
                                : formatBytes(x.file.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Turnstile onToken={setCaptcha} />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" disabled={!ready || busy}>
                  {busy ? t.requests.sending : t.requests.send}
                </Button>
                <p className="text-xs text-[var(--fg-muted)]">{t.requests.privacy}</p>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
