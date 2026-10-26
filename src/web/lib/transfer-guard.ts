// While anything uploads or downloads (ADR-053): closing the tab asks first, and, if the person
// left "keep the screen on" switched on, a screen wake lock stops the phone from sleeping (which
// would freeze the tab and its transfers).
import { transfer } from './transfer';

interface Busy {
  busy(): boolean;
  subscribe(fn: () => void): () => void;
}

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

export function guardTransfers(queues: Busy[]): void {
  const busy = () => queues.some((q) => q.busy());
  let lock: WakeLockSentinelLike | null = null;
  let asking = false;

  const sync = async () => {
    const want = busy() && transfer.get().keepAwake && document.visibilityState === 'visible';
    if (want && (!lock || lock.released) && !asking) {
      const wl = (
        navigator as Navigator & {
          wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
        }
      ).wakeLock;
      if (!wl) return;
      asking = true;
      try {
        lock = await wl.request('screen');
      } catch {
        lock = null; // battery saver or not allowed: transfers still run
      } finally {
        asking = false;
      }
    } else if (!want && lock && !lock.released) {
      const l = lock;
      lock = null;
      await l.release().catch(() => undefined);
    }
  };

  for (const q of queues) q.subscribe(() => void sync());
  transfer.subscribe(() => void sync());
  // The lock goes when the tab is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => void sync());
  window.addEventListener('beforeunload', (e) => {
    if (!busy()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
