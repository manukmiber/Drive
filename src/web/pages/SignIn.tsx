import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { t } from '../../shared/strings.id';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { meQueryKey } from '../lib/session';
import type { PublicAuth } from '../lib/types';

const input =
  'h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500';

export function SignIn() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = useQuery({
    queryKey: ['public-auth'],
    queryFn: () => api<PublicAuth>('/api/public/auth'),
  });
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function done() {
    await qc.invalidateQueries({ queryKey: meQueryKey });
    await navigate({ to: '/drive' });
  }

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim(),
      type: 'sign-in',
    });
    setBusy(false);
    if (res.error) setError(res.error.status === 429 ? t.errors.rateLimited : t.errors.generic);
    else setStep('code');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.emailOtp({ email: email.trim(), otp: otp.trim() });
    setBusy(false);
    if (res.error) setError('Kode salah atau sudah kedaluwarsa.');
    else await done();
  }

  async function withPasskey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error) setError('Passkey tidak bisa dipakai di perangkat ini.');
    else await done();
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--bg-subtle)] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{t.auth.signInTitle}</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.auth.signInSubtitle}</p>

        {step === 'email' ? (
          <form onSubmit={sendCode} className="mt-6 space-y-3">
            <label className="block text-sm font-medium" htmlFor="email">
              {t.auth.emailLabel}
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email webauthn"
              inputMode="email"
              placeholder={t.auth.emailPlaceholder}
              className={input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={busy}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              {t.auth.sendCode}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-6 space-y-3">
            <p className="text-sm text-[var(--fg-muted)]">{t.auth.codeSent(email)}</p>
            <label className="block text-sm font-medium" htmlFor="otp">
              {t.auth.codeLabel}
            </label>
            <input
              id="otp"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              className={`${input} text-center text-lg tracking-[0.4em]`}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={busy || otp.length !== 6}>
              {t.auth.verify}
            </Button>
            <button
              type="button"
              className="w-full text-sm text-brand-700"
              onClick={() => setStep('email')}
            >
              Ganti email
            </button>
            {cfg.data?.devMailbox && <p className="text-xs text-amber-600">{t.auth.devMailHint}</p>}
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="my-5 flex items-center gap-3 text-xs text-[var(--fg-muted)]">
          <span className="h-px flex-1 bg-[var(--border)]" />
          atau
          <span className="h-px flex-1 bg-[var(--border)]" />
        </div>
        <div className="space-y-2">
          {cfg.data?.google && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() =>
                authClient.signIn.social({ provider: 'google', callbackURL: '/drive' })
              }
            >
              {t.auth.withGoogle}
            </Button>
          )}
          <Button variant="secondary" className="w-full" onClick={withPasskey}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {t.auth.withPasskey}
          </Button>
        </div>
      </div>
    </div>
  );
}
