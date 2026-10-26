// Notices live on the relay since ADR-064; in tests the store is the KV mock (adapters/notices.ts).
// Each read first delivers what the notify queue holds, as the consumer would.
import type { DevRuntime } from '../../dev/env';
import type { StoredNotice } from '../../src/worker/adapters/notices';

/** A person's notices, oldest first, in the shape the old D1 rows had (plus the parsed payload). */
export async function noticesOf(rt: DevRuntime, userId: string) {
  await rt.queues.NOTIFY_QUEUE.drain();
  const items = JSON.parse(
    ((await rt.kv.get(`dev:notices:${userId}`)) as string | null) ?? '[]',
  ) as StoredNotice[];
  return items
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((n) => ({
      id: n.id,
      type: n.type,
      payload: n.payload,
      payload_json: JSON.stringify(n.payload),
      read_at: n.readAt,
    }));
}

/** Put a notice straight into the store, as if the relay already had it. */
export async function fileNotice(rt: DevRuntime, userId: string, n: Partial<StoredNotice>) {
  const key = `dev:notices:${userId}`;
  const items = JSON.parse(((await rt.kv.get(key)) as string | null) ?? '[]') as StoredNotice[];
  items.push({ id: 'n1', type: 'quota', payload: {}, readAt: null, createdAt: 1, ...n });
  await rt.kv.put(key, JSON.stringify(items));
}
