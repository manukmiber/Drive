import { describe, expect, it } from 'vitest';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { createFolder, grantPlan, rootOf, uploadText, type NodeJson } from '../helpers/files';
import { readZip } from '../helpers/zip';
import type { DevRuntime } from '../../dev/env';
import { FakeClock } from '../../src/worker/adapters/clock';

interface ShareJson {
  id: string;
  url: string;
  kind: string;
  downloadCount: number;
  hasPassword: boolean;
}

async function setup(email = 'share@example.com', clock?: FakeClock) {
  const rt = await makeRuntime(clock ? { clock } : {});
  const s = await signIn(rt, email);
  await grantPlan(rt, s.userId);
  const root = await rootOf(s);
  return { rt, s, root };
}

async function share(s: Session, body: Record<string, unknown>): Promise<ShareJson> {
  const res = await s.req('POST', '/api/shares', body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { share: ShareJson }).share;
}

const visit = (rt: DevRuntime, url: string, init: RequestInit = {}) =>
  rt.fetch(
    new Request(url, {
      headers: { 'user-agent': 'Mozilla/5.0 test', ...(init.headers as Record<string, string>) },
      ...init,
    }),
  );

describe('share links (SPEC §6.1)', () => {
  it('downloads a shared file in one click and counts it once per visitor', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'Laporan Q3.pdf', 'isi laporan');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    expect(sh.url).toMatch(new RegExp(`^${APP}/[0-9A-Za-z]{64}/[0-9A-Za-z]{32}/Laporan%20Q3.pdf$`));
    const res = await visit(rt, sh.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('isi laporan');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    await visit(rt, sh.url); // same visitor within the dedupe window
    await visit(rt, sh.url, { headers: { range: 'bytes=4-' } }); // resume, never counted
    const row = rt.d1.sqlite
      .prepare('SELECT download_count FROM shares WHERE id = ?')
      .get(sh.id) as { download_count: number };
    expect(row.download_count).toBe(1);
  });

  it('rejects forged signatures before touching D1', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    const parts = new URL(sh.url).pathname.split('/');
    const forged = `${APP}/${parts[1]}/${'A'.repeat(32)}/a.txt`;
    let queries = 0;
    const orig = rt.env.DB.prepare.bind(rt.env.DB);
    rt.env.DB.prepare = (q: string) => {
      queries++;
      return orig(q);
    };
    const res = await visit(rt, forged);
    rt.env.DB.prepare = orig;
    expect(res.status).toBe(404);
    expect(queries).toBe(0);
  });

  it('enforces password, expiry, download limit and revoke', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1));
    const { rt, s, root } = await setup('pw@example.com', clock);
    const f = await uploadText(s, root, 'rahasia.txt', 'top secret');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id], password: 'kopi123', maxDownloads: 1 });
    const first = await visit(rt, sh.url);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('dilindungi password');
    const wrong = await visit(rt, sh.url, {
      method: 'POST',
      body: new URLSearchParams({ password: 'salah' }),
    });
    expect(wrong.status).toBe(401);
    const ok = await visit(rt, sh.url, {
      method: 'POST',
      body: new URLSearchParams({ password: 'kopi123' }),
    });
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    const dl = await visit(rt, sh.url, { headers: { cookie } });
    expect(await dl.text()).toBe('top secret');
    // Limit reached → other visitors are refused
    const other = await visit(rt, sh.url, {
      headers: { cookie, 'user-agent': 'Other/1.0', 'cf-connecting-ip': '10.0.0.9' },
    });
    expect(other.status).toBe(410);

    const sh2 = await share(s, { nodeIds: [f.id], expiresInHours: 1 });
    clock.advance(2 * 3600_000);
    expect((await visit(rt, sh2.url)).status).toBe(410);

    const sh3 = await share(s, { nodeIds: [f.id], expiresInHours: null });
    expect((await s.req('DELETE', `/api/shares/${sh3.id}`)).status).toBe(204);
    expect((await visit(rt, sh3.url)).status).toBe(410);
  });

  it('regenerates a link (old one dies) and serves bots Open Graph HTML without counting', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'foto.jpg', 'jpg');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    const bot = await visit(rt, sh.url, { headers: { 'user-agent': 'WhatsApp/2.23.20.0' } });
    expect(await bot.text()).toContain('og:title');
    const fresh = (
      (await (await s.req('POST', `/api/shares/${sh.id}/regenerate`)).json()) as {
        share: ShareJson;
      }
    ).share;
    expect(fresh.id).not.toBe(sh.id);
    expect((await visit(rt, sh.url)).status).toBe(410);
    expect((await visit(rt, fresh.url)).status).toBe(200);
  });

  it('streams a shared folder as a valid ZIP (store), with Range support', async () => {
    const { rt, s, root } = await setup();
    const folder = await createFolder(s, root, 'Tugas');
    const sub = await createFolder(s, folder.id, 'Bab 1');
    await uploadText(s, folder.id, 'catatan.txt', 'halo dunia');
    await uploadText(s, sub.id, 'isi.md', '# Bab 1');
    await rt.settle();
    const sh = await share(s, { nodeIds: [folder.id] });
    expect(sh.kind).toBe('folder');
    const res = await visit(rt, sh.url);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(readZip(bytes)).toEqual({
      'Tugas/': null,
      'Tugas/Bab 1/': null,
      'Tugas/catatan.txt': 'halo dunia',
      'Tugas/Bab 1/isi.md': '# Bab 1',
    });
    const part = await visit(rt, sh.url, { headers: { range: 'bytes=10-29' } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 30));
  });

  it("lists a folder's files when asked, each downloadable alone, the ZIP still there (ADR-054)", async () => {
    const { rt, s, root } = await setup('listing@example.com');
    const folder = await createFolder(s, root, 'Album <Liburan>');
    const sub = await createFolder(s, folder.id, 'Hari 2');
    const a = await uploadText(s, folder.id, 'pantai.txt', 'ombak');
    await uploadText(s, sub.id, 'gunung.txt', 'kabut');
    const outside = await uploadText(s, root, 'di-luar.txt', 'jangan');
    await rt.settle();
    const sh = (
      (await (
        await s.req('POST', '/api/shares', { nodeIds: [folder.id], showListing: true })
      ).json()) as { share: ShareJson & { showListing: boolean } }
    ).share;
    expect(sh.showListing).toBe(true);

    const page = await visit(rt, sh.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Album &lt;Liburan&gt;');
    expect(html).not.toContain('<Liburan>');
    expect(html).toContain('pantai.txt');
    expect(html).toContain('Album &lt;Liburan&gt;/Hari 2');
    const count = () =>
      (
        rt.d1.sqlite.prepare('SELECT download_count FROM shares WHERE id = ?').get(sh.id) as {
          download_count: number;
        }
      ).download_count;
    expect(count()).toBe(0); // looking is not downloading

    const links = [...html.matchAll(/href="([^"]+\/f\/[^"]+)"/g)].map((m) => m[1]!);
    expect(links).toHaveLength(2);
    const one = await visit(rt, `${APP}${links.find((l) => l.includes(a.id))!}`);
    expect(one.status).toBe(200);
    expect(await one.text()).toBe('ombak');
    expect(one.headers.get('content-disposition')).toContain('attachment');
    expect(count()).toBe(1);

    // A file of the owner's that is not in the share, through the same link: no.
    const base = new URL(sh.url).pathname.split('/').slice(0, 3).join('/');
    expect((await visit(rt, `${APP}${base}/f/${outside.id}/x.txt`)).status).toBe(404);

    const zip = await visit(rt, `${sh.url}?all=1`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(readZip(new Uint8Array(await zip.arrayBuffer()))).toMatchObject({
      'Album _Liburan_/pantai.txt': 'ombak',
      'Album _Liburan_/Hari 2/gunung.txt': 'kabut',
    });

    // Switched off: straight to the ZIP again, and the per-file links stop.
    await s.req('PATCH', `/api/shares/${sh.id}`, { showListing: false });
    expect((await visit(rt, sh.url)).headers.get('content-type')).toBe('application/zip');
    expect((await visit(rt, `${APP}${links[0]!}`)).status).toBe(404);
  });

  it('keeps the password in front of listed files, and never lists a single file', async () => {
    const { rt, s, root } = await setup('listing-pw@example.com');
    const folder = await createFolder(s, root, 'Kontrak');
    const f = await uploadText(s, folder.id, 'draf.txt', 'pasal 1');
    await rt.settle();
    const sh = await share(s, { nodeIds: [folder.id], showListing: true, password: 'teh-manis' });
    const base = new URL(sh.url).pathname.split('/').slice(0, 3).join('/');
    const direct = await visit(rt, `${APP}${base}/f/${f.id}/draf.txt`);
    expect(direct.status).toBe(303);
    expect(direct.headers.get('location')).toBe(`${base}/Kontrak`);
    const ok = await visit(rt, sh.url, {
      method: 'POST',
      body: new URLSearchParams({ password: 'teh-manis' }),
    });
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await visit(rt, sh.url, { headers: { cookie } })).text()).toContain('draf.txt');
    const dl = await visit(rt, `${APP}${base}/f/${f.id}/draf.txt`, { headers: { cookie } });
    expect(await dl.text()).toBe('pasal 1');

    const single = (
      (await (
        await s.req('POST', '/api/shares', { nodeIds: [f.id], showListing: true })
      ).json()) as {
        share: ShareJson & { showListing: boolean };
      }
    ).share;
    expect(single.showListing).toBe(false);
    expect(await (await visit(rt, single.url)).text()).toBe('pasal 1');
    // A new link keeps the setting.
    const again = (
      (await (await s.req('POST', `/api/shares/${sh.id}/regenerate`)).json()) as {
        share: ShareJson & { showListing: boolean };
      }
    ).share;
    expect(again.showListing).toBe(true);
  });

  it('only the owner manages a share; others cannot share foreign nodes', async () => {
    const { rt, s, root } = await setup();
    const other = await signIn(rt, 'eve@example.com');
    await grantPlan(rt, other.userId);
    const f = await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    expect((await other.req('GET', `/api/shares/${sh.id}`)).status).toBe(404);
    expect((await other.req('DELETE', `/api/shares/${sh.id}`)).status).toBe(404);
    expect((await other.req('POST', '/api/shares', { nodeIds: [f.id] })).status).toBe(404);
  });
});

describe('sending links (SPEC §6.3–6.5)', () => {
  it('emails a link through the notify queue and honours unsubscribe', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    const res = await s.req('POST', `/api/shares/${sh.id}/sends`, {
      mode: 'email',
      recipients: ['teman@example.com'],
      message: 'Ini filenya ya',
    });
    expect(await res.json()).toEqual({ queued: 1, suppressed: 0 });
    await rt.settle();
    const { mails } = (await (await rt.fetch(new Request(`${APP}/__dev/mail`))).json()) as {
      mails: Array<{ to: string[]; subject: string; text: string }>;
    };
    const m = mails.find((x) => x.to.includes('teman@example.com'))!;
    expect(m.subject).toContain('membagikan file');
    expect(m.text).toContain(sh.url);
    const unsub = /\/berhenti\/[^\s]+/.exec(m.text)![0];
    expect((await rt.fetch(new Request(`${APP}${unsub}`, { method: 'POST' }))).status).toBe(204);
    const again = await s.req('POST', `/api/shares/${sh.id}/sends`, {
      mode: 'email',
      recipients: ['teman@example.com'],
    });
    expect(await again.json()).toEqual({ queued: 0, suppressed: 1 });
    const row = rt.d1.sqlite
      .prepare("SELECT recipient_masked FROM share_sends WHERE channel = 'email' LIMIT 1")
      .get() as { recipient_masked: string };
    expect(row.recipient_masked).toBe('te***@example.com');
  });

  it('normalises WhatsApp numbers for deeplinks', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    const sh = await share(s, { nodeIds: [f.id] });
    const res = await s.req('POST', `/api/shares/${sh.id}/sends`, {
      mode: 'deeplink',
      channel: 'whatsapp',
      recipient: '0812-3456-7890',
    });
    expect(((await res.json()) as { recipient: string }).recipient).toBe('6281234567890');
    const bad = await s.req('POST', `/api/shares/${sh.id}/sends`, {
      mode: 'deeplink',
      channel: 'whatsapp',
      recipient: '12345',
    });
    expect(bad.status).toBe(400);
  });
});

describe('multi-file ZIP download (SPEC §7.2)', () => {
  it('builds signed /z/ links for store and deflate ZIPs', async () => {
    const { rt, s, root } = await setup();
    const a = await uploadText(s, root, 'a.txt', 'aaaa'.repeat(100));
    const b = await uploadText(s, root, 'b.txt', 'bbb');
    await rt.settle();
    for (const format of ['zip_store', 'zip_deflate'] as const) {
      const res = await s.req('POST', '/api/archives', { nodeIds: [a.id, b.id], format });
      expect(res.status).toBe(201);
      const { url } = (await res.json()) as { url: string };
      expect(url).toMatch(/^\/z\/.+\.zip$/);
      const dl = await rt.fetch(new Request(`${APP}${url}`));
      expect(dl.status).toBe(200);
      expect(readZip(new Uint8Array(await dl.arrayBuffer()))).toEqual({
        'a.txt': 'aaaa'.repeat(100),
        'b.txt': 'bbb',
      });
    }
    const other = await signIn(rt, 'x@example.com');
    expect((await other.req('POST', '/api/archives', { nodeIds: [a.id] })).status).toBe(404);
    expect((await rt.fetch(new Request(`${APP}/z/garbage/x.zip`))).status).toBe(410);
  });
});

export type { NodeJson };
