// Proves the second factor in this session (ADR-056): a passkey, or a code from the authenticator
// app. Staff routes and changing a factor ask for it; signing in through Zeiko Accounts is not enough.
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { authClient } from '../lib/auth-client';
import { t } from '../lib/i18n';
import { Button } from './Button';

const input =
  'h-10 w-32 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-center tracking-[0.3em] outline-none focus:border-brand-500';

export function SecondFactorPrompt({
  hasPasskey,
  hasTotp,
  manage = false,
  onDone,
}: {
  hasPasskey: boolean;
  hasTotp: boolean;
  /** Asked while changing a factor, not for the admin panel. */
  manage?: boolean;
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function withPasskey() {
    setBusy(true);
    setMsg(null);
    try {
      const options = await authClient.$fetch<PublicKeyCredentialRequestOptionsJSON>(
        '/second-factor/passkey/options',
        { method: 'POST' },
      );
      if (options.error || !options.data) throw new Error('options');
      const response = await startAuthentication({ optionsJSON: options.data });
      const res = await authClient.$fetch('/second-factor/passkey/verify', {
        method: 'POST',
        body: { response },
      });
      if (res.error) throw new Error('verify');
      onDone();
    } catch {
      setMsg(t.settings.stepUpPasskeyFailed);
    } finally {
      setBusy(false);
    }
  }

  async function withCode() {
    setBusy(true);
    setMsg(null);
    const res = await authClient.$fetch('/second-factor/totp', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (res.error) {
      setMsg(res.error.status === 429 ? t.settings.stepUpLocked : t.settings.totpWrong);
      setCode('');
      return;
    }
    onDone();
  }

  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="step-up-title" role="region">
      <h2 id="step-up-title" className="flex items-center gap-2 font-medium">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {t.settings.stepUpTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        {manage ? t.settings.stepUpManage : t.settings.stepUpBody}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {hasPasskey && (
          <Button variant="secondary" onClick={withPasskey} disabled={busy}>
            <KeyRound className="h-4 w-4" aria-hidden="true" /> {t.settings.stepUpPasskey}
          </Button>
        )}
        {hasTotp && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6) void withCode();
            }}
          >
            <input
              className={input}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-label={t.settings.stepUpCode}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {t.settings.stepUpConfirm}
            </Button>
          </form>
        )}
      </div>
      {msg && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {msg}
        </p>
      )}
    </section>
  );
}
