import { useSyncExternalStore } from 'react';

// Snackbar with an optional action ("Dipindahkan ke Sampah · Urungkan", SPEC §8.2).
interface ToastData {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  tone?: 'info' | 'error';
}

let toasts: ToastData[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, opts: Omit<ToastData, 'id' | 'text'> = {}): void {
  const id = ++seq;
  toasts = [...toasts.slice(-2), { id, text, ...opts }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== id);
    emit();
  }, 6000);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div
      className="pointer-events-none fixed bottom-20 left-4 z-50 flex flex-col gap-2 md:bottom-6"
      aria-live="polite"
    >
      {list.map((x) => (
        <div
          key={x.id}
          className={`pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-4 rounded-lg px-4 py-3 text-sm shadow-lg ${x.tone === 'error' ? 'bg-red-600 text-white' : 'bg-[var(--ink)] text-[var(--on-ink)]'}`}
        >
          <span>{x.text}</span>
          {x.action && (
            <button
              type="button"
              className="-my-2 min-h-11 shrink-0 font-semibold underline underline-offset-4"
              onClick={() => {
                toasts = toasts.filter((y) => y.id !== x.id);
                emit();
                x.action!.run();
              }}
            >
              {x.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
