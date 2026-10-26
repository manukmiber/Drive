import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogIn, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { t } from '../lib/i18n';
import { meQueryKey } from '../lib/session';
import { signInSilently, sitePage, zeikoConfig, type SilentResult } from '../lib/zeiko';

/**
 * Only same-app paths are accepted as a return target (no open redirect). A query is kept (an app's
 * sign-in request, ADR-063), with plain URL characters only.
 */
function nextPath(): string {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?!\/)[\w\-/]*(\?[\w\-.~%&=+]*)?$/.test(next) ? next : '/';
}

/**
 * Sign-in is Zeiko Accounts' (ADR-036): if this browser is already signed in there, we sign in
 * here without a click; otherwise the website's own sign-in and sign-up pages do it and send the
 * visitor straight back to this page (ADR-039), which then finishes by itself.
 */
export function SignIn() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<SilentResult | 'checking'>('checking');
  const [links, setLinks] = useState<{ signIn: string; signUp: string; account: string } | null>(
    null,
  );
  const [dev, setDev] = useState(false);

  const attempt = useCallback(async () => {
    setState('checking');
    const r = await signInSilently();
    if (r === 'signed-in') {
      await qc.invalidateQueries({ queryKey: meQueryKey });
      const to = nextPath();
      if (to.includes('?')) location.assign(to);
      else await navigate({ to: to as '/' });
      return;
    }
    setState(r);
  }, [navigate, qc]);

  useEffect(() => {
    void (async () => {
      const cfg = await zeikoConfig().catch(() => null);
      setDev(Boolean(cfg?.dev));
      const back = `/masuk?next=${encodeURIComponent(nextPath())}`;
      const [signIn, signUp, account] = await Promise.all([
        sitePage('signin', back),
        sitePage('signup', back),
        sitePage('settings'),
      ]);
      if (signIn && signUp && account) setLinks({ signIn, signUp, account });
    })();
    const first = setTimeout(() => void attempt(), 0);
    // Signed in on the website in another tab: carry on when this one is looked at again.
    const again = () => {
      if (document.visibilityState === 'visible') void attempt();
    };
    document.addEventListener('visibilitychange', again);
    return () => {
      clearTimeout(first);
      document.removeEventListener('visibilitychange', again);
    };
  }, [attempt]);

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--bg-subtle)] p-4">
      <div className="w-full max-w-sm z-card rounded-2xl p-6 shadow-sm">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{t.auth.signInTitle}</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.auth.signInSubtitle}</p>

        {state === 'checking' && (
          <p role="status" className="mt-6 text-sm text-[var(--fg-muted)]">
            {t.auth.checking}
          </p>
        )}

        {state === 'no-session' && links && (
          <div className="mt-6 space-y-2">
            <a
              href={links.signIn}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand-700 text-sm font-medium text-white"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {t.auth.withZeiko}
            </a>
            <a
              href={links.signUp}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--border)] text-sm font-medium"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {t.auth.createAccount}
            </a>
            <p className="pt-2 text-xs text-[var(--fg-muted)]">{t.auth.otherTab}</p>
            {dev && <p className="text-xs text-amber-600">{t.auth.devHint}</p>}
          </div>
        )}

        {state === 'unverified' && (
          <div className="mt-6 space-y-3">
            <p role="alert" className="text-sm text-amber-700">
              {t.auth.emailUnverified}
            </p>
            {links && (
              <a
                href={links.account}
                className="flex h-11 w-full items-center justify-center rounded-full bg-brand-700 text-sm font-medium text-white"
              >
                {t.auth.openAccount}
              </a>
            )}
            <Button variant="secondary" className="w-full" onClick={() => void attempt()}>
              {t.common.retry}
            </Button>
          </div>
        )}

        {state === 'unavailable' && (
          <div className="mt-6 space-y-3">
            <p role="alert" className="text-sm text-red-600">
              {t.auth.unavailable}
            </p>
            <Button variant="secondary" className="w-full" onClick={() => void attempt()}>
              {t.common.retry}
            </Button>
          </div>
        )}
        <p className="mt-8 text-xs text-[var(--fg-muted)]">
          {t.legal.agreeBefore}
          <Link to="/kebijakan/$slug" params={{ slug: 'syarat' }} className="underline">
            {t.legal.termsLong}
          </Link>
          {t.legal.agreeAnd}
          <Link to="/kebijakan/$slug" params={{ slug: 'privasi' }} className="underline">
            {t.legal.privacyLong}
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
