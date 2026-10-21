import { useSyncExternalStore } from 'react';
import type { UploadManager } from './manager';

let manager: UploadManager | null = null;

export function initUploads(m: UploadManager): void {
  manager = m;
}

export function uploads(): UploadManager {
  if (!manager) throw new Error('upload manager not initialised');
  return manager;
}

export function useUploads() {
  const m = uploads();
  return useSyncExternalStore(m.subscribe, m.getSnapshot);
}
