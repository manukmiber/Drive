import { useSyncExternalStore } from 'react';

// The folder currently open in the explorer, so the sidebar "+ Baru" button and the mobile FAB
// act on it.
export interface CurrentFolder {
  id: string;
  name: string;
}

let current: CurrentFolder | null = null;
const listeners = new Set<() => void>();

export function setCurrentFolder(f: CurrentFolder | null): void {
  if (current?.id === f?.id && current?.name === f?.name) return;
  current = f;
  listeners.forEach((l) => l());
}

export function useCurrentFolder(): CurrentFolder | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
