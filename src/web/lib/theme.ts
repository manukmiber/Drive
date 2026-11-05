// Light or dark (ADR-101). Dark is the default whatever the system says (the owner's, 2026-11-03);
// light only when the person picks it, remembered on this device under the same key as
// zeiko.biz.id. public/theme.js applies it before the app draws; this switches it afterwards.
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'zeiko-theme';
const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function setTheme(next: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('light', next === 'light');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'light' ? '#ffffff' : '#10131b');
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    () => 'dark' as const,
  );
}
