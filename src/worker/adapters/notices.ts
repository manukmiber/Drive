// Where notices live (ADR-064, the owner's answer to R0 no. 3): the bell, the "no email for this
// kind" switches, and the addresses that unsubscribed from share emails are kept by the relay
// (Zeiko Accounts, `/apps/v1/notices*`), not in Drive's D1. Drive still renders the words and
// decides which kinds may be switched off; the relay keeps rows keyed by Drive's user ids.
// When the relay is not answering, every call throws ACCOUNTS_UNAVAILABLE: the notify queue
// retries, the bell shows nothing for a while.
import { AppError } from '../lib/errors';
import { Door } from './zeiko';

export interface StoredNotice {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: number | null;
  createdAt: number;
}

export interface NewNotice {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  /** Only when bringing over Drive's old rows. */
  readAt?: number | null;
}

export interface NoticePref {
  type: string;
  channel: string;
  enabled: boolean;
}

export interface NoticeImport {
  notices: NewNotice[];
  prefs: Array<NoticePref & { userId: string }>;
  suppressions: Array<{ emailHash: string; reason: string; createdAt: number }>;
}

export interface NoticeStore {
  readonly name: string;
  /** File a notice (once per id); says whether that kind's email is switched off. */
  add(n: NewNotice): Promise<{ emailOff: boolean }>;
  list(userId: string, limit: number): Promise<{ unread: number; items: StoredNotice[] }>;
  markRead(userId: string, ids: string[] | 'all'): Promise<void>;
  prefs(userId: string): Promise<NoticePref[]>;
  setPref(userId: string, pref: NoticePref): Promise<void>;
  /** Everything of a person's (account deletion). */
  forget(userId: string): Promise<void>;
  /** Read notices created before `before`. */
  prune(before: number): Promise<void>;
  suppressed(emailHash: string): Promise<boolean>;
  suppress(emailHash: string, reason: string): Promise<void>;
  import(batch: NoticeImport): Promise<void>;
}

function refused(what: string, status: number): never {
  throw new AppError('ACCOUNTS_UNAVAILABLE', `Zeiko Accounts refused ${what} (${status})`);
}

export class RelayNotices implements NoticeStore {
  readonly name = 'relay';
  private door: Door;
  constructor(base: string, token: string, fetcher: typeof fetch = fetch) {
    this.door = new Door(base, token, fetcher);
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const r = await this.door.call('POST', path, body);
    if (r.status !== 200) refused(path, r.status);
    return r.data ?? {};
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const r = await this.door.call('GET', path);
    if (r.status !== 200) refused(path, r.status);
    return r.data ?? {};
  }

  async add(n: NewNotice) {
    const d = await this.post('/apps/v1/notices', n);
    return { emailOff: d.emailOff === true };
  }

  async list(userId: string, limit: number) {
    const d = await this.get(
      `/apps/v1/notices?userId=${encodeURIComponent(userId)}&limit=${limit}`,
    );
    return {
      unread: typeof d.unread === 'number' ? d.unread : 0,
      items: Array.isArray(d.items) ? (d.items as StoredNotice[]) : [],
    };
  }

  async markRead(userId: string, ids: string[] | 'all') {
    await this.post('/apps/v1/notices/read', { userId, ids });
  }

  async prefs(userId: string) {
    const d = await this.get(`/apps/v1/notices/prefs?userId=${encodeURIComponent(userId)}`);
    return Array.isArray(d.items) ? (d.items as NoticePref[]) : [];
  }

  async setPref(userId: string, pref: NoticePref) {
    await this.post('/apps/v1/notices/prefs', { userId, ...pref });
  }

  async forget(userId: string) {
    await this.post('/apps/v1/notices/forget', { userId });
  }

  async prune(before: number) {
    await this.post('/apps/v1/notices/prune', { before });
  }

  async suppressed(emailHash: string) {
    const d = await this.get(`/apps/v1/suppressions/${emailHash}`);
    return d.suppressed === true;
  }

  async suppress(emailHash: string, reason: string) {
    await this.post('/apps/v1/suppressions', { emailHash, reason });
  }

  async import(batch: NoticeImport) {
    await this.post('/apps/v1/notices/import', batch);
  }
}

/** Dev/test: the same rules in KV (one key per person, one per suppressed address). */
export class MockNotices implements NoticeStore {
  readonly name = 'mock';
  constructor(
    private kv: KVNamespace,
    private now: () => number,
  ) {}

  private async read<T>(key: string): Promise<T[]> {
    return JSON.parse((await this.kv.get(key)) ?? '[]') as T[];
  }

  private async all(userId: string) {
    return this.read<StoredNotice>(`dev:notices:${userId}`);
  }

  private async save(userId: string, items: StoredNotice[]) {
    await this.kv.put(`dev:notices:${userId}`, JSON.stringify(items));
  }

  private async keep(n: NewNotice): Promise<boolean> {
    const items = await this.all(n.userId);
    if (items.some((i) => i.id === n.id)) return false;
    items.push({
      id: n.id,
      type: n.type,
      payload: n.payload,
      readAt: n.readAt ?? null,
      createdAt: n.createdAt,
    });
    await this.save(n.userId, items);
    return true;
  }

  async add(n: NewNotice) {
    await this.keep(n);
    const off = (await this.prefs(n.userId)).some(
      (p) => p.type === n.type && p.channel === 'email' && !p.enabled,
    );
    return { emailOff: off };
  }

  async list(userId: string, limit: number) {
    const items = await this.all(userId);
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return { unread: items.filter((i) => i.readAt === null).length, items: sorted.slice(0, limit) };
  }

  async markRead(userId: string, ids: string[] | 'all') {
    const items = await this.all(userId);
    for (const i of items)
      if (i.readAt === null && (ids === 'all' || ids.includes(i.id))) i.readAt = this.now();
    await this.save(userId, items);
  }

  async prefs(userId: string) {
    return this.read<NoticePref>(`dev:notice-prefs:${userId}`);
  }

  async setPref(userId: string, pref: NoticePref) {
    const prefs = (await this.prefs(userId)).filter(
      (p) => !(p.type === pref.type && p.channel === pref.channel),
    );
    prefs.push(pref);
    await this.kv.put(`dev:notice-prefs:${userId}`, JSON.stringify(prefs));
  }

  async forget(userId: string) {
    await this.kv.delete(`dev:notices:${userId}`);
    await this.kv.delete(`dev:notice-prefs:${userId}`);
  }

  async prune(before: number) {
    const { keys } = await this.kv.list({ prefix: 'dev:notices:' });
    for (const { name } of keys) {
      const userId = name.slice('dev:notices:'.length);
      const items = await this.all(userId);
      await this.save(
        userId,
        items.filter((i) => !(i.createdAt < before && i.readAt !== null)),
      );
    }
  }

  async suppressed(emailHash: string) {
    return (await this.kv.get(`dev:suppressed:${emailHash}`)) !== null;
  }

  async suppress(emailHash: string) {
    await this.kv.put(`dev:suppressed:${emailHash}`, '1');
  }

  async import(batch: NoticeImport) {
    for (const n of batch.notices) await this.keep(n);
    for (const p of batch.prefs) {
      const has = (await this.prefs(p.userId)).some(
        (x) => x.type === p.type && x.channel === p.channel,
      );
      if (!has)
        await this.setPref(p.userId, { type: p.type, channel: p.channel, enabled: p.enabled });
    }
    for (const s of batch.suppressions) await this.suppress(s.emailHash);
  }
}
