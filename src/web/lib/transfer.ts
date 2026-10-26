// How many uploads and downloads run at once on this device (ADR-053). The person picks it for
// their own connection; config gives the default and the ceiling (20 files each way). Kept in
// localStorage because the right number belongs to the device and its network, not the account.
import { useSyncExternalStore } from 'react';
import {
  clampSettings,
  FALLBACK_LIMITS,
  type ConnectionHint,
  type TransferLimits,
  type TransferSettings,
} from './transfer-rules';

export * from './transfer-rules';

// ── the store (one per tab, shared with other tabs through the storage event) ──

const KEY = 'zk_transfer';
let limits: TransferLimits = FALLBACK_LIMITS;
let current: TransferSettings = clampSettings(read(), limits);
const listeners = new Set<() => void>();

function read(): Partial<TransferSettings> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<TransferSettings>) : null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    current = clampSettings(read(), limits);
    emit();
  });
}

export const transfer = {
  get: (): TransferSettings => current,
  limits: (): TransferLimits => limits,
  /** Called once the catalog arrives; saved values are re-clamped to the real limits. */
  setLimits(l: TransferLimits): void {
    limits = l;
    current = clampSettings(read() ?? current, l);
    emit();
  },
  set(patch: Partial<TransferSettings>): void {
    current = clampSettings({ ...current, ...patch }, limits);
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // blocked storage: the choice lasts until the tab closes
    }
    emit();
  },
  reset(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    current = clampSettings(null, limits);
    emit();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useTransferSettings(): TransferSettings {
  return useSyncExternalStore(transfer.subscribe, transfer.get, transfer.get);
}

export function connectionHint(): ConnectionHint | null {
  const c = (navigator as Navigator & { connection?: ConnectionHint }).connection;
  return c ?? null;
}
