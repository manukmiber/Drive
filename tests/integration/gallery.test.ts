// D8 (ADR-091): photos and videos get their capture date and size read into the index after the
// scan; the Gallery lists them newest taken first, a page at a time, from the person's own trees.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { changeIndex } from '../../src/worker/services/drive-index';
import { createFolder, grantPlan, rootOf, simpleUpload, uploadText } from '../helpers/files';
import { jpeg, mp4, tiff } from '../helpers/media';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface Item {
  id: string;
  name: string;
  takenAt?: number | null;
  width?: number;
  height?: number;
  durationMs?: number;
}

async function upload(s: Session, parent: string, name: string, bytes: Uint8Array, mime: string) {
  const res = await simpleUpload(s, parent, name, bytes, { mime });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { node: { id: string } }).node;
}

const photo = (date: string, orientation = 1) =>
  jpeg(tiff({ orientation, date, offset: '+07:00' }), 4000, 3000);

async function gallery(s: Session, query = '') {
  const res = await s.req('GET', `/api/gallery${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { items: Item[]; nextCursor: string | null };
}

async function setup() {
  const rt = await makeRuntime();
  const s = await signIn(rt, 'galeri@example.com');
  await grantPlan(rt, s.userId);
  return { rt, s, root: await rootOf(s) };
}

describe('Gallery (D8, ADR-091)', () => {
  it('reads when photos were taken and lists them newest taken first, videos too', async () => {
    const { rt, s, root } = await setup();
    const liburan = await createFolder(s, root, 'Liburan');
    // Uploaded in the opposite order of when they were taken.
    await upload(s, liburan.id, 'pantai.jpg', photo('2023:08:17 09:00:00', 6), 'image/jpeg');
    await upload(s, root, 'ulang tahun.jpg', photo('2024:05:01 19:30:00'), 'image/jpeg');
    await upload(s, root, 'video.mp4', mp4(Date.UTC(2024, 0, 2, 3), 15_000), 'video/mp4');
    await uploadText(s, root, 'catatan.txt', 'bukan foto');
    await rt.settle();

    const all = await gallery(s);
    expect(all.items.map((i) => i.name)).toEqual(['ulang tahun.jpg', 'video.mp4', 'pantai.jpg']);
    const [birthday, video, beach] = all.items;
    expect(birthday!.takenAt).toBe(Date.UTC(2024, 4, 1, 12, 30));
    expect(beach).toMatchObject({ takenAt: Date.UTC(2023, 7, 17, 2), width: 3000, height: 4000 });
    expect(video).toMatchObject({ durationMs: 15_000, width: 1080, height: 1920 });

    // The search syntax: a folder, a type, and dates that mean "taken" here.
    expect((await gallery(s, '?q=di:Liburan')).items.map((i) => i.name)).toEqual(['pantai.jpg']);
    expect((await gallery(s, '?q=jenis:video')).items.map((i) => i.name)).toEqual(['video.mp4']);
    expect((await gallery(s, '?q=setelah:2024-02')).items.map((i) => i.name)).toEqual([
      'ulang tahun.jpg',
    ]);
    expect((await gallery(s, '?q=jenis:pdf')).items).toEqual([]);
  });

  it('pages with a (date, id) cursor', async () => {
    const { rt, s, root } = await setup();
    for (let i = 0; i < 7; i++)
      await upload(s, root, `foto${i}.jpg`, photo(`2024:01:0${i + 1} 10:00:00`), 'image/jpeg');
    await rt.settle();
    const first = await gallery(s, '?limit=3');
    expect(first.items.map((i) => i.name)).toEqual(['foto6.jpg', 'foto5.jpg', 'foto4.jpg']);
    const second = await gallery(s, `?limit=3&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.name)).toEqual(['foto3.jpg', 'foto2.jpg', 'foto1.jpg']);
    const third = await gallery(s, `?limit=3&cursor=${second.nextCursor}`);
    expect(third.items.map((i) => i.name)).toEqual(['foto0.jpg']);
    expect(third.nextCursor).toBeNull();
    expect((await s.req('GET', '/api/gallery?cursor=rusak')).status).toBe(400);
  });

  it('shows no one else’s photos, and new content is read again', async () => {
    const { rt, s, root } = await setup();
    const mine = await upload(s, root, 'pribadi.jpg', photo('2022:02:02 02:02:02'), 'image/jpeg');
    await rt.settle();
    const other = await signIn(rt, 'orang-lain@example.com');
    await grantPlan(rt, other.userId);
    expect((await gallery(other)).items).toEqual([]);
    expect((await other.req('GET', `/api/gallery?q=${encodeURIComponent('pribadi')}`)).status).toBe(
      200,
    );

    // Replaced with a photo taken on another day: the old reading goes with the old content.
    const q = new URLSearchParams({
      parentId: root,
      name: 'pribadi.jpg',
      size: '0',
      mime: 'image/jpeg',
      onConflict: 'replace',
    });
    const bytes = photo('2025:03:03 03:03:03');
    q.set('size', String(bytes.length));
    const replaced = await s.req('PUT', `/api/uploads/simple?${q}`, undefined, {
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    });
    expect(replaced.status).toBe(201);
    await rt.settle();
    const after = (await gallery(s)).items.find((i) => i.id === mine.id)!;
    expect(after.takenAt).toBe(Date.UTC(2025, 2, 2, 20, 3, 3));
  });

  it('fills in photos from before the Gallery, a few each hour', async () => {
    const { rt, s, root } = await setup();
    const old = await upload(s, root, 'lama.jpg', photo('2020:06:06 06:06:06'), 'image/jpeg');
    await rt.settle();
    // As if it was uploaded before D8: no reading in its index entry.
    await changeIndex(rt.env.BUCKET, { user: s.userId }, (doc) => {
      for (const e of doc.entries()) if (e.legacy === old.id) doc.set({ ...e, media: null });
    });
    expect((await gallery(s)).items[0]!.takenAt).toBeUndefined();
    await runHourly(rt);
    expect((await gallery(s)).items[0]!.takenAt).toBe(Date.UTC(2020, 5, 5, 23, 6, 6));
  });
});

async function runHourly(rt: DevRuntime) {
  await rt.runCron('0 * * * *');
  await rt.settle();
}
