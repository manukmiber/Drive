// D2 (ADR-085): sharing a file or folder with particular Zeiko accounts, and "Shared with me".
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { parseIndex } from '../../src/shared/drive-index';
import {
  createFolder,
  downloadPath,
  grantPlan,
  pool,
  rootOf,
  simpleUpload,
  uploadText,
} from '../helpers/files';
import { noticesOf } from '../helpers/notices';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface Person {
  id: string;
  userId: string | null;
  email: string | null;
  role: 'view' | 'edit';
  pending: boolean;
}

async function setup() {
  const rt = await makeRuntime();
  const owner = await signIn(rt, 'pemilik-d2@example.com');
  const friend = await signIn(rt, 'teman-d2@example.com');
  const stranger = await signIn(rt, 'orang-lain-d2@example.com');
  const ownerPool = await grantPlan(rt, owner.userId);
  const friendPool = await grantPlan(rt, friend.userId);
  await grantPlan(rt, stranger.userId);
  const root = await rootOf(owner);
  const folder = await createFolder(owner, root, 'Proyek');
  const inner = await createFolder(owner, folder.id, 'Bab 1');
  const file = await uploadText(owner, inner.id, 'naskah.txt', 'isi naskah');
  const secret = await uploadText(owner, root, 'rahasia.txt', 'jangan');
  await rt.settle();
  return { rt, owner, friend, stranger, ownerPool, friendPool, root, folder, inner, file, secret };
}

async function share(s: Session, nodeId: string, emails: string[], role: 'view' | 'edit') {
  const res = await s.req('POST', `/api/nodes/${nodeId}/people`, { emails, role });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { items: Person[] }).items;
}

const status = async (s: Session, method: string, path: string, body?: unknown) =>
  (await s.req(method, path, body)).status;

async function sharedWithMe(s: Session) {
  const res = await s.req('GET', '/api/shared-with-me');
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      items: Array<{ grantId: string; role: string; node: { id: string; name: string } }>;
    }
  ).items;
}

const read = async (rt: DevRuntime, s: Session, id: string) =>
  (await rt.fetch(new Request(`${APP}${await downloadPath(s, id)}`))).text();

describe('Sharing with people (D2, ADR-085)', () => {
  it('view: the folder and everything inside it, nothing above or beside it', async () => {
    const { rt, owner, friend, stranger, folder, inner, file, secret } = await setup();
    const people = await share(owner, folder.id, ['Teman-D2@example.com'], 'view');
    expect(people).toMatchObject([{ userId: friend.userId, role: 'view', pending: false }]);
    // Told in the bell (and by email, through the same notice).
    expect((await noticesOf(rt, friend.userId)).map((n) => n.type)).toContain('node_shared');

    expect((await sharedWithMe(friend)).map((i) => [i.node.id, i.role])).toEqual([
      [folder.id, 'view'],
    ]);
    const kids = await friend.req('GET', `/api/nodes/${inner.id}/children`);
    expect(kids.status).toBe(200);
    const page = (await kids.json()) as {
      items: Array<{ id: string }>;
      path: Array<{ id: string; name: string }>;
    };
    expect(page.items.map((n) => n.id)).toEqual([file.id]);
    // The path starts at what was shared: the owner's own folders stay hidden.
    expect(page.path.map((c) => c.name)).toEqual(['Proyek', 'Bab 1']);
    expect(await read(rt, friend, file.id)).toBe('isi naskah');

    // View only: no renaming, adding, trashing, or sharing on.
    expect(await status(friend, 'PATCH', `/api/nodes/${file.id}`, { name: 'x.txt' })).toBe(403);
    expect(await status(friend, 'POST', '/api/folders', { parentId: inner.id, name: 'x' })).toBe(
      403,
    );
    expect(await status(friend, 'POST', '/api/nodes/trash', { ids: [file.id] })).toBe(403);
    expect(await status(friend, 'POST', '/api/shares', { nodeIds: [file.id] })).toBe(403);
    expect(
      await status(friend, 'POST', `/api/nodes/${file.id}/people`, {
        emails: ['orang-lain-d2@example.com'],
        role: 'view',
      }),
    ).toBe(403);
    // Beside it, and for anybody else: not found.
    expect(await status(friend, 'GET', `/api/nodes/${secret.id}`)).toBe(404);
    expect(await status(stranger, 'GET', `/api/nodes/${file.id}`)).toBe(404);
    expect(await sharedWithMe(stranger)).toEqual([]);

    // Search finds what's inside, never what isn't shared.
    const found = (await (await friend.req('GET', '/api/search?q=naskah')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(found.items.map((n) => n.id)).toEqual([file.id]);
    const none = (await (await friend.req('GET', '/api/search?q=rahasia')).json()) as {
      items: unknown[];
    };
    expect(none.items).toEqual([]);
    const theirs = (await (await stranger.req('GET', '/api/search?q=naskah')).json()) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);
  });

  it("edit: changes and adds on the owner's quota and index; removing stays with the owner", async () => {
    const { rt, owner, friend, ownerPool, friendPool, folder, inner, file } = await setup();
    await share(owner, folder.id, ['teman-d2@example.com'], 'edit');
    const before = pool(rt, ownerPool).used_bytes;

    expect(await status(friend, 'PATCH', `/api/nodes/${file.id}`, { name: 'naskah-2.txt' })).toBe(
      200,
    );
    const up = await simpleUpload(friend, inner.id, 'tambahan.txt', 'dari teman');
    expect(up.status, await up.clone().text()).toBe(201);
    const added = ((await up.json()) as { node: { id: string } }).node;
    await rt.settle();
    // Into the owner's pool, not the friend's.
    expect(pool(rt, ownerPool).used_bytes).toBe(before + 'dari teman'.length);
    expect(pool(rt, friendPool).used_bytes).toBe(0);
    // And into the owner's index.
    const idx = parseIndex(await (await owner.req('GET', '/api/drive/index')).text());
    const names = idx.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['naskah-2.txt', 'tambahan.txt']));
    const mine = parseIndex(await (await friend.req('GET', '/api/drive/index')).text());
    expect(mine.entries.map((e) => e.name)).not.toContain('tambahan.txt');

    // What they made they may remove; the owner's file and the shared folder itself they may not.
    expect(await status(friend, 'POST', '/api/nodes/trash', { ids: [added.id] })).toBe(200);
    expect(await status(friend, 'POST', '/api/nodes/trash', { ids: [file.id] })).toBe(403);
    expect(await status(friend, 'POST', '/api/nodes/trash', { ids: [folder.id] })).toBe(403);
    // Nothing leaves the owner's space through the share.
    const friendRoot = await rootOf(friend);
    expect(
      await status(friend, 'POST', '/api/nodes/move', { ids: [file.id], targetId: friendRoot }),
    ).toBeGreaterThanOrEqual(400);
    expect(
      await status(friend, 'POST', `/api/nodes/${file.id}/copy`, { targetId: friendRoot }),
    ).toBeGreaterThanOrEqual(400);
    // Within it, moving works.
    expect(
      await status(friend, 'POST', '/api/nodes/move', { ids: [file.id], targetId: folder.id }),
    ).toBe(200);
  });

  it('revoke, leave, a role change, and a grant on a file only', async () => {
    const { owner, friend, folder, inner, file } = await setup();
    const [g] = await share(owner, file.id, ['teman-d2@example.com'], 'view');
    expect(await status(friend, 'GET', `/api/nodes/${file.id}`)).toBe(200);
    // A file's grant doesn't open the folder it is in.
    expect(await status(friend, 'GET', `/api/nodes/${inner.id}/children`)).toBe(404);
    const changed = await owner.req('PATCH', `/api/nodes/${file.id}/people/${g!.id}`, {
      role: 'edit',
    });
    expect(((await changed.json()) as { items: Person[] }).items[0]!.role).toBe('edit');
    expect(await status(owner, 'DELETE', `/api/nodes/${file.id}/people/${g!.id}`)).toBe(204);
    expect(await status(friend, 'GET', `/api/nodes/${file.id}`)).toBe(404);
    expect(await sharedWithMe(friend)).toEqual([]);

    // The person it was shared with may leave it.
    const [h] = await share(owner, folder.id, ['teman-d2@example.com'], 'view');
    expect(await status(friend, 'DELETE', `/api/nodes/${folder.id}/people/${h!.id}`)).toBe(204);
    expect(await status(friend, 'GET', `/api/nodes/${folder.id}`)).toBe(404);
    // Deleting the item for good takes its grants.
    const [k] = await share(owner, folder.id, ['teman-d2@example.com'], 'view');
    await owner.req('POST', '/api/nodes/trash', { ids: [folder.id] });
    expect(await sharedWithMe(friend)).toEqual([]);
    expect(await status(owner, 'POST', '/api/nodes/delete', { ids: [folder.id] })).toBe(200);
    expect(await status(owner, 'GET', `/api/nodes/${folder.id}/people/${k!.id}`)).toBe(404);
  });

  it('an address that is not on Drive yet: an email now, the item once they sign in', async () => {
    const { rt, owner, folder, file } = await setup();
    const [p] = await share(owner, folder.id, ['baru-d2@example.com'], 'view');
    expect(p).toMatchObject({ userId: null, email: 'baru-d2@example.com', pending: true });
    await rt.settle();
    const { mails } = (await (await rt.fetch(new Request(`${APP}/__dev/mail`))).json()) as {
      mails: Array<{ to: string[]; subject: string; text: string }>;
    };
    const m = mails.find((x) => x.to.includes('baru-d2@example.com'))!;
    expect(m.subject).toContain('Proyek');
    expect(m.text).toContain('/untuk-saya');

    const newcomer = await signIn(rt, 'baru-d2@example.com');
    expect((await sharedWithMe(newcomer)).map((i) => i.node.id)).toEqual([folder.id]);
    expect(await read(rt, newcomer, file.id)).toBe('isi naskah');
    const after = (await (await owner.req('GET', `/api/nodes/${folder.id}/people`)).json()) as {
      items: Person[];
    };
    expect(after.items).toMatchObject([{ userId: newcomer.userId, pending: false }]);
  });

  it('checks the input, limits, and the access database', async () => {
    const { owner, friend, folder, root } = await setup();
    for (const body of [
      { emails: ['bukan-email'], role: 'view' },
      { emails: ['teman-d2@example.com'], role: 'owner' },
      { emails: ['pemilik-d2@example.com'], role: 'view' },
      { emails: [], role: 'view' },
    ])
      expect(await status(owner, 'POST', `/api/nodes/${folder.id}/people`, body)).toBe(400);
    expect(
      await status(owner, 'POST', `/api/nodes/${root}/people`, {
        emails: ['teman-d2@example.com'],
        role: 'view',
      }),
    ).toBe(403);
    const caps = (await (await friend.req('GET', '/api/public/catalog')).json()) as {
      capabilities: { peopleShares: boolean };
    };
    expect(caps.capabilities.peopleShares).toBe(true);
  });

  it('is in the data export, and goes with the account', async () => {
    const { rt, owner, friend, folder } = await setup();
    await share(owner, folder.id, ['teman-d2@example.com'], 'view');
    const exp = (await (await owner.req('GET', '/api/me/export')).json()) as {
      people: { given: unknown[]; received: unknown[] };
    };
    expect(exp.people.given).toHaveLength(1);
    const theirs = (await (await friend.req('GET', '/api/me/export')).json()) as {
      people: { given: unknown[]; received: unknown[] };
    };
    expect(theirs.people.received).toHaveLength(1);
    expect(rt.access.sqlite.prepare('SELECT COUNT(*) AS n FROM node_grants').get()).toEqual({
      n: 1,
    });
  });
});
