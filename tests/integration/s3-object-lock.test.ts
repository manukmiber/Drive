// Zeiko S3 Object Lock (ADR-092, S5) through the real AWS SDK v3: buckets made with a lock,
// default retention, GOVERNANCE (bypassed only by a full-access key), COMPLIANCE (never shortened),
// legal holds, and account deletion that takes locked objects too (the owner's answer).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectLockConfigurationCommand,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { createCtx } from '../../src/worker/context';
import { purgeS3Account } from '../../src/worker/services/s3-objects';
import { makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Client, s3Setup, usage } from '../helpers/s3';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1, 9, 30);

async function expectS3Error(p: Promise<unknown>, code: string, status: number) {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    expect(err.Code ?? err.name).toBe(code);
    expect(err.$metadata?.httpStatusCode).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function locked(Bucket: string) {
  const clock = new FakeClock(START);
  const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
  const s = await s3Setup({ rt });
  await s.client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
  return { ...s, clock };
}

describe('Zeiko S3 Object Lock', () => {
  it('a bucket made with Object Lock keeps versions and gives new objects its default retention', async () => {
    const s = await locked('cadangan');
    const cfg = await s.client.send(new GetObjectLockConfigurationCommand({ Bucket: 'cadangan' }));
    expect(cfg.ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
    // Versioning can't be paused under a lock.
    await expectS3Error(
      s.client.send(
        new PutBucketVersioningCommand({
          Bucket: 'cadangan',
          VersioningConfiguration: { Status: 'Suspended' },
        }),
      ),
      'InvalidBucketState',
      409,
    );
    await s.client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: 'cadangan',
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
        },
      }),
    );
    const put = await s.client.send(
      new PutObjectCommand({ Bucket: 'cadangan', Key: 'veeam/blok.bin', Body: 'data' }),
    );
    const ret = await s.client.send(
      new GetObjectRetentionCommand({ Bucket: 'cadangan', Key: 'veeam/blok.bin' }),
    );
    expect(ret.Retention?.Mode).toBe('GOVERNANCE');
    expect(ret.Retention?.RetainUntilDate?.getTime()).toBe(START + 7 * DAY);
    const got = await s.client.send(
      new GetObjectCommand({ Bucket: 'cadangan', Key: 'veeam/blok.bin' }),
    );
    expect(got.ObjectLockMode).toBe('GOVERNANCE');
    // A plain delete only adds a marker; the locked version stays.
    await s.client.send(new DeleteObjectCommand({ Bucket: 'cadangan', Key: 'veeam/blok.bin' }));
    await expectS3Error(
      s.client.send(
        new DeleteObjectCommand({
          Bucket: 'cadangan',
          Key: 'veeam/blok.bin',
          VersionId: put.VersionId,
        }),
      ),
      'AccessDenied',
      403,
    );
    // A key limited to one bucket may not bypass governance; the full-access key may.
    const res = await s.user.req('POST', '/api/s3/keys', {
      label: 'terbatas',
      buckets: ['cadangan'],
    });
    const limited = s3Client(
      s.rt,
      ((await res.json()) as { key: { id: string; secret: string } }).key,
    );
    await expectS3Error(
      limited.send(
        new DeleteObjectCommand({
          Bucket: 'cadangan',
          Key: 'veeam/blok.bin',
          VersionId: put.VersionId,
          BypassGovernanceRetention: true,
        }),
      ),
      'AccessDenied',
      403,
    );
    await s.client.send(
      new DeleteObjectCommand({
        Bucket: 'cadangan',
        Key: 'veeam/blok.bin',
        VersionId: put.VersionId,
        BypassGovernanceRetention: true,
      }),
    );
    expect(usage(s.rt, s.user.userId).used).toBe(0);
  });

  it('COMPLIANCE is never shortened or bypassed, only lengthened, and ends on its date', async () => {
    const s = await locked('patuh');
    const put = await s.client.send(
      new PutObjectCommand({
        Bucket: 'patuh',
        Key: 'arsip.zip',
        Body: 'penting',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(START + 2 * DAY),
      }),
    );
    const del = () =>
      s.client.send(
        new DeleteObjectCommand({
          Bucket: 'patuh',
          Key: 'arsip.zip',
          VersionId: put.VersionId,
          BypassGovernanceRetention: true,
        }),
      );
    await expectS3Error(del(), 'AccessDenied', 403);
    await expectS3Error(
      s.client.send(
        new PutObjectRetentionCommand({
          Bucket: 'patuh',
          Key: 'arsip.zip',
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date(START + DAY) },
          BypassGovernanceRetention: true,
        }),
      ),
      'AccessDenied',
      403,
    );
    await expectS3Error(
      s.client.send(
        new PutObjectRetentionCommand({
          Bucket: 'patuh',
          Key: 'arsip.zip',
          Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(START + 5 * DAY) },
        }),
      ),
      'AccessDenied',
      403,
    );
    await s.client.send(
      new PutObjectRetentionCommand({
        Bucket: 'patuh',
        Key: 'arsip.zip',
        Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date(START + 3 * DAY) },
      }),
    );
    s.clock.set(START + 3 * DAY - 1000);
    await expectS3Error(del(), 'AccessDenied', 403);
    s.clock.set(START + 3 * DAY + 1000);
    await del();
  });

  it('a legal hold keeps a version until it is lifted', async () => {
    const s = await locked('tahan');
    const put = await s.client.send(
      new PutObjectCommand({
        Bucket: 'tahan',
        Key: 'bukti.pdf',
        Body: 'bukti',
        ObjectLockLegalHoldStatus: 'ON',
      }),
    );
    const hold = await s.client.send(
      new GetObjectLegalHoldCommand({ Bucket: 'tahan', Key: 'bukti.pdf' }),
    );
    expect(hold.LegalHold?.Status).toBe('ON');
    const del = () =>
      s.client.send(
        new DeleteObjectCommand({
          Bucket: 'tahan',
          Key: 'bukti.pdf',
          VersionId: put.VersionId,
          BypassGovernanceRetention: true,
        }),
      );
    await expectS3Error(del(), 'AccessDenied', 403);
    await s.client.send(
      new PutObjectLegalHoldCommand({
        Bucket: 'tahan',
        Key: 'bukti.pdf',
        VersionId: put.VersionId,
        LegalHold: { Status: 'OFF' },
      }),
    );
    await del();
  });

  it('a bucket without Object Lock refuses locks instead of ignoring them', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'biasa' }));
    await expectS3Error(
      s.client.send(new GetObjectLockConfigurationCommand({ Bucket: 'biasa' })),
      'ObjectLockConfigurationNotFoundError',
      404,
    );
    await expectS3Error(
      s.client.send(
        new PutObjectCommand({
          Bucket: 'biasa',
          Key: 'a',
          Body: 'a',
          ObjectLockMode: 'GOVERNANCE',
          ObjectLockRetainUntilDate: new Date(Date.now() + DAY),
        }),
      ),
      'InvalidRequest',
      400,
    );
    // Turning Object Lock on needs versioning first.
    await expectS3Error(
      s.client.send(
        new PutObjectLockConfigurationCommand({
          Bucket: 'biasa',
          ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
        }),
      ),
      'InvalidBucketState',
      409,
    );
  });

  it('deleting the account takes locked objects too (the lock ends with the paid plan)', async () => {
    const s = await locked('akhir');
    await s.client.send(
      new PutObjectCommand({
        Bucket: 'akhir',
        Key: 'kunci.bin',
        Body: 'x',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(START + 365 * DAY),
        ObjectLockLegalHoldStatus: 'ON',
      }),
    );
    await s.client.send(new PutObjectCommand({ Bucket: 'akhir', Key: 'kunci.bin', Body: 'yy' }));
    const ctx = createCtx(s.rt.env);
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = await purgeS3Account(ctx, s.user.userId);
    expect(done).toBe(true);
    expect((await s.rt.r2.list({ prefix: `s3/${s.user.userId}/` })).objects).toHaveLength(0);
    expect(s.rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_versions').get()).toEqual({ n: 0 });
  });
});
