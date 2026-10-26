// VirusTotal in the scan pipeline (ADR-046): risky types by hash, unknown executables uploaded,
// a budget per minute/day/person, and files that never wait on it for long.
import { GetObjectCommand, PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/shared/config-defaults';
import { MOCK_VT_MARKER, type VirusTotal } from '../../src/worker/adapters/virustotal';
import { createCtx } from '../../src/worker/context';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { processScan } from '../../src/worker/services/scan';
import type { DevRuntime } from '../../dev/env';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { s3Setup, usage } from '../helpers/s3';
import { signIn } from '../helpers/session';
import { noticesOf } from '../helpers/notices';

function setVt(rt: DevRuntime, over: Partial<(typeof CONFIG_DEFAULTS)['virustotal']>) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES ('virustotal', ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(JSON.stringify({ ...CONFIG_DEFAULTS.virustotal, ...over }));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

const nodeState = (rt: DevRuntime, nodeId: string) =>
  rt.d1.sqlite
    .prepare(
      `SELECT n.status, b.scan_status, b.scan_detail, b.sha256, b.id AS blob_id
       FROM nodes n JOIN blobs b ON b.id = n.blob_id WHERE n.id = ?`,
    )
    .get(nodeId) as {
    status: string;
    scan_status: string;
    scan_detail: string | null;
    sha256: string;
    blob_id: string;
  };

const verdict = (rt: DevRuntime, sha256: string) =>
  rt.d1.sqlite.prepare('SELECT verdict, uploaded FROM vt_verdicts WHERE sha256 = ?').get(sha256) as
    { verdict: string; uploaded: number } | undefined;

async function driveUser(email: string) {
  const rt = await makeRuntime();
  const s = await signIn(rt, email);
  await grantPlan(rt, s.userId);
  return { rt, s, root: await rootOf(s) };
}

describe('VirusTotal (ADR-046)', () => {
  it('sends an unknown executable for analysis and lets it through when it is clean', async () => {
    const { rt, s, root } = await driveUser('exe@example.com');
    const node = await uploadText(s, root, 'Setup Kantor.exe', 'MZ\u0090 an installer');
    await rt.settle();
    const st = nodeState(rt, node.id);
    expect(st).toMatchObject({ status: 'ready', scan_status: 'clean' });
    expect(verdict(rt, st.sha256)).toEqual({ verdict: 'clean', uploaded: 1 });
  });

  it('rejects what VirusTotal calls malicious, blocklists the hash and tells the uploader', async () => {
    const { rt, s, root } = await driveUser('bad@example.com');
    const node = await uploadText(s, root, 'crack.exe', `MZ ${MOCK_VT_MARKER}`);
    await rt.settle();
    const st = nodeState(rt, node.id);
    expect(st).toMatchObject({ status: 'rejected', scan_status: 'infected' });
    expect(st.scan_detail).toMatch(/^VirusTotal: mock\.uploaded \(40\/70\)$/);
    expect(
      rt.d1.sqlite.prepare('SELECT reason FROM blocked_hashes WHERE sha256 = ?').get(st.sha256),
    ).toEqual({ reason: st.scan_detail });
    expect(verdict(rt, st.sha256)).toEqual({ verdict: 'malicious', uploaded: 1 });
    expect((await noticesOf(rt, s.userId)).map((n) => ({ type: n.type }))).toEqual([
      { type: 'file_rejected' },
    ]);
  });

  it('only looks documents up by hash, and leaves ordinary files alone', async () => {
    const { rt, s, root } = await driveUser('docs@example.com');
    const pdf = await uploadText(s, root, 'rapor.pdf', '%PDF-1.7 nilai semester');
    const note = await uploadText(s, root, 'catatan.txt', 'belanja: telur, beras');
    await rt.settle();
    const p = nodeState(rt, pdf.id);
    expect(p).toMatchObject({ status: 'ready', scan_detail: 'VirusTotal: not known' });
    expect(verdict(rt, p.sha256)).toEqual({ verdict: 'unknown', uploaded: 0 });
    const n = nodeState(rt, note.id);
    expect(n).toMatchObject({ status: 'ready', scan_detail: null });
    expect(verdict(rt, n.sha256)).toBeUndefined();
  });

  it('switched off in config, nothing is checked', async () => {
    const { rt, s, root } = await driveUser('off@example.com');
    setVt(rt, { enabled: false });
    const node = await uploadText(s, root, 'crack.exe', `MZ ${MOCK_VT_MARKER}`);
    await rt.settle();
    expect(nodeState(rt, node.id)).toMatchObject({ status: 'ready', scan_detail: null });
  });

  it('keeps to the key budget: waits for the next minute, goes through once the day is used', async () => {
    const { rt, s, root } = await driveUser('budget@example.com');
    setVt(rt, { per_minute: 1, per_day: 2 });
    const a = await uploadText(s, root, 'a.pdf', '%PDF-1.7 a');
    const b = await uploadText(s, root, 'b.pdf', '%PDF-1.7 b');
    const c = await uploadText(s, root, 'c.pdf', '%PDF-1.7 c');
    const ctx = createCtx(rt.env);
    let lookups = 0;
    const metered: VirusTotal = {
      name: 'metered',
      metered: true,
      lookup: () => {
        lookups++;
        return Promise.resolve('unknown');
      },
      upload: () => Promise.reject(new Error('not expected')),
      analysis: () => Promise.reject(new Error('not expected')),
    };
    ctx.adapters.virustotal = metered;
    const scan = rt.queues.SCAN_QUEUE;
    const sentBefore = scan.sent.length;

    expect(await processScan(ctx, nodeState(rt, a.id).blob_id)).toBe('clean');
    // Same minute: the second file waits, with what the scanner found carried along.
    expect(await processScan(ctx, nodeState(rt, b.id).blob_id)).toBe('pending');
    const again = scan.sent.slice(sentBefore).at(-1) as {
      type: string;
      vt: { n: number; analysisId: null; base: { sha256: string } };
    };
    expect(again).toMatchObject({ type: 'scan', vt: { n: 1, analysisId: null } });
    const { createHash } = await import('node:crypto');
    expect(again.vt.base.sha256).toBe(createHash('sha256').update('%PDF-1.7 b').digest('hex'));
    expect(nodeState(rt, b.id)).toMatchObject({ status: 'scanning', scan_status: 'pending' });
    expect(lookups).toBe(1);

    // Next minute: the waiting file is looked up from what it carried.
    const later = createCtx({ ...rt.env, CLOCK: { now: () => Date.now() + 61_000 } });
    later.adapters.virustotal = metered;
    expect(await processScan(later, nodeState(rt, b.id).blob_id, again.vt as never)).toBe('clean');
    expect(lookups).toBe(2);

    // The day's two requests are spent: the third file goes through, and says why.
    const next = createCtx({ ...rt.env, CLOCK: { now: () => Date.now() + 122_000 } });
    next.adapters.virustotal = metered;
    expect(await processScan(next, nodeState(rt, c.id).blob_id)).toBe('clean');
    expect(lookups).toBe(2);
    expect(nodeState(rt, c.id)).toMatchObject({
      status: 'ready',
      scan_detail: 'VirusTotal: daily limit reached',
    });
  });

  it('a refused key never holds files back, and the operator hears about it', async () => {
    const { rt, s, root } = await driveUser('key@example.com');
    const node = await uploadText(s, root, 'tool.exe', 'MZ tool');
    const ctx = createCtx(rt.env);
    const { VtError } = await import('../../src/worker/adapters/virustotal');
    ctx.adapters.virustotal = {
      name: 'refusing',
      metered: false,
      lookup: () => Promise.reject(new VtError('auth', 'VirusTotal refused the key (HTTP 401)')),
      upload: () => Promise.reject(new Error('not expected')),
      analysis: () => Promise.reject(new Error('not expected')),
    };
    expect(await processScan(ctx, nodeState(rt, node.id).blob_id)).toBe('clean');
    expect(nodeState(rt, node.id)).toMatchObject({
      status: 'ready',
      scan_detail: 'VirusTotal: key refused',
    });
    expect(
      rt.queues.NOTIFY_QUEUE.sent.some(
        (m) => m.type === 'admin_alert' && m.text.includes('VIRUSTOTAL_API_KEY'),
      ),
    ).toBe(true);
  });

  it('checks Zeiko S3 objects too, and gives the storage of a rejected one back', async () => {
    const { rt, user, client } = await s3Setup({ email: 'vt-s3@zeiko.test' });
    await client.send(new CreateBucketCommand({ Bucket: 'alat-alat' }));
    await client.send(
      new PutObjectCommand({
        Bucket: 'alat-alat',
        Key: 'bin/patch.exe',
        Body: `MZ ${MOCK_VT_MARKER}`,
      }),
    );
    await client.send(
      new PutObjectCommand({ Bucket: 'alat-alat', Key: 'bin/ok.exe', Body: 'MZ fine tool' }),
    );
    await rt.settle();
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'alat-alat', Key: 'bin/patch.exe' })),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
    const ok = await client.send(new GetObjectCommand({ Bucket: 'alat-alat', Key: 'bin/ok.exe' }));
    expect(await ok.Body!.transformToString()).toBe('MZ fine tool');
    expect(usage(rt, user.userId)).toEqual({ used: 'MZ fine tool'.length, reserved: 0 });
  });
});
