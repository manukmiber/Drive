// D9 (ADR-089): Drive over WebDAV on its own host, signed in with an email and an access token that
// has the webdav scope. Reads come from the person's index; writes go through the app's services.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { clark, parseXml, type XmlNode } from '../../src/worker/lib/dav-xml';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { grantPlan, pool, rootOf } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const DAV = 'https://dav.zeiko.test';
const SAYA = '/Drive%20Saya';

const basic = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

interface Who {
  rt: DevRuntime;
  user: Session;
  email: string;
  token: string;
  call: (
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: string | Uint8Array },
  ) => Promise<Response>;
}

async function tokenFor(user: Session, scopes: string[]): Promise<string> {
  const res = await user.req('POST', '/api/tokens', { name: 'dav', scopes, expiresInDays: null });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

function caller(rt: DevRuntime, auth: string | null): Who['call'] {
  return (method, path, init = {}) => {
    const body = init.body;
    const headers: Record<string, string> = {
      ...(auth ? { authorization: auth } : {}),
      ...(body !== undefined
        ? {
            'content-length': String(
              typeof body === 'string' ? new TextEncoder().encode(body).length : body.length,
            ),
          }
        : {}),
      ...init.headers,
    };
    return rt.fetch(new Request(`${DAV}${path}`, { method, headers, body: body ?? null }));
  };
}

async function person(rt: DevRuntime, email: string, scopes = ['webdav']): Promise<Who> {
  const user = await signIn(rt, email);
  await grantPlan(rt, user.userId);
  const token = await tokenFor(user, scopes);
  return { rt, user, email, token, call: caller(rt, basic(email, token)) };
}

async function setup() {
  const rt = await makeRuntime({ vars: { DAV_ORIGIN: DAV } });
  return { rt, a: await person(rt, 'dav@example.com') };
}

/** href → { status, props } of a multistatus. */
async function multistatus(res: Response) {
  expect(res.status, await res.clone().text()).toBe(207);
  expect(res.headers.get('content-type')).toContain('application/xml');
  const doc = parseXml(await res.text());
  expect(clark(doc)).toBe('{DAV:}multistatus');
  const out = new Map<string, Map<string, { status: number; node: XmlNode }>>();
  for (const r of doc.children) {
    const href = r.children.find((c) => c.local === 'href')!.text;
    const props = new Map<string, { status: number; node: XmlNode }>();
    for (const ps of r.children.filter((c) => c.local === 'propstat')) {
      const status = Number(
        /HTTP\/1\.1 (\d+)/.exec(ps.children.find((c) => c.local === 'status')!.text)![1],
      );
      for (const p of ps.children.find((c) => c.local === 'prop')!.children)
        props.set(p.local, { status, node: p });
    }
    out.set(decodeURIComponent(href), props);
  }
  return out;
}

const propText = (m: Map<string, { status: number; node: XmlNode }> | undefined, name: string) =>
  m?.get(name)?.status === 200 ? m.get(name)!.node.text : undefined;

describe('WebDAV (D9, ADR-089)', () => {
  it('answers OPTIONS without signing in, and nothing else', async () => {
    const { rt, a } = await setup();
    const anon = caller(rt, null);
    const opt = await anon('OPTIONS', '/');
    expect(opt.status).toBe(200);
    expect(opt.headers.get('dav')).toBe('1, 2');
    expect(opt.headers.get('allow')).toContain('PROPFIND');

    const res = await anon('PROPFIND', '/', { headers: { depth: '0' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');

    // The app's session cookie means nothing on this host.
    const cookie = await rt.fetch(
      new Request(`${DAV}/`, { method: 'PROPFIND', headers: { cookie: a.user.jar.header() } }),
    );
    expect(cookie.status).toBe(401);
  });

  it('wants the token owner email, a working token and the webdav scope', async () => {
    const { rt, a } = await setup();
    expect((await caller(rt, basic('orang@lain.com', a.token))('PROPFIND', '/')).status).toBe(401);
    expect((await caller(rt, basic(a.email, 'rahasia'))('PROPFIND', '/')).status).toBe(401);
    expect(
      (
        await caller(rt, basic(a.email.toUpperCase(), a.token))('PROPFIND', '/', {
          headers: { depth: '0' },
        })
      ).status,
    ).toBe(207);
    expect(
      (await caller(rt, `Bearer ${a.token}`)('PROPFIND', '/', { headers: { depth: '0' } })).status,
    ).toBe(207);

    const readOnly = await tokenFor(a.user, ['drive.read']);
    expect((await caller(rt, basic(a.email, readOnly))('PROPFIND', '/')).status).toBe(401);

    // Revoked → refused at once.
    const id = (
      (await (await a.user.req('GET', '/api/tokens')).json()) as { tokens: Array<{ id: string }> }
    ).tokens[0]!.id;
    for (const t of (
      (await (await a.user.req('GET', '/api/tokens')).json()) as { tokens: Array<{ id: string }> }
    ).tokens)
      expect((await a.user.req('DELETE', `/api/tokens/${t.id}`)).status).toBe(204);
    expect(id).toBeTruthy();
    expect((await a.call('PROPFIND', '/', { headers: { depth: '0' } })).status).toBe(401);
  });

  it('lists the spaces at the top with quota, and refuses Depth: infinity', async () => {
    const { a } = await setup();
    const top = await multistatus(
      await a.call('PROPFIND', '/', {
        headers: { depth: '1' },
        body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:quota-used-bytes/><D:quota-available-bytes/><D:getcontentlength/></D:prop></D:propfind>`,
      }),
    );
    expect([...top.keys()]).toEqual(['/', '/Drive Saya/']);
    const saya = top.get('/Drive Saya/')!;
    expect(saya.get('resourcetype')!.node.children[0]!.local).toBe('collection');
    expect(Number(propText(saya, 'quota-available-bytes'))).toBeGreaterThan(0);
    expect(propText(saya, 'quota-used-bytes')).toBe('0');
    expect(saya.get('getcontentlength')!.status).toBe(404);

    const inf = await a.call('PROPFIND', `${SAYA}/`, { headers: { depth: 'infinity' } });
    expect(inf.status).toBe(403);
    expect(await inf.text()).toContain('propfind-finite-depth');
  });

  it('makes folders and files, reads them back with Range, and replaces content as a version', async () => {
    const { rt, a } = await setup();
    expect((await a.call('MKCOL', `${SAYA}/Foto`)).status).toBe(201);
    expect((await a.call('MKCOL', `${SAYA}/Foto`)).status).toBe(405);
    expect((await a.call('MKCOL', `${SAYA}/Tidak/Ada`)).status).toBe(409);
    expect((await a.call('MKCOL', '/Lain')).status).toBe(403);

    const put = await a.call('PUT', `${SAYA}/Foto/catatan.txt`, {
      body: 'halo dunia',
      headers: { 'content-type': 'application/octet-stream', 'x-oc-mtime': '1735725600' },
    });
    expect(put.status).toBe(201);
    expect((await a.call('PUT', `${SAYA}/Foto`, { body: 'x' })).status).toBe(405);
    expect((await a.call('PUT', `${SAYA}/Tidak/Ada.txt`, { body: 'x' })).status).toBe(409);

    const list = await multistatus(
      await a.call('PROPFIND', `${SAYA}/Foto`, { headers: { depth: '1' } }),
    );
    const file = list.get('/Drive Saya/Foto/catatan.txt')!;
    expect(propText(file, 'getcontentlength')).toBe('10');
    expect(propText(file, 'getcontenttype')).toBe('text/plain');
    expect(propText(file, 'getlastmodified')).toBe(new Date(1735725600_000).toUTCString());
    const etag = propText(file, 'getetag')!;

    // The uploader may read it while it is scanned, as in the app.
    const got = await a.call('GET', `${SAYA}/Foto/catatan.txt`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('halo dunia');
    expect(got.headers.get('etag')).toBe(etag);
    const part = await a.call('GET', `${SAYA}/foto/CATATAN.txt`, {
      headers: { range: 'bytes=5-9' },
    });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('dunia');

    await rt.settle();
    const again = await a.call('PUT', `${SAYA}/Foto/catatan.txt`, { body: 'halo semua' });
    expect(again.status).toBe(204);
    await rt.settle();
    expect(await (await a.call('GET', `${SAYA}/Foto/catatan.txt`)).text()).toBe('halo semua');
    const versions = rt.d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'version'")
      .get() as { n: number };
    expect(versions.n).toBe(1);
  });

  it('turns the Windows empty-file-first PUT into one file, with no version and nothing in the Trash', async () => {
    const { rt, a } = await setup();
    // LOCK on a new path makes the empty file Windows then writes into.
    const lock = await a.call('LOCK', `${SAYA}/laporan.docx`, {
      headers: { depth: '0', timeout: 'Second-3600' },
      body: `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>PC\\budi</D:href></D:owner></D:lockinfo>`,
    });
    expect(lock.status).toBe(201);
    const token = lock.headers.get('lock-token')!;
    expect(token).toMatch(/^<opaquelocktoken:[0-9a-f-]+>$/);
    expect(await lock.text()).toContain('PC\\budi');
    expect((await a.call('PUT', `${SAYA}/laporan.docx`, { body: '' })).status).toBe(201);
    await rt.settle();
    expect(
      (
        await a.call('PUT', `${SAYA}/laporan.docx`, {
          body: 'isi laporan',
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await a.call('PROPPATCH', `${SAYA}/laporan.docx`, {
          body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32CreationTime>Mon, 02 Jun 2025 01:00:00 GMT</Z:Win32CreationTime><Z:Win32LastModifiedTime>Mon, 02 Jun 2025 03:04:05 GMT</Z:Win32LastModifiedTime><Z:Win32FileAttributes>00000020</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>`,
        })
      ).status,
    ).toBe(207);
    expect(
      (await a.call('UNLOCK', `${SAYA}/laporan.docx`, { headers: { 'lock-token': token } })).status,
    ).toBe(204);
    const rows = rt.d1.sqlite
      .prepare(
        "SELECT kind, size, trashed_at, client_modified_at FROM nodes WHERE name = 'laporan.docx' OR kind = 'version'",
      )
      .all() as Array<{
      kind: string;
      size: number;
      trashed_at: number | null;
      client_modified_at: number;
    }>;
    expect(rows).toEqual([
      {
        kind: 'file',
        size: 11,
        trashed_at: null,
        client_modified_at: Date.parse('2025-06-02T03:04:05Z'),
      },
    ]);
    const prop = await multistatus(
      await a.call('PROPFIND', `${SAYA}/laporan.docx`, { headers: { depth: '0' } }),
    );
    expect(propText(prop.get('/Drive Saya/laporan.docx'), 'getlastmodified')).toBe(
      'Mon, 02 Jun 2025 03:04:05 GMT',
    );
    expect(propText(prop.get('/Drive Saya/laporan.docx'), 'getcontenttype')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('moves and renames, keeps Overwrite: F, and puts what is overwritten or deleted in the Trash', async () => {
    const { rt, a } = await setup();
    await a.call('MKCOL', `${SAYA}/A`);
    await a.call('MKCOL', `${SAYA}/B`);
    await a.call('PUT', `${SAYA}/A/satu.txt`, { body: '1' });
    await a.call('PUT', `${SAYA}/B/dua.txt`, { body: '2' });
    await rt.settle();

    expect(
      (
        await a.call('MOVE', `${SAYA}/A/satu.txt`, {
          headers: { destination: `${DAV}${SAYA}/B/dua.txt`, overwrite: 'F' },
        })
      ).status,
    ).toBe(412);
    const moved = await a.call('MOVE', `${SAYA}/A/satu.txt`, {
      headers: { destination: `${DAV}${SAYA}/B/tiga.txt` },
    });
    expect(moved.status).toBe(201);
    expect((await a.call('GET', `${SAYA}/A/satu.txt`)).status).toBe(404);
    expect(await (await a.call('GET', `${SAYA}/B/tiga.txt`)).text()).toBe('1');

    // Rename in place, only the case.
    expect(
      (
        await a.call('MOVE', `${SAYA}/B/tiga.txt`, {
          headers: { destination: `${SAYA}/B/TIGA.txt` },
        })
      ).status,
    ).toBe(201);
    const listed = await multistatus(
      await a.call('PROPFIND', `${SAYA}/B`, { headers: { depth: '1' } }),
    );
    expect([...listed.keys()].sort()).toEqual([
      '/Drive Saya/B/',
      '/Drive Saya/B/TIGA.txt',
      '/Drive Saya/B/dua.txt',
    ]);

    // Over an existing file: that one goes to the Trash.
    expect(
      (
        await a.call('MOVE', `${SAYA}/B/TIGA.txt`, {
          headers: { destination: `${SAYA}/B/dua.txt` },
        })
      ).status,
    ).toBe(204);
    expect(await (await a.call('GET', `${SAYA}/B/dua.txt`)).text()).toBe('1');

    // A folder into itself, and to another server.
    expect(
      (await a.call('MOVE', `${SAYA}/B`, { headers: { destination: `${SAYA}/B/dalam` } })).status,
    ).toBe(403);
    expect(
      (
        await a.call('MOVE', `${SAYA}/B`, {
          headers: { destination: 'https://lain.example/Drive%20Saya/X' },
        })
      ).status,
    ).toBe(502);

    expect((await a.call('DELETE', `${SAYA}/A`)).status).toBe(204);
    expect((await a.call('DELETE', SAYA)).status).toBe(403);
    const trash = (await (await a.user.req('GET', '/api/trash')).json()) as {
      items: Array<{ name: string }>;
    };
    expect(trash.items.map((i) => i.name).sort()).toEqual(['A', 'dua.txt']);
  });

  it('copies files without new bytes and folders item by item, counting quota', async () => {
    const { rt, a } = await setup();
    await a.call('MKCOL', `${SAYA}/Asal`);
    await a.call('MKCOL', `${SAYA}/Asal/Dalam`);
    await a.call('PUT', `${SAYA}/Asal/x.txt`, { body: 'xxxx' });
    await a.call('PUT', `${SAYA}/Asal/Dalam/y.txt`, { body: 'yy' });
    await rt.settle();
    const poolId = (
      rt.d1.sqlite
        .prepare("SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?")
        .get(a.user.userId) as { id: string }
    ).id;
    expect(pool(rt, poolId).used_bytes).toBe(6);

    expect(
      (
        await a.call('COPY', `${SAYA}/Asal/x.txt`, {
          headers: { destination: `${SAYA}/salinan.txt` },
        })
      ).status,
    ).toBe(201);
    expect(await (await a.call('GET', `${SAYA}/salinan.txt`)).text()).toBe('xxxx');
    expect(
      (await a.call('COPY', `${SAYA}/Asal`, { headers: { destination: `${SAYA}/Tujuan` } })).status,
    ).toBe(201);
    expect(await (await a.call('GET', `${SAYA}/Tujuan/Dalam/y.txt`)).text()).toBe('yy');
    expect(pool(rt, poolId).used_bytes).toBe(16);
    expect(
      (
        await a.call('COPY', `${SAYA}/Asal`, {
          headers: { destination: `${SAYA}/Asal/Dalam/Lagi` },
        })
      ).status,
    ).toBe(403);
    // Depth 0: the folder alone.
    expect(
      (
        await a.call('COPY', `${SAYA}/Asal`, {
          headers: { destination: `${SAYA}/Kosong`, depth: '0' },
        })
      ).status,
    ).toBe(201);
    const empty = await multistatus(
      await a.call('PROPFIND', `${SAYA}/Kosong`, { headers: { depth: '1' } }),
    );
    expect(empty.size).toBe(1);
  });

  it('says 507 when the storage is full and 413 past the WebDAV size cap', async () => {
    const { rt, a } = await setup();
    const poolId = (
      rt.d1.sqlite
        .prepare("SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?")
        .get(a.user.userId) as { id: string }
    ).id;
    rt.d1.sqlite.prepare('UPDATE storage_pools SET limit_bytes = 5 WHERE id = ?').run(poolId);
    expect((await a.call('PUT', `${SAYA}/besar.txt`, { body: '123456' })).status).toBe(507);

    rt.d1.sqlite.prepare('UPDATE storage_pools SET limit_bytes = 1000000 WHERE id = ?').run(poolId);
    rt.d1.sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES ('webdav_put_max_bytes', '4', 'test', 0)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run();
    await rt.env.CONFIG_KV.delete('config:v1');
    invalidateConfigMemo(rt.env);
    const big = await a.call('PUT', `${SAYA}/besar.txt`, { body: '12345' });
    expect(big.status).toBe(413);
    expect(await big.text()).toContain('WebDAV');
    expect((await a.call('PUT', `${SAYA}/kecil.txt`, { body: '1234' })).status).toBe(201);
    // No length at all.
    const chunked = await rt.fetch(
      new Request(`${DAV}${SAYA}/x.txt`, {
        method: 'PUT',
        headers: { authorization: basic(a.email, a.token) },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('ab'));
            c.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );
    expect(chunked.status).toBe(411);
  });

  it('keeps each person to their own Drive, and shows the family space to its members', async () => {
    const { rt, a } = await setup();
    await a.call('MKCOL', `${SAYA}/Rahasia`);
    await a.call('PUT', `${SAYA}/Rahasia/ktp.txt`, { body: 'data' });
    const b = await person(rt, 'lain@example.com');
    const bTop = await multistatus(
      await b.call('PROPFIND', `${SAYA}/`, { headers: { depth: '1' } }),
    );
    expect([...bTop.keys()]).toEqual(['/Drive Saya/']);
    expect((await b.call('GET', `${SAYA}/Rahasia/ktp.txt`)).status).toBe(404);
    expect(
      (await b.call('PROPFIND', '/Drive%20Keluarga/', { headers: { depth: '0' } })).status,
    ).toBe(404);
    // B's token with A's email is refused before anything is read.
    expect(
      (await caller(rt, basic(a.email, b.token))('GET', `${SAYA}/Rahasia/ktp.txt`)).status,
    ).toBe(401);
    // A locked account (unpaid past the grace period) cannot read over WebDAV either.
    rt.d1.sqlite
      .prepare("UPDATE subscriptions SET status = 'suspended' WHERE id = ?")
      .run(`sub_${a.user.userId}`);
    expect((await a.call('PROPFIND', `${SAYA}/`, { headers: { depth: '1' } })).status).toBe(403);
    expect(await rootOf(a.user)).toBeTruthy();
  });
});
