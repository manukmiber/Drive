// D3 (ADR-086): file request links: anyone may only upload into one folder, through the link.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { createFolder, grantPlan, pool, rootOf, uploadText } from '../helpers/files';
import { noticesOf } from '../helpers/notices';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const enc = new TextEncoder();

interface RequestDto {
  id: string;
  url: string;
  state: string;
  fileCount: number;
}

async function setup(limitBytes?: number) {
  const clock = new FakeClock(Date.UTC(2026, 10, 1, 3, 0));
  const rt = await makeRuntime({ clock });
  const owner = await signIn(rt, 'peminta@example.com');
  const poolId = await grantPlan(rt, owner.userId, 'plus', limitBytes);
  const root = await rootOf(owner);
  const folder = await createFolder(owner, root, 'Tugas Kelas');
  await uploadText(owner, folder.id, 'milik-guru.txt', 'jangan dilihat');
  await rt.settle();
  return { rt, clock, owner, poolId, root, folder };
}

async function makeRequest(s: Session, folderId: string, extra: Record<string, unknown> = {}) {
  const res = await s.req('POST', '/api/file-requests', {
    folderId,
    title: 'Kumpulkan PR',
    ...extra,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { request: RequestDto }).request;
}

/** The path part of a request link: /minta/{r64}/{s32}. */
const api = (r: RequestDto) => `/api/public/requests/${r.url.split('/minta/')[1]}`;

async function anon(rt: DevRuntime, method: string, path: string, body?: unknown, headers = {}) {
  return rt.fetch(
    new Request(`${APP}${path}`, {
      method,
      headers: {
        origin: APP,
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { 'content-type': 'application/json' }
          : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    }),
  );
}

/** An uploader sends one file the way the public page does: start, parts, complete. */
async function drop(
  rt: DevRuntime,
  r: RequestDto,
  name: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const bytes = enc.encode(text);
  const { password, ...rest } = extra;
  const opened = await anon(rt, 'POST', `${api(r)}/pass`, { password });
  if (opened.status !== 200) return opened;
  const { pass } = (await opened.json()) as { pass: string };
  const start = await anon(rt, 'POST', `${api(r)}/uploads`, {
    name,
    size: bytes.length,
    mime: 'text/plain',
    pass,
    ...rest,
  });
  if (start.status !== 201) return start;
  const s = (await start.json()) as {
    uploadId: string;
    token: string;
    partSize: number;
    totalParts: number;
  };
  for (let n = 1; n <= s.totalParts; n++) {
    const part = bytes.slice((n - 1) * s.partSize, n * s.partSize);
    const put = await anon(rt, 'PUT', `${api(r)}/uploads/${s.uploadId}/parts/${n}`, part, {
      'x-drop-token': s.token,
      'content-length': String(part.length),
    });
    expect(put.status, await put.clone().text()).toBe(200);
  }
  return anon(rt, 'POST', `${api(r)}/uploads/${s.uploadId}/complete`, undefined, {
    'x-drop-token': s.token,
  });
}

const childNames = async (s: Session, id: string) =>
  (
    (await (await s.req('GET', `/api/nodes/${id}/children`)).json()) as {
      items: Array<{ id: string; name: string; kind: string }>;
    }
  ).items;

describe('File request links (D3, ADR-086)', () => {
  it('an uploader without an account sends files into a subfolder of their own', async () => {
    const { rt, owner, poolId, folder } = await setup();
    const r = await makeRequest(owner, folder.id, {
      message: 'Paling lambat Jumat',
      requireName: true,
    });
    expect(r.url).toMatch(/\/minta\/[0-9A-Za-z]{64}\/[0-9A-Za-z]{32}$/);

    // The public side tells the title and message, never the folder or what is in it.
    const info = await anon(rt, 'GET', api(r));
    expect(info.status).toBe(200);
    const shown = await info.text();
    expect(JSON.parse(shown)).toMatchObject({
      title: 'Kumpulkan PR',
      message: 'Paling lambat Jumat',
      requireName: true,
      state: 'open',
    });
    expect(shown).not.toContain('Tugas Kelas');
    expect(shown).not.toContain('milik-guru');

    // A name is asked for.
    expect((await drop(rt, r, 'pr.txt', 'jawaban')).status).toBe(400);
    const before = pool(rt, poolId).used_bytes;
    const done = await drop(rt, r, 'pr.txt', 'jawaban budi', { uploaderName: 'Budi / Kelas 7' });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await done.json()).toEqual({ name: 'pr.txt', size: 12 });
    await drop(rt, r, 'pr.txt', 'jawaban budi 2', { uploaderName: 'Budi / Kelas 7' });
    await rt.settle();
    // On the owner's quota, in "Budi  Kelas 7" (the slash is not allowed in a name).
    expect(pool(rt, poolId).used_bytes).toBe(before + 12 + 14);
    const sub = (await childNames(owner, folder.id)).find((n) => n.kind === 'folder')!;
    expect(sub.name).toBe('Budi  Kelas 7');
    expect((await childNames(owner, sub.id)).map((n) => n.name).sort()).toEqual([
      'pr (1).txt',
      'pr.txt',
    ]);

    // The owner hears once, for both files, at the hourly round.
    expect((await rt.runCron('0 * * * *')).failed).toEqual([]);
    const notes = (await noticesOf(rt, owner.userId)).filter(
      (n) => n.type === 'file_request_files',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toMatchObject({ count: 2, folderId: folder.id });
    // The IP is kept only as a keyed hash.
    const ips = rt.access.sqlite.prepare('SELECT ip_hash FROM file_request_drops').all() as Array<{
      ip_hash: string;
    }>;
    expect(ips.every((x) => /^[0-9A-Za-z]{32}$/.test(x.ip_hash))).toBe(true);
  });

  it('keeps to the count, the size, the password, the deadline and revocation', async () => {
    const { rt, clock, owner, folder } = await setup();
    const r = await makeRequest(owner, folder.id, {
      maxFiles: 2,
      maxFileBytes: 10,
      password: 'rahasia1',
      deadlineAt: Date.UTC(2026, 10, 3),
    });
    expect((await drop(rt, r, 'a.txt', 'a')).status).toBe(403);
    expect((await drop(rt, r, 'a.txt', 'a', { password: 'salah' })).status).toBe(403);
    expect(
      (await drop(rt, r, 'besar.txt', 'lebih dari sepuluh', { password: 'rahasia1' })).status,
    ).toBe(413);
    expect((await drop(rt, r, 'a.txt', 'a', { password: 'rahasia1' })).status).toBe(200);
    expect((await drop(rt, r, 'b.txt', 'b', { password: 'rahasia1' })).status).toBe(200);
    const full = await drop(rt, r, 'c.txt', 'c', { password: 'rahasia1' });
    expect(full.status).toBe(410);
    expect(((await (await anon(rt, 'GET', api(r))).json()) as { state: string }).state).toBe(
      'full',
    );

    const r2 = await makeRequest(owner, folder.id, { deadlineAt: Date.UTC(2026, 10, 3) });
    clock.advance(3 * DAY_MS);
    expect((await drop(rt, r2, 'telat.txt', 'x')).status).toBe(410);
    const r3 = await makeRequest(owner, folder.id);
    expect((await owner.req('DELETE', `/api/file-requests/${r3.id}`)).status).toBe(204);
    expect((await drop(rt, r3, 'x.txt', 'x')).status).toBe(410);
    const listed = (await (
      await owner.req('GET', `/api/file-requests?folderId=${folder.id}`)
    ).json()) as {
      items: RequestDto[];
    };
    expect(listed.items.map((x) => x.state).sort()).toEqual(['expired', 'expired', 'revoked']);
  });

  it('stops when the quota runs out, and leaves nothing reserved', async () => {
    const { rt, owner, poolId, folder } = await setup(60);
    const r = await makeRequest(owner, folder.id);
    const res = await drop(rt, r, 'besar.txt', 'x'.repeat(100), { uploaderName: 'Ani' });
    expect(res.status).toBe(413);
    expect(pool(rt, poolId).reserved_bytes).toBe(0);
    // The slot it took is given back.
    const row = rt.access.sqlite.prepare('SELECT file_count FROM file_requests').get();
    expect(row).toEqual({ file_count: 0 });
  });

  it('caps unfinished drops, expires them in hours, gives the slot back, and revocation frees the quota (ADR-088)', async () => {
    const { rt, clock, owner, poolId, folder } = await setup();
    const r = await makeRequest(owner, folder.id, { maxFiles: 5 });
    const opened = await anon(rt, 'POST', `${api(r)}/pass`, {});
    const { pass } = (await opened.json()) as { pass: string };
    const start = (name: string) =>
      anon(rt, 'POST', `${api(r)}/uploads`, { name, size: 1000, mime: 'text/plain', pass });

    // One address may hold three unfinished drops on a link, and no more.
    const held: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await start(`f${n}.txt`);
      expect(res.status, await res.clone().text()).toBe(201);
      held.push(((await res.json()) as { uploadId: string }).uploadId);
    }
    expect((await start('f4.txt')).status).toBe(429);
    expect(pool(rt, poolId).reserved_bytes).toBe(3000);

    // An anonymous drop expires in hours, not the owner's six days.
    const row = rt.d1.sqlite
      .prepare('SELECT expires_at FROM uploads WHERE id = ?')
      .get(held[0]!) as {
      expires_at: number;
    };
    expect(row.expires_at).toBe(clock.now() + 3 * 3600_000);

    // Abandoned: the upload expires, the quota comes back, and so do the slots.
    clock.advance(3 * 3600_000 + 1);
    await rt.runCron('0 * * * *');
    expect(pool(rt, poolId).reserved_bytes).toBe(0);
    const count = rt.access.sqlite.prepare('SELECT file_count FROM file_requests').get();
    expect(count).toEqual({ file_count: 0 });

    // Revoking the link gives back what its unfinished drops hold at once.
    const again = await anon(rt, 'POST', `${api(r)}/pass`, {});
    const fresh = ((await again.json()) as { pass: string }).pass;
    const late = await anon(rt, 'POST', `${api(r)}/uploads`, {
      name: 'late.txt',
      size: 500,
      mime: 'text/plain',
      pass: fresh,
    });
    expect(late.status).toBe(201);
    expect(pool(rt, poolId).reserved_bytes).toBe(500);
    expect((await owner.req('DELETE', `/api/file-requests/${r.id}`)).status).toBeLessThan(300);
    expect(pool(rt, poolId).reserved_bytes).toBe(0);
  });

  it('a token works for its own upload of its own link only; a bad signature is not found', async () => {
    const { rt, owner, root, folder } = await setup();
    const other = await createFolder(owner, root, 'Lain');
    const a = await makeRequest(owner, folder.id);
    const b = await makeRequest(owner, other.id);
    const { pass } = (await (await anon(rt, 'POST', `${api(a)}/pass`, {})).json()) as {
      pass: string;
    };
    // A pass is for its own link only.
    expect(
      (await anon(rt, 'POST', `${api(b)}/uploads`, { name: 'x.txt', size: 1, pass })).status,
    ).toBe(403);
    const start = await anon(rt, 'POST', `${api(a)}/uploads`, { name: 'x.txt', size: 1, pass });
    const s = (await start.json()) as { uploadId: string; token: string };
    const one = enc.encode('x');
    const headers = { 'x-drop-token': s.token, 'content-length': '1' };
    // Through the other link, or with no or a wrong token: not found.
    expect(
      (await anon(rt, 'PUT', `${api(b)}/uploads/${s.uploadId}/parts/1`, one, headers)).status,
    ).toBe(404);
    expect(
      (
        await anon(rt, 'PUT', `${api(a)}/uploads/${s.uploadId}/parts/1`, one, {
          'content-length': '1',
          'x-drop-token': 'A'.repeat(32),
        })
      ).status,
    ).toBe(404);
    // A changed last character (never the same one it had) is not found.
    const bent = `${api(a).slice(0, -1)}${api(a).endsWith('x') ? 'y' : 'x'}`;
    expect((await anon(rt, 'GET', bent)).status).toBe(404);
    // The owner's own upload ids are not reachable through a link.
    const mine = await owner.req('POST', '/api/uploads', {
      parentId: folder.id,
      name: 'm.bin',
      size: 1,
    });
    const ownId = ((await mine.json()) as { uploadId: string }).uploadId;
    expect((await anon(rt, 'PUT', `${api(a)}/uploads/${ownId}/parts/1`, one, headers)).status).toBe(
      404,
    );
    // Someone else can't see or end the owner's links.
    const stranger = await signIn(rt, 'bukan-peminta@example.com');
    expect((await stranger.req('DELETE', `/api/file-requests/${a.id}`)).status).toBe(404);
    const theirs = (await (await stranger.req('GET', '/api/file-requests')).json()) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);
    expect(
      (await stranger.req('POST', '/api/file-requests', { folderId: folder.id, title: 'x' }))
        .status,
    ).toBe(404);
  });

  it('a dangerous file is refused by the scan like any upload; deleting the folder closes the link', async () => {
    const { rt, owner, folder } = await setup();
    const r = await makeRequest(owner, folder.id);
    expect((await drop(rt, r, 'eicar.com', EICAR, { uploaderName: 'Iseng' })).status).toBe(200);
    await rt.settle();
    const sub = (await childNames(owner, folder.id)).find((n) => n.kind === 'folder')!;
    const file = (await childNames(owner, sub.id))[0]!;
    const info = (await (await owner.req('GET', `/api/nodes/${file.id}`)).json()) as {
      node: { scanStatus: string };
    };
    expect(info.node.scanStatus).toBe('infected');

    await owner.req('POST', '/api/nodes/trash', { ids: [folder.id] });
    expect(((await (await anon(rt, 'GET', api(r))).json()) as { state: string }).state).toBe(
      'unavailable',
    );
    await owner.req('POST', '/api/nodes/delete', { ids: [folder.id] });
    expect(((await (await anon(rt, 'GET', api(r))).json()) as { state: string }).state).toBe(
      'revoked',
    );
  });
});
