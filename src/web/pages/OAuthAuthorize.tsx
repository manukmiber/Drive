// /oauth/authorize (ADR-063): one of Zeiko's apps asks to sign in. The person, signed in to Drive as
// usual (through the Zeiko Accounts door), sees what it may do and says yes or no; the answer goes
// back to the app's registered address. A bad request is shown here and never sent anywhere.
import { useQuery } from '@tanstack/react-query';
import { Check, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { api, ApiError, postJson } from '../lib/api';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';

type Scope = keyof typeof t.tokens.scope;
const FIELDS = [
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

export function OAuthAuthorize() {
  const me = useMe();
  const params = new URLSearchParams(location.search);
  const request = Object.fromEntries(FIELDS.map((f) => [f, params.get(f) ?? '']));
  const query = new URLSearchParams(request).toString();
  const signedIn = Boolean(me.data);
  const check = useQuery({
    queryKey: ['oauth-check', query],
    enabled: signedIn,
    retry: false,
    queryFn: () =>
      api<{ client: { id: string; name: string }; scopes: Scope[] }>(
        `/api/oauth/authorize?${query}`,
      ),
  });
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Not signed in to Drive: through the door first, then back here with the same request.
  useEffect(() => {
    if (me.isSuccess && !me.data)
      location.assign(`/masuk?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }, [me.isSuccess, me.data, query]);

  async function answer(approve: boolean) {
    setBusy(true);
    try {
      const { redirect } = await postJson<{ redirect: string }>('/api/oauth/authorize', {
        ...request,
        approve,
      });
      setLeaving(true);
      location.assign(redirect);
    } catch {
      setBusy(false);
    }
  }

  const invalid = check.isError && check.error instanceof ApiError;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-4">
      <div className="z-card w-full max-w-sm rounded-2xl p-6">
        <Logo />
        {invalid ? (
          <p role="alert" className="mt-5 text-sm text-red-600">
            {t.oauth.invalid}
          </p>
        ) : !check.data || !me.data ? (
          <p className="mt-5 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : leaving ? (
          <p className="mt-5 text-sm text-[var(--fg-muted)]">{t.oauth.returning}</p>
        ) : (
          <>
            <h1 className="mt-5 text-lg font-semibold">{t.oauth.title(check.data.client.name)}</h1>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              {t.oauth.signedInAs(me.data.user.email)}
            </p>
            <p className="mt-4 text-sm font-medium">{t.oauth.wants}</p>
            <ul className="mt-2 space-y-1.5">
              {check.data.scopes.map((s) => (
                <li key={s} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
                  {t.tokens.scope[s]}
                </li>
              ))}
            </ul>
            <p className="mt-4 flex items-start gap-2 text-xs text-[var(--fg-muted)]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t.oauth.note}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>
                {t.oauth.deny}
              </Button>
              <Button disabled={busy} onClick={() => void answer(true)}>
                {t.oauth.allow}
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
