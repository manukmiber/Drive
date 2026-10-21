import { Logo } from '../components/Logo';
import { t } from '../../shared/strings.id';

// Fase 1 replaces this with Better Auth (email OTP, Google, passkey).
export function SignIn() {
  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--bg-subtle)] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{t.auth.signInTitle}</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.auth.signInSubtitle}</p>
      </div>
    </div>
  );
}
