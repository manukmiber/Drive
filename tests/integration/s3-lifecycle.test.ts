// Lifecycle rules in Zeiko S3 (ADR-072): Put/Get/DeleteBucketLifecycleConfiguration through the real
// AWS SDK and as aws-cli sends it, and the hourly run deleting exactly what is due on a fake clock.
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CRON, DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import {
  expiryCutoff,
  lifecycleXml,
  parseLifecycleXml,
} from '../../src/worker/services/s3-lifecycle';
import { makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Setup, usage } from '../helpers/s3';

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

const START = Date.UTC(2026, 10, 1, 9, 30); // 1 Nov 2026, 09:30 UTC

async function withClock() {
  const clock = new FakeClock(START);
  const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
  return { clock, ...(await s3Setup({ rt })) };
}

const keysIn = async (s: Awaited<ReturnType<typeof withClock>>, Bucket: string) =>
  ((await s.client.send(new ListObjectsV2Command({ Bucket }))).Contents ?? []).map((c) => c.Key);

describe('Zeiko S3 lifecycle', () => {
  it('counts days the way Amazon does: to the next midnight UTC', () => {
    // Written 1 Nov 09:30 with Days=1: due from 3 Nov 00:00 UTC (1 Nov + 1 day, rounded up).
    const written = START;
    const due = (now: number) => written < expiryCutoff(now, 1);
    expect(due(Date.UTC(2026, 10, 2, 23, 59))).toBe(false);
    expect(due(Date.UTC(2026, 10, 3, 0, 0))).toBe(true);
  });

  it('parses what aws-cli sends and writes it back; refuses what it does not do', () => {
    const xml = `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Rule><ID>log</ID><Filter><Prefix>log/</Prefix></Filter><Status>Enabled</Status>
        <Expiration><Days>30</Days></Expiration></Rule>
      <Rule><ID>besar</ID><Filter><And><Prefix>tmp/</Prefix><ObjectSizeGreaterThan>1000</ObjectSizeGreaterThan></And></Filter>
        <Status>Disabled</Status><Expiration><Date>2027-01-01T00:00:00.000Z</Date></Expiration></Rule>
      <Rule><Prefix>up/</Prefix><Status>Enabled</Status>
        <AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>
    </LifecycleConfiguration>`;
    const rules = parseLifecycleXml(xml, 100);
    expect(rules).toEqual([
      { id: 'log', enabled: true, prefix: 'log/', expirationDays: 30 },
      {
        id: 'besar',
        enabled: false,
        prefix: 'tmp/',
        sizeGreaterThan: 1000,
        expirationDate: Date.UTC(2027, 0, 1),
      },
      { id: 'rule-3', enabled: true, prefix: 'up/', abortDays: 7 },
    ]);
    expect(parseLifecycleXml(lifecycleXml(rules), 100)).toEqual(rules);

    const rule = (inner: string) =>
      `<LifecycleConfiguration><Rule><Status>Enabled</Status>${inner}</Rule></LifecycleConfiguration>`;
    const code = (xml: string) => {
      try {
        parseLifecycleXml(xml, 2);
      } catch (e) {
        return (e as { code: string }).code;
      }
      return 'ok';
    };
    expect(
      code(rule('<Transition><Days>30</Days><StorageClass>GLACIER</StorageClass></Transition>')),
    ).toBe('NotImplemented');
    expect(
      code(
        rule(
          '<Filter><Tag><Key>a</Key><Value>b</Value></Tag></Filter><Expiration><Days>1</Days></Expiration>',
        ),
      ),
    ).toBe('NotImplemented');
    expect(
      code(
        rule(
          '<NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration>',
        ),
      ),
    ).toBe('NotImplemented');
    expect(code(rule('<Expiration><Days>0</Days></Expiration>'))).toBe('InvalidArgument');
    expect(code(rule('<Expiration><Date>2027-01-01T05:00:00Z</Date></Expiration>'))).toBe(
      'InvalidArgument',
    );
    expect(code(rule('<Bogus/><Expiration><Days>1</Days></Expiration>'))).toBe('MalformedXML');
    expect(code(rule(''))).toBe('InvalidRequest');
    expect(
      code(
        rule(
          '<Filter><ObjectSizeGreaterThan>5</ObjectSizeGreaterThan></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>',
        ),
      ),
    ).toBe('InvalidRequest');
    expect(
      code(
        '<LifecycleConfiguration><Rule><Status>On</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>',
      ),
    ).toBe('MalformedXML');
    const three = `<LifecycleConfiguration>${'<Rule><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>'.repeat(3)}</LifecycleConfiguration>`;
    expect(code(three)).toBe('InvalidRequest');
  });

  it('Put, Get and Delete through the SDK', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'siklus' }));
    await expectS3Error(
      s.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: 'siklus' })),
      'NoSuchLifecycleConfiguration',
      404,
    );
    await s.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: 'siklus',
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'log',
              Status: 'Enabled',
              Filter: { Prefix: 'log/' },
              Expiration: { Days: 7 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
            },
          ],
        },
      }),
    );
    const got = await s.client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: 'siklus' }),
    );
    expect(got.Rules?.[0]).toMatchObject({
      ID: 'log',
      Status: 'Enabled',
      Filter: { Prefix: 'log/' },
      Expiration: { Days: 7 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
    });
    const page = (await (await s.user.req('GET', '/api/s3')).json()) as {
      buckets: Array<{ name: string; lifecycle: unknown }>;
    };
    expect(page.buckets[0]?.lifecycle).toEqual([
      { id: 'log', enabled: true, prefix: 'log/', expirationDays: 7, abortDays: 2 },
    ]);
    await expectS3Error(
      s.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: 'siklus',
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'arsip',
                Status: 'Enabled',
                Filter: { Prefix: '' },
                Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
              },
            ],
          },
        }),
      ),
      'NotImplemented',
      501,
    );
    await s.client.send(new DeleteBucketLifecycleCommand({ Bucket: 'siklus' }));
    await expectS3Error(
      s.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: 'siklus' })),
      'NoSuchLifecycleConfiguration',
      404,
    );
    // The page's editor uses the same rules.
    const put = await s.user.req('PUT', '/api/s3/buckets/siklus/lifecycle', {
      rules: [{ prefix: 'tmp/', expirationDays: 1 }],
    });
    expect(put.status).toBe(200);
    expect(
      (await s.user.req('PUT', '/api/s3/buckets/siklus/lifecycle', { rules: [{ prefix: 'x/' }] }))
        .status,
    ).toBe(400);
    expect((await s.user.req('DELETE', '/api/s3/buckets/siklus/lifecycle')).status).toBe(204);
  });

  it('a restricted key may read the rules but not change them', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'kunci' }));
    const res = await s.user.req('POST', '/api/s3/keys', { label: 'r', access: 'r' });
    const key = ((await res.json()) as { key: { id: string; secret: string } }).key;
    const { s3Client } = await import('../helpers/s3');
    const reader = s3Client(s.rt, key);
    await expectS3Error(
      reader.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: 'kunci',
          LifecycleConfiguration: {
            Rules: [
              { ID: 'a', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } },
            ],
          },
        }),
      ),
      'AccessDenied',
      403,
    );
  });

  it('the hourly run deletes exactly what is due and aborts forgotten uploads', async () => {
    const s = await withClock();
    await s.client.send(new CreateBucketCommand({ Bucket: 'harian' }));
    for (const Key of ['log/a.txt', 'log/b.txt', 'simpan/c.txt'])
      await s.client.send(new PutObjectCommand({ Bucket: 'harian', Key, Body: 'isi' }));
    await s.client.send(
      new PutObjectCommand({ Bucket: 'harian', Key: 'tmp/besar.bin', Body: 'x'.repeat(2000) }),
    );
    await s.client.send(
      new PutObjectCommand({ Bucket: 'harian', Key: 'tmp/kecil.bin', Body: 'x'.repeat(10) }),
    );
    const up = await s.client.send(
      new CreateMultipartUploadCommand({ Bucket: 'harian', Key: 'up/video.mp4' }),
    );
    await s.client.send(
      new UploadPartCommand({
        Bucket: 'harian',
        Key: 'up/video.mp4',
        UploadId: up.UploadId,
        PartNumber: 1,
        Body: 'bagian',
      }),
    );
    expect(usage(s.rt, s.user.userId).reserved).toBe(6);
    // A newer object in log/, written a day later: not due on the same day as the others.
    s.clock.advance(DAY_MS);
    await s.client.send(
      new PutObjectCommand({ Bucket: 'harian', Key: 'log/baru.txt', Body: 'isi' }),
    );
    await s.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: 'harian',
        LifecycleConfiguration: {
          Rules: [
            { ID: 'log', Status: 'Enabled', Filter: { Prefix: 'log/' }, Expiration: { Days: 1 } },
            {
              ID: 'tmp-besar',
              Status: 'Enabled',
              Filter: { And: { Prefix: 'tmp/', ObjectSizeGreaterThan: 1000 } },
              Expiration: { Days: 1 },
            },
            {
              ID: 'up',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
            { ID: 'mati', Status: 'Disabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } },
          ],
        },
      }),
    );
    // 2 Nov 23:00: nothing is due yet (the first objects go at 3 Nov 00:00 UTC).
    s.clock.set(Date.UTC(2026, 10, 2, 23, 0));
    for (let i = 0; i < 4; i++) await s.rt.runCron(CRON.hourly);
    expect(await keysIn(s, 'harian')).toHaveLength(6);

    // 3 Nov 01:00: the old log files, the big tmp file and the upload go; the rest stays.
    s.clock.set(Date.UTC(2026, 10, 3, 1, 0));
    for (let i = 0; i < 6; i++) await s.rt.runCron(CRON.hourly);
    expect(await keysIn(s, 'harian')).toEqual(['log/baru.txt', 'simpan/c.txt', 'tmp/kecil.bin']);
    const uploads = await s.client.send(new ListMultipartUploadsCommand({ Bucket: 'harian' }));
    expect(uploads.Uploads ?? []).toEqual([]);
    expect(usage(s.rt, s.user.userId)).toEqual({ used: 3 + 3 + 10, reserved: 0 });

    // A day later the newer log file goes too.
    s.clock.set(Date.UTC(2026, 10, 4, 1, 0));
    for (let i = 0; i < 4; i++) await s.rt.runCron(CRON.hourly);
    expect(await keysIn(s, 'harian')).toEqual(['simpan/c.txt', 'tmp/kecil.bin']);
  });

  it('works through a big bucket a page at a time, and leaves locked accounts alone', async () => {
    const s = await withClock();
    await s.client.send(new CreateBucketCommand({ Bucket: 'banyak' }));
    for (let i = 0; i < 25; i++)
      await s.client.send(
        new PutObjectCommand({
          Bucket: 'banyak',
          Key: `f/${String(i).padStart(2, '0')}`,
          Body: 'z',
        }),
      );
    s.rt.d1.sqlite
      .prepare(
        `INSERT OR REPLACE INTO app_config (key, value_json, updated_at) VALUES ('s3_lifecycle_scan_rows', '10', 0)`,
      )
      .run();
    await s.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: 'banyak',
        LifecycleConfiguration: {
          Rules: [
            { ID: 'semua', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } },
          ],
        },
      }),
    );
    s.clock.set(Date.UTC(2026, 10, 5, 1, 0));
    // Locked for an unpaid bill: nothing happens.
    s.rt.d1.sqlite
      .prepare(`UPDATE s3_accounts SET billing_state = 'locked' WHERE user_id = ?`)
      .run(s.user.userId);
    await s.rt.runCron(CRON.hourly);
    const count = () =>
      (
        s.rt.d1.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM s3_objects WHERE bucket = 'banyak'`)
          .get() as { n: number }
      ).n;
    expect(count()).toBe(25);
    s.rt.d1.sqlite
      .prepare(
        `UPDATE s3_accounts SET billing_state = 'ok', updated_at = updated_at WHERE user_id = ?`,
      )
      .run(s.user.userId);
    s.rt.d1.sqlite.prepare(`UPDATE s3_buckets SET lifecycle_at = 0 WHERE name = 'banyak'`).run();
    await s.rt.runCron(CRON.hourly);
    expect(count()).toBe(15);
    await s.rt.runCron(CRON.hourly);
    await s.rt.runCron(CRON.hourly);
    expect(count()).toBe(0);
    expect(usage(s.rt, s.user.userId).used).toBe(0);
  });
});
