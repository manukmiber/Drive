import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authClient } from './auth-client';
import { meQueryKey } from './session';
import { doorAccount } from './zeiko';

/** At most one look at the door per this many ms (opening the app, coming back to the tab). */
const EVERY_MS = 15_000;

/**
 * Drive follows the Zeiko Account this browser is signed in to (ADR-039). Signed out at the door
 * (on the website, or in another app): signed out here too. Signed in there as somebody else:
 * signed out here, and the sign-in page signs them in as that person by itself. When the door
 * does not answer, Drive carries on as it is (ADR-036).
 *
 * `zeikoId` is the signed-in user's Zeiko Account (`/api/me`), or undefined while nobody is.
 */
export function useDoorSync(zeikoId: string | null | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (zeikoId === undefined) return;
    let busy = false;
    let last = 0;
    let gone = false;
    const look = async () => {
      if (busy || gone || Date.now() - last < EVERY_MS) return;
      busy = true;
      last = Date.now();
      try {
        const account = await doorAccount();
        if (gone || account === undefined || (account && account.id === zeikoId)) return;
        gone = true;
        await authClient.signOut().catch(() => undefined);
        // Nothing of this person's stays on screen for the next one.
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] });
        qc.setQueryData(meQueryKey, null);
      } finally {
        busy = false;
      }
    };
    void look();
    const again = () => {
      if (document.visibilityState === 'visible') void look();
    };
    document.addEventListener('visibilitychange', again);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', again);
    };
  }, [zeikoId, qc]);
}
