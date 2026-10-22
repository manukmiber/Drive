// Cloudflare Turnstile widget (SPEC §14.4: login, share email, advertiser sign-up, anonymous report).
// Renders nothing until the server publishes a site key, so dev and tests need no captcha.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { PublicAuth } from '../lib/types';

interface TurnstileApi {
  render(el: HTMLElement, o: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function loadScript(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function useTurnstileSiteKey(): string | null {
  const q = useQuery({
    queryKey: ['public-auth'],
    queryFn: () => api<PublicAuth>('/api/public/auth'),
    staleTime: 10 * 60_000,
  });
  return q.data?.turnstileSiteKey ?? null;
}

/** Calls `onToken` with a fresh token (and null when it expires). */
export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const siteKey = useTurnstileSiteKey();
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  }, [onToken]);
  useEffect(() => {
    if (!siteKey || !el.current) return;
    let id: string | null = null;
    let cancelled = false;
    void loadScript()
      .then((ts) => {
        if (cancelled || !el.current) return;
        id = ts.render(el.current, {
          sitekey: siteKey,
          language: 'id',
          callback: (t: string) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey]);
  if (!siteKey) return null;
  return <div ref={el} className="min-h-[65px]" />;
}
