// The download queue's browser side (ADR-053): fetch, <a download>, and the online/offline events.
import type { DownloadDeps } from './manager';

export function browserDeps(): DownloadDeps {
  return {
    // The /d/ links need no cookie, and a half-done file must never come from the HTTP cache.
    fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }),
    handOff: (url, name) => {
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      if (name) a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    online: () => navigator.onLine !== false,
    waitOnline: () =>
      new Promise<void>((resolve) => {
        if (navigator.onLine !== false) return resolve();
        window.addEventListener('online', () => resolve(), { once: true });
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => performance.now(),
    random: Math.random,
  };
}
