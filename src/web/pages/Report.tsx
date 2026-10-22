// /lapor — public abuse report form (linked from every share page; SPEC §14.3, §14.5).
import { useState } from 'react';
import { t } from '../../shared/strings.id';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { Turnstile } from '../components/Turnstile';
import { ApiError, postJson } from '../lib/api';

/** Accepts a full share URL or a bare r64 id. */
function shareIdFrom(input: string): string | null {
  const m = /(?:^|\/)([0-9A-Za-z]{64})(?:\/|$)/.exec(input.trim());
  return m?.[1] ?? null;
}

const field = 'mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm';

export function Report({ share, ad }: { share?: string | undefined; ad?: string | undefined }) {
  const [link, setLink] = useState(share ?? '');
  const [category, setCategory] = useState(ad ? 'phishing' : 'copyright');
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);

  const submit = async () => {
    const id = ad ?? shareIdFrom(link);
    if (!id) return setError(t.report.badLink);
    setState('sending');
    setError(null);
    try {
      await postJson('/api/public/reports', {
        targetType: ad ? 'ad' : 'share',
        targetId: id,
        category,
        details: details || undefined,
        contact: contact || undefined,
        turnstileToken: captcha,
      });
      setState('sent');
    } catch (e) {
      setState('idle');
      setError(
        e instanceof ApiError && e.code === 'NOT_FOUND' ? t.report.badLink : t.errors.generic,
      );
    }
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-[var(--bg-subtle)] p-4 sm:items-center">
      <main className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <Logo />
        <h1 className="mt-4 text-lg font-semibold">{t.report.title}</h1>
        {state === 'sent' ? (
          <p className="mt-3 text-sm">{t.report.sent}</p>
        ) : (
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="text-sm text-[var(--fg-muted)]">{t.report.intro}</p>
            {ad ? (
              <p className="text-xs text-[var(--fg-muted)]">
                {t.report.adTarget}: <code>{ad}</code>
              </p>
            ) : (
              <label className="block text-xs text-[var(--fg-muted)]">
                {t.report.link}
                <input
                  className={`${field} h-11`}
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  required
                />
              </label>
            )}
            <label className="block text-xs text-[var(--fg-muted)]">
              {t.report.category}
              <select
                className={`${field} h-11`}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(t.report.categories).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-[var(--fg-muted)]">
              {t.report.details}
              <textarea
                className={`${field} py-2`}
                rows={4}
                maxLength={2000}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </label>
            <label className="block text-xs text-[var(--fg-muted)]">
              {t.report.contact}
              <input
                className={`${field} h-11`}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
              />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Turnstile onToken={setCaptcha} />
            <Button type="submit" className="w-full" disabled={state === 'sending'}>
              {t.report.send}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
