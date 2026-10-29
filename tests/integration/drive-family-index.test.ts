// R4 (ADR-078): a family's tree has its own index (`f/{familyId}/index.txt`) with its members in
// the header, written by any member's flush, and the family space is read from it.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { parseIndex } from '../../src/shared/drive-index';
import { createCtx } from '../../src/worker/context';
import { loadNode, nodeAccess } from '../../src/worker/services/access';
import { memberSlots } from '../../src/worker/services/drive-index-sync';
import {
  breadcrumb,
  getNodeDto,
  listChildren,
  type NodeDto,
} from '../../src/worker/services/nodes';
import { createFolder, rootOf, uploadText } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const buyPlan = (s: Session, code: string) =>
  s.req('POST', '/api/billing/checkout', { item: { kind: 'plan', code } });

function fund(rt: DevRuntime, s: Session, idr: number) {
  rt.d1.sqlite
    .prepare(
      'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, ?, 0) ON CONFLICT (user_id) DO UPDATE SET balance_idr = excluded.balance_idr',
    )
    .run(s.userId, idr);
}

/** The index keeps whole seconds (ADR-064); D1 keeps milliseconds. */
function seconds<T>(v: T): T {
  return JSON.parse(
    JSON.stringify(v, (k, x: unknown) =>
      typeof x === 'number' && /At$/.test(k) ? Math.floor(x / 1000) * 1000 : x,
    ),
  ) as T;
}

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function family() {
  const rt = await makeRuntime();
  rt.d1.sqlite
    .prepare(
      "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
    )
    .run();
  const owner = await signIn(rt, 'ibu@example.com');
  const member = await signIn(rt, 'kakak@example.com');
  const outsider = await signIn(rt, 'tetangga@example.com');
  fund(rt, owner, 100_000);
  expect((await buyPlan(owner, 'mini')).status).toBe(200);
  expect((await buyPlan(owner, 'family')).status).toBe(200);
  const invite = (
    (await (await owner.req('POST', '/api/family/invites', { channel: 'link' })).json()) as {
      url: string;
    }
  ).url
    .split('/')
    .pop()!;
  expect((await member.req('POST', `/api/family/invites/${invite}/accept`, {})).status).toBe(200);
  const me = (await (await owner.req('GET', '/api/me')).json()) as {
    space: { familyId: string; familyRootId: string };
  };
  return {
    rt,
    owner,
    member,
    outsider,
    familyId: me.space.familyId,
    famRoot: me.space.familyRootId,
  };
}

async function familyIndex(rt: DevRuntime, familyId: string) {
  const obj = await rt.r2.get(`f/${familyId}/index.txt`);
  return obj && 'text' in obj ? parseIndex(await obj.text()) : null;
}

describe('Family index (R4, ADR-078)', () => {
  it('keeps a member list where nobody moves and leavers leave a gap', () => {
    expect(memberSlots(undefined, ['o', 'a'])).toEqual(['o', 'a']);
    expect(memberSlots(['o', 'a', 'b'], ['o', 'b', 'c'])).toEqual(['o', null, 'b', 'c']);
    expect(memberSlots(['o', null, 'b'], ['o', 'b'])).toEqual(['o', null, 'b']);
  });

  it('is written by any member, with owners, edit rights and who trashed what', async () => {
    const { rt, owner, member, familyId, famRoot } = await family();
    const album = await createFolder(owner, famRoot, 'Album');
    const photo = await uploadText(member, album.id, 'foto-kakak.txt', 'isi');
    const gone = await uploadText(member, famRoot, 'lama.txt', 'x');
    expect((await member.req('POST', '/api/nodes/trash', { ids: [gone.id] })).status).toBe(200);
    // Nobody but the family's own flushes wrote this: the member's change reached it.
    await rt.settle();

    const idx = (await familyIndex(rt, familyId))!;
    expect(idx.head.root).toBe(famRoot);
    expect(idx.head.members).toEqual([owner.userId, member.userId]);
    const byId = new Map(idx.entries.map((e) => [e.legacy, e]));
    expect(byId.get(album.id)).toMatchObject({ owner: 1, parent: 0, kind: 'folder' });
    expect(byId.get(photo.id)).toMatchObject({ owner: 2, parent: byId.get(album.id)!.id });
    expect(byId.get(gone.id)).toMatchObject({
      owner: 2,
      trashedBy: 2,
      trashRoot: byId.get(gone.id)!.id,
    });
    // The family's files are in no personal index.
    for (const s of [owner, member]) {
      const own = await rt.r2.get(`u/${s.userId}/index.txt`);
      const text = own && 'text' in own ? await own.text() : '';
      expect(text).not.toContain(photo.id);
    }

    // Letting others edit is the family's own column.
    rt.d1.sqlite.prepare('UPDATE nodes SET family_can_edit = 1 WHERE id = ?').run(photo.id);
    rt.d1.sqlite
      .prepare('INSERT OR REPLACE INTO manifest_dirty (user_id, dirty_at) VALUES (?, 1)')
      .run(member.userId);
    const live = await json<{ node: NodeDto }>(await owner.req('GET', `/api/nodes/${photo.id}`));
    expect(live.node.familyCanEdit).toBe(true);
  });

  it('answers the family space exactly as D1 did, rights included, for every member', async () => {
    const { rt, owner, member, famRoot } = await family();
    const album = await createFolder(owner, famRoot, 'Album');
    await createFolder(member, album.id, 'Liburan');
    const mine = await uploadText(member, album.id, 'b.txt', 'kakak');
    const theirs = await uploadText(owner, album.id, 'a.txt', 'ibu');
    await rt.settle();
    const ctx = createCtx(rt.env);

    for (const s of [owner, member]) {
      for (const folder of [famRoot, album.id])
        for (const sort of ['name', 'updated', 'size'] as const) {
          const got = await json<{ items: NodeDto[]; path: unknown }>(
            await s.req('GET', `/api/nodes/${folder}/children?sort=${sort}`),
          );
          const d1 = await listChildren(ctx, s.userId, folder, { sort });
          expect(seconds(got.items)).toEqual(seconds(d1.items));
          expect(got.path).toEqual(await breadcrumb(ctx, folder));
        }
      for (const id of [album.id, mine.id, theirs.id]) {
        const got = await json<{ node: NodeDto; access: unknown }>(
          await s.req('GET', `/api/nodes/${id}`),
        );
        expect(seconds(got.node)).toEqual(seconds(await getNodeDto(ctx, s.userId, id)));
        expect(got.access).toEqual(await nodeAccess(ctx, s.userId, (await loadNode(ctx, id))!));
      }
    }
    // The member may remove their own file, not the owner's.
    const access = await json<{ access: { remove: boolean } }>(
      await member.req('GET', `/api/nodes/${theirs.id}`),
    );
    expect(access.access.remove).toBe(false);
  });

  it("searches it, keeps each member's Trash their own, and is closed to outsiders", async () => {
    const { rt, owner, member, outsider, famRoot } = await family();
    const plan = await uploadText(owner, famRoot, 'Rencana Liburan.txt', 'x');
    const junk = await uploadText(member, famRoot, 'sampah-kakak.txt', 'y');
    await member.req('POST', '/api/nodes/trash', { ids: [junk.id] });
    await rt.settle();

    for (const s of [owner, member]) {
      const found = await json<{ items: NodeDto[] }>(await s.req('GET', '/api/search?q=liburan'));
      expect(found.items.map((n) => n.id)).toEqual([plan.id]);
    }
    const onlyMine = await json<{ items: NodeDto[] }>(
      await member.req('GET', '/api/search?q=liburan&space=personal'),
    );
    expect(onlyMine.items).toEqual([]);
    const trash = async (s: Session) =>
      (await json<{ items: NodeDto[] }>(await s.req('GET', '/api/trash'))).items.map((n) => n.id);
    expect(await trash(member)).toEqual([junk.id]);
    expect(await trash(owner)).toEqual([]);

    const index = await member.req('GET', '/api/drive/index?space=family');
    expect(index.status).toBe(200);
    const etag = index.headers.get('etag')!;
    expect(
      parseIndex(await index.text())
        .entries.map((e) => e.name)
        .sort(),
    ).toEqual(['Rencana Liburan.txt', 'sampah-kakak.txt']);
    const again = await member.req('GET', '/api/drive/index?space=family', undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);

    expect((await outsider.req('GET', '/api/drive/index?space=family')).status).toBe(404);
    for (const path of [`/api/nodes/${plan.id}`, `/api/nodes/${famRoot}/children`])
      expect((await outsider.req('GET', path)).status).toBe(404);
    const theirSearch = await json<{ items: NodeDto[] }>(
      await outsider.req('GET', '/api/search?q=liburan'),
    );
    expect(theirSearch.items).toEqual([]);
    expect(await rootOf(outsider)).not.toBe(famRoot);
  });

  it('follows a member leaving and the family ending', async () => {
    const { rt, owner, member, familyId, famRoot } = await family();
    const left = await uploadText(member, famRoot, 'punya-kakak.txt', 'z');
    await rt.settle();
    expect((await member.req('POST', '/api/family/leave')).status).toBe(204);
    await rt.settle();

    const idx = (await familyIndex(rt, familyId))!;
    expect(idx.head.members).toEqual([owner.userId, null]);
    // What the leaver made stays in the family, now the owner's.
    expect(idx.entries.find((e) => e.legacy === left.id)).toMatchObject({ owner: 1 });
    expect((await member.req('GET', '/api/drive/index?space=family')).status).toBe(404);
    expect((await member.req('GET', `/api/nodes/${left.id}`)).status).toBe(404);

    expect((await owner.req('POST', '/api/family/dissolve')).status).toBe(200);
    await rt.settle();
    expect(await familyIndex(rt, familyId)).toBeNull();
    expect((await owner.req('GET', '/api/drive/index?space=family')).status).toBe(404);
    // The tree went back into the owner's own Drive, and their own index follows it.
    const own = parseIndex(await (await owner.req('GET', '/api/drive/index')).text());
    expect(own.entries.map((e) => e.legacy)).toContain(left.id);
  });
});
