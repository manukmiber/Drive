import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';

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
          type: 'invoice',
          channel: 'email',
          enabled: false,
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
    expect(prefs.items.find((p) => p.type === 'invoice')).toMatchObject({
      email: true,
      emailLocked: true,
    });
  });
});
