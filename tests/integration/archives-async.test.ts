import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { CRON } from '../../src/shared/constants';
import { sha256Hex } from '../../src/worker/lib/crypto';
import { putKnownLength } from '../../src/worker/lib/r2-put';
import { tarSize, tarStream } from '../../src/worker/lib/tar';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { readTar, readZip } from '../helpers/zip';
import type { DevRuntime } from '../../dev/env';

const T0 = Date.UTC(2026, 9, 10, 3, 0);

async function setup() {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, 'arsip@example.com');
  await grantPlan(rt, s.userId);
  const root = await rootOf(s);
  const folder = await createFolder(s, root, 'Liburan Bali');
  await uploadText(s, folder.id, 'catatan.txt', 'hari pertama');
  const deep = await createFolder(s, folder.id, `${'sangat-panjang-'.repeat(8)}folder`);
  await uploadText(s, deep.id, 'foto ünïcödé 😀.txt', 'isi unicode');
  await rt.settle();
  return { rt, s, clock, folder };
}

type Job = {
  id: string;
  status: string;
  progress: number;
  url: string | null;
  name: string | null;
  error: string | null;
};
const jobs = async (s: Session) =>
  ((await (await s.req('GET', '/api/archives')).json()) as { jobs: Job[] }).jobs;
const fetchBytes = async (rt: DevRuntime, url: string) =>
  new Uint8Array(await (await rt.fetch(new Request(`${APP}${url}`))).arrayBuffer());

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

describe('async archives (SPEC §7.2)', () => {
  it('builds a TAR.ZST job, notifies, serves it with Range, and expires it', async () => {
    const { rt, s, clock, folder } = await setup();
    const res = await s.req('POST', '/api/archives', {
      nodeIds: [folder.id],
      format: 'tar_zst',
      level: 'max',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; async: boolean; url: string | null };
    expect(created).toMatchObject({ async: true, url: null });
    expect(
      rt.d1.sqlite.prepare('SELECT level, status FROM archive_jobs WHERE id = ?').get(created.id),
    ).toEqual({ level: 12, status: 'queued' });

    // One running job per user.
    const again = await s.req('POST', '/api/archives', { nodeIds: [folder.id], format: 'tar_zst' });
    expect(again.status).toBe(409);

    await rt.settle();
    const [job] = await jobs(s);
    expect(job).toMatchObject({ status: 'done', progress: 100, name: 'Liburan Bali.tar.zst' });
    // The mock archiver returns the tar itself, so it can be checked with an independent reader.
    const files = readTar(await fetchBytes(rt, job!.url!));
    expect(files['Liburan Bali/catatan.txt']).toBe('hari pertama');
    const long = Object.keys(files).find((k) => k.endsWith('foto ünïcödé 😀.txt'))!;
    expect(long).toBe(`Liburan Bali/${'sangat-panjang-'.repeat(8)}folder/foto ünïcödé 😀.txt`);
    expect(files[long]).toBe('isi unicode');

    const ranged = await rt.fetch(
      new Request(`${APP}${job!.url!}`, { headers: { range: 'bytes=0-511' } }),
    );
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(512);

    const notes = (await (await s.req('GET', '/api/notifications')).json()) as {
      items: Array<{ type: string; url: string | null }>;
    };
    expect(notes.items[0]).toMatchObject({
      type: 'archive_ready',
      url: 'http://localhost:5173/unduhan',
    });

    clock.advance(25 * 3600_000);
    await rt.runCron(CRON.hourly);
    expect((await jobs(s))[0]).toMatchObject({ status: 'expired', url: null });
    expect((await rt.r2.list({ prefix: 'tmp/archives/' })).objects).toHaveLength(0);
    expect((await rt.fetch(new Request(`${APP}${job!.url!}`))).status).toBe(410);
  });

  it('turns a deflate ZIP above the stream limit into a job', async () => {
    const { rt, s, folder } = await setup();
    setConfig(rt, 'zip_deflate_stream_max_bytes', 10);
    const created = (await (
      await s.req('POST', '/api/archives', { nodeIds: [folder.id], format: 'zip_deflate' })
    ).json()) as { async: boolean };
    expect(created.async).toBe(true);
    await rt.settle();
    const [job] = await jobs(s);
    const files = readZip(await fetchBytes(rt, job!.url!));
    expect(files['Liburan Bali/catatan.txt']).toBe('hari pertama');
  });

  it('refuses async formats when the archiver container is not deployed', async () => {
    const { rt, s, folder } = await setup();
    (rt.env as { ADAPTER_ARCHIVER?: string }).ADAPTER_ARCHIVER = 'none';
    const res = await s.req('POST', '/api/archives', { nodeIds: [folder.id], format: 'tar_zst' });
    expect(res.status).toBe(400);
    const cat = (await (await rt.fetch(new Request(`${APP}/api/public/catalog`))).json()) as {
      capabilities: { asyncArchives: boolean };
    };
    expect(cat.capabilities.asyncArchives).toBe(false);
    // Streamed ZIP still works.
    expect(
      (await s.req('POST', '/api/archives', { nodeIds: [folder.id], format: 'zip_store' })).status,
    ).toBe(201);
  });
});

describe('tar + R2 writer', () => {
  it('computes the exact tar length and writes multipart with uniform parts', async () => {
    const rt = await makeRuntime();
    const text = '0123456789'.repeat(100);
    await rt.env.BUCKET.put('k1', text);
    const entries = [
      { path: 'a/', size: 0, crc32: 0, mtime: T0, key: null },
      { path: `a/${'x'.repeat(150)}.txt`, size: text.length, crc32: 0, mtime: T0, key: 'k1' },
    ];
    const tar = new Uint8Array(await new Response(tarStream(rt.env.BUCKET, entries)).arrayBuffer());
    expect(tar.length).toBe(tarSize(entries));
    expect(readTar(tar)[`a/${'x'.repeat(150)}.txt`]).toBe(text);

    // ~11 MB through 5 MiB parts (R2's minimum) → 3 parts, compared by digest.
    const big = new Uint8Array(11 * 1024 * 1024).map((_, i) => i % 251);
    await putKnownLength(
      rt.env.BUCKET,
      'big',
      new Response(big).body!,
      big.length,
      {},
      5 * 1024 * 1024,
      0,
    );
    const back = new Uint8Array(await (await rt.env.BUCKET.get('big'))!.arrayBuffer());
    expect(back.length).toBe(big.length);
    expect(await sha256Hex(back)).toBe(await sha256Hex(big));
  });
});
