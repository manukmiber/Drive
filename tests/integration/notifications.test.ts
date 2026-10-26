import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import { noticesOf } from '../helpers/notices';
import { CRON } from '../../src/shared/constants';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('notifications (SPEC §13.2)', () => {
  it('quota 80/95/100% notices fire once per threshold and show in the bell', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'kuota@example.com');
    await grantPlan(rt, s.userId, 'plus', 100);
    const root = await rootOf(s);
    await uploadText(s, root, 'a.txt', 'x'.repeat(85));
    await rt.settle();
    await uploadText(s, root, 'b.txt', 'x'.repeat(5));
    await rt.settle();
    await uploadText(s, root, 'c.txt', 'x'.repeat(2));
    await rt.settle();
    const bell = (await (await s.req('GET', '/api/notifications')).json()) as {
      unread: number;
      items: Array<{ type: string; title: string }>;
    };
    expect(bell.items.filter((i) => i.type === 'quota').map((i) => i.title)).toEqual([
      'Penyimpanan terpakai 80%',
    ]);
    await uploadText(s, root, 'd.txt', 'x'.repeat(5));
    await rt.settle();
    const after = (await (await s.req('GET', '/api/notifications')).json()) as {
      unread: number;
      items: Array<{ type: string; title: string }>;
    };
    expect(after.items.filter((i) => i.type === 'quota').map((i) => i.title)).toEqual([
      'Penyimpanan terpakai 95%',
      'Penyimpanan terpakai 80%',
    ]);
    await s.req('POST', '/api/notifications/read', { ids: 'all' });
    expect(
      ((await (await s.req('GET', '/api/notifications')).json()) as { unread: number }).unread,
    ).toBe(0);
  });

  it('rejected files are delivered by email unless the user opted out', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'pilih@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const mails = async () =>
      (
        (await (await rt.fetch(new Request('http://localhost:5173/__dev/mail'))).json()) as {
          mails: Array<{ to: string[]; subject: string }>;
        }
      ).mails.filter((m) => m.to.includes('pilih@example.com') && m.subject.includes('ditolak'));
    await uploadText(s, root, 'v1.com', EICAR);
    await rt.settle();
    expect(await mails()).toHaveLength(1);
    expect(
      (
        await s.req('PUT', '/api/notifications/prefs', {
          type: 'file_rejected',
          channel: 'email',
          enabled: false,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await s.req('PUT', '/api/notifications/prefs', {
          type: 'billing_reminder',
          channel: 'email',
          enabled: false,
        })
      ).status,
    ).toBe(400);
    // Email is the only channel out of the app (ADR-041).
    expect(
      (
        await s.req('PUT', '/api/notifications/prefs', {
          type: 'file_rejected',
          channel: 'telegram',
          enabled: true,
        })
      ).status,
    ).toBe(400);
    await uploadText(s, root, 'v2.com', `${EICAR} `);
    await rt.settle();
    expect(await mails()).toHaveLength(1);
    const prefs = (await (await s.req('GET', '/api/notifications/prefs')).json()) as {
      items: Array<{ type: string; email: boolean; emailLocked: boolean }>;
    };
    expect(prefs.items.find((p) => p.type === 'file_rejected')).toMatchObject({ email: false });
    expect(prefs.items.find((p) => p.type === 'billing_reminder')).toMatchObject({
      email: true,
      emailLocked: true,
    });
    expect(prefs.items.some((p) => 'telegram' in p)).toBe(false);
  });
});

describe('notices moved to the relay (ADR-064)', () => {
  it('brings the old D1 rows over and empties the tables', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'pindah@example.com');
    const hash = 'c'.repeat(64);
    rt.d1.sqlite
      .prepare(
        `INSERT INTO notifications (id, user_id, type, payload_json, read_at, created_at) VALUES ('old1', ?, 'quota', '{"pct":80}', 7, 5)`,
      )
      .run(s.userId);
    rt.d1.sqlite
      .prepare(
        `INSERT INTO notification_prefs (user_id, type, channel, enabled) VALUES (?, 'quota', 'email', 0)`,
      )
      .run(s.userId);
    rt.d1.sqlite
      .prepare(
        `INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, 'unsubscribe', 1)`,
      )
      .run(hash);
    const { ran, failed } = await rt.runCron(CRON.hourly);
    expect(failed).toEqual([]);
    expect(ran).toContain('move_notices_to_relay');
    for (const t of ['notifications', 'notification_prefs', 'email_suppressions'])
      expect(rt.d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    expect(await noticesOf(rt, s.userId)).toMatchObject([
      { id: 'old1', type: 'quota', payload: { pct: 80 }, read_at: 7 },
    ]);
    const prefs = (await (await s.req('GET', '/api/notifications/prefs')).json()) as {
      items: Array<{ type: string; email: boolean }>;
    };
    expect(prefs.items.find((p) => p.type === 'quota')?.email).toBe(false);
    expect(await rt.kv.get(`dev:suppressed:${hash}`)).toBe('1');
  });

  it('delivers a notice queued before the move from the old table', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'antre@example.com');
    rt.d1.sqlite
      .prepare(
        `INSERT INTO notifications (id, user_id, type, payload_json, created_at) VALUES ('legacy1', ?, 'archive_ready', '{"name":"a.zip","bytes":5}', 9)`,
      )
      .run(s.userId);
    await rt.env.NOTIFY_QUEUE.send({ type: 'notification', notificationId: 'legacy1' });
    expect((await noticesOf(rt, s.userId)).map((n) => n.id)).toEqual(['legacy1']);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({
      n: 0,
    });
  });

  it('dropped the tables nothing used', async () => {
    const rt = await makeRuntime();
    const names = rt.d1.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('telegram_links', 'contacts')`,
      )
      .all();
    expect(names).toEqual([]);
  });
});
