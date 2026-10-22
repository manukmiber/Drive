import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { DAY_MS, CRON } from '../../src/shared/constants';
import { createCtx } from '../../src/worker/context';
import { consumeCredits, creditBalance, refundCredits } from '../../src/worker/services/credits';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { grantPlan, pool, rootOf, simpleUpload, type NodeJson } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const T0 = Date.UTC(2026, 9, 10, 3, 0);

async function setup(email = 'kompres@example.com') {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, email);
  const poolId = await grantPlan(rt, s.userId, 'plus');
  return { rt, s, clock, poolId, root: await rootOf(s) };
}

function grant(
  rt: DevRuntime,
  userId: string,
  n: number,
  source: 'plan' | 'pack',
  expiresAt: number,
  id: string,
) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'test', ?, ?)`,
    )
    .run(id, userId, n, n, source, expiresAt, T0);
}

/** Minimal MP4: ftyp + moov/mvhd (v0) with the given duration, padded to `size`. */
function mp4(seconds: number, size = 4000, marker = ''): Uint8Array {
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode(`\0\0\0\x14ftypisom${marker}`), 0);
  const at = 64;
  v.setUint32(at, 108);
  buf.set(new TextEncoder().encode('moov'), at + 4);
  v.setUint32(at + 8, 100);
  buf.set(new TextEncoder().encode('mvhd'), at + 12);
  v.setUint32(at + 16 + 12, 1000); // timescale
  v.setUint32(at + 16 + 16, seconds * 1000); // duration
  return buf;
}

async function upload(
  s: Session,
  parent: string,
  name: string,
  data: Uint8Array,
): Promise<NodeJson> {
  const res = await simpleUpload(s, parent, name, data);
  expect(res.status).toBe(201);
  return ((await res.json()) as { node: NodeJson }).node;
}

type Jobs = {
  credits: number;
  jobs: Array<{
    id: string;
    status: string;
    name: string;
    savedBytes: number | null;
    outNodeId: string | null;
    error: string | null;
    creditsUsed: number;
    engine: string;
  }>;
};
const jobs = async (s: Session) => (await (await s.req('GET', '/api/compress')).json()) as Jobs;

describe('compress credits', () => {
  it('uses the plan quota first, then the pack that expires soonest; refunds once', async () => {
    const { rt, s } = await setup();
    grant(rt, s.userId, 2, 'plan', T0 + 30 * DAY_MS, 'g_plan');
    grant(rt, s.userId, 5, 'pack', T0 + 10 * DAY_MS, 'g_late');
    grant(rt, s.userId, 5, 'pack', T0 + 5 * DAY_MS, 'g_soon');
    const ctx = createCtx(rt.env);
    expect(await creditBalance(ctx, s.userId)).toBe(12);
    expect(await consumeCredits(ctx, s.userId, 3, 'job1')).toBe(true);
    const rem = (id: string) =>
      (
        rt.d1.sqlite.prepare('SELECT remaining FROM credit_ledger WHERE id = ?').get(id) as {
          remaining: number;
        }
      ).remaining;
    expect([rem('g_plan'), rem('g_soon'), rem('g_late')]).toEqual([0, 4, 5]);
    expect(await consumeCredits(ctx, s.userId, 50, 'job2')).toBe(false);
    expect(await creditBalance(ctx, s.userId)).toBe(9);
    expect(await refundCredits(ctx, s.userId, 'job1')).toBe(3);
    expect(await refundCredits(ctx, s.userId, 'job1')).toBe(0);
    expect(await creditBalance(ctx, s.userId)).toBe(12);
  });
});

describe('compress jobs', () => {
  it('saves an image as a copy, charges 1 credit and notifies', async () => {
    const { rt, s, root, poolId } = await setup();
    grant(rt, s.userId, 10, 'plan', T0 + 30 * DAY_MS, 'g1');
    const photo = await upload(s, root, 'liburan.jpg', new Uint8Array(1000).fill(7));
    await rt.settle();
    const res = await s.req('POST', '/api/compress', {
      nodeIds: [photo.id],
      image: { format: 'webp', quality: 'hemat' },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { queued: number }).queued).toBe(1);
    await rt.settle();
    const j = await jobs(s);
    expect(j.credits).toBe(9);
    expect(j.jobs[0]).toMatchObject({ status: 'done', savedBytes: 600, engine: 'images' });
    const out = rt.d1.sqlite
      .prepare('SELECT name, size, status FROM nodes WHERE id = ?')
      .get(j.jobs[0]!.outNodeId) as {
      name: string;
      size: number;
      status: string;
    };
    expect(out).toEqual({ name: 'liburan (kompres).webp', size: 400, status: 'ready' });
    expect(pool(rt, poolId).used_bytes).toBe(1400);
    const notes = (await (await s.req('GET', '/api/notifications')).json()) as {
      items: Array<{ type: string; title: string }>;
    };
    expect(notes.items[0]).toMatchObject({ type: 'compress_done' });
    expect(notes.items[0]!.title).toContain('hemat');
  });

  it('replaces a short video in place via Media Transformations and frees the old blob', async () => {
    const { rt, s, root, poolId } = await setup();
    grant(rt, s.userId, 10, 'plan', T0 + 30 * DAY_MS, 'g1');
    const clip = await upload(s, root, 'klip.mov', mp4(30, 5000));
    await rt.settle();
    const oldBlob = (
      rt.d1.sqlite.prepare('SELECT blob_id FROM nodes WHERE id = ?').get(clip.id) as {
        blob_id: string;
      }
    ).blob_id;
    const res = await s.req('POST', '/api/compress', {
      nodeIds: [clip.id],
      save: 'replace',
      video: { preset: '480p', quality: 'seimbang' },
    });
    expect(res.status).toBe(201);
    await rt.settle();
    const j = await jobs(s);
    expect(j.jobs[0]).toMatchObject({
      status: 'done',
      engine: 'media',
      creditsUsed: 1,
      outNodeId: clip.id,
    });
    const node = rt.d1.sqlite
      .prepare('SELECT name, size, blob_id FROM nodes WHERE id = ?')
      .get(clip.id) as {
      name: string;
      size: number;
      blob_id: string;
    };
    expect(node.name).toBe('klip.mp4');
    expect(node.size).toBe(3000);
    expect(node.blob_id).not.toBe(oldBlob);
    expect(pool(rt, poolId).used_bytes).toBe(3000);
    expect(rt.d1.sqlite.prepare('SELECT id FROM blobs WHERE id = ?').get(oldBlob)).toBeUndefined();
  });

  it('keeps the original and refunds when the result is not smaller', async () => {
    const { rt, s, root } = await setup();
    grant(rt, s.userId, 1, 'plan', T0 + 30 * DAY_MS, 'g1');
    const bytes = new TextEncoder().encode('ZK-NOSHRINK'.padEnd(800, 'x'));
    const photo = await upload(s, root, 'foto.png', bytes);
    await rt.settle();
    await s.req('POST', '/api/compress', { nodeIds: [photo.id], save: 'replace' });
    await rt.settle();
    const j = await jobs(s);
    expect(j.jobs[0]).toMatchObject({ status: 'skipped', error: 'NOT_SMALLER' });
    expect(j.credits).toBe(1);
    expect(
      (
        rt.d1.sqlite.prepare('SELECT size FROM nodes WHERE id = ?').get(photo.id) as {
          size: number;
        }
      ).size,
    ).toBe(800);
  });

  it('refuses without credits and charges long videos per minute', async () => {
    const { rt, s, root } = await setup();
    const photo = await upload(s, root, 'a.jpg', new Uint8Array(500).fill(1));
    const long = await upload(s, root, 'panjang.mp4', mp4(150, 6000));
    await rt.settle();
    expect((await s.req('POST', '/api/compress', { nodeIds: [photo.id] })).status).toBe(402);

    grant(rt, s.userId, 3, 'pack', T0 + 30 * DAY_MS, 'g1');
    (rt.env as { ADAPTER_MEDIA?: string }).ADAPTER_MEDIA = 'mock-nocontainer';
    const blocked = await s.req('POST', '/api/compress', { nodeIds: [long.id] });
    expect(blocked.status).toBe(400);
    expect(await creditBalance(createCtx(rt.env), s.userId)).toBe(3);

    (rt.env as { ADAPTER_MEDIA?: string }).ADAPTER_MEDIA = 'mock';
    const res = await s.req('POST', '/api/compress', { nodeIds: [long.id, photo.id] });
    const body = (await res.json()) as { queued: number; failed: Array<{ reason: string }> };
    expect(body.queued).toBe(1); // 150 s → 3 credits; nothing left for the photo
    expect(body.failed).toEqual([{ nodeId: photo.id, reason: 'NO_CREDITS' }]);
    await rt.settle();
    expect((await jobs(s)).jobs.find((x) => x.name === 'panjang.mp4')).toMatchObject({
      engine: 'ffmpeg',
      creditsUsed: 3,
      status: 'done',
    });
  });

  it('does not let another user compress my files', async () => {
    const { rt, s, root } = await setup();
    const photo = await upload(s, root, 'rahasia.jpg', new Uint8Array(500).fill(1));
    await rt.settle();
    const other = await signIn(rt, 'lain@example.com');
    grant(rt, other.userId, 5, 'pack', T0 + 30 * DAY_MS, 'g2');
    const res = await other.req('POST', '/api/compress', { nodeIds: [photo.id] });
    expect(res.status).toBe(400);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM compress_jobs').get()).toEqual({ n: 0 });
  });
});

describe('standalone compress', () => {
  it('uploads to tmp, returns the result once, and purges after 24 h', async () => {
    const { rt, s, clock, poolId } = await setup();
    grant(rt, s.userId, 2, 'pack', T0 + 30 * DAY_MS, 'g1');
    const data = new Uint8Array(2000).fill(9);
    const start = await s.req('POST', '/api/compress/standalone', {
      name: 'scan.jpg',
      size: data.length,
      mime: 'image/jpeg',
      image: { format: 'jpeg', quality: 'tinggi' },
    });
    expect(start.status).toBe(201);
    const { jobId, parts } = (await start.json()) as { jobId: string; parts: number };
    expect(parts).toBe(1);
    const part = await s.req('PUT', `/api/compress/standalone/${jobId}/parts/1`, undefined, {
      body: data,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
      },
    });
    expect(part.status).toBe(200);
    const done = await s.req('POST', `/api/compress/standalone/${jobId}/complete`, {
      parts: [(await part.json()) as { partNumber: number; etag: string }],
    });
    expect(done.status).toBe(200);
    await rt.settle();
    const result = await s.req('GET', `/api/compress/standalone/${jobId}/result`);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-disposition')).toContain('scan%20(kompres).jpg');
    expect((await result.arrayBuffer()).byteLength).toBe(1600);
    expect(pool(rt, poolId).used_bytes).toBe(0); // tmp files never count against the quota
    expect((await jobs(s)).credits).toBe(1);

    clock.advance(DAY_MS + 60_000);
    await rt.runCron(CRON.hourly);
    expect((await s.req('GET', `/api/compress/standalone/${jobId}/result`)).status).toBe(404);
    expect((await rt.r2.list({ prefix: 'tmp/compress/' })).objects.length > 0).toBe(false);
  });
});
