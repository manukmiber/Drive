// Zeiko S3 per-bucket statistics and server access logs (ADR-060), through the real AWS SDK.
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketLoggingCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketAclCommand,
  PutBucketLoggingCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CRON } from '../../src/shared/constants';
import { logTime, restOperation, wibDay } from '../../src/worker/services/s3-stats';
import { s3Setup, S3_ORIGIN } from '../helpers/s3';

async function sdkError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string };
    return err.Code ?? err.name ?? 'unknown';
  }
  return 'none';
}

interface Stats {
  objects: number;
  bytes: number;
  days: Array<{
    day: number;
    requests: number;
    errors: number;
    ingressBytes: number;
    egressBytes: number;
  }>;
  logging: { target: string; prefix: string } | null;
}

const put = (Bucket: string, Key: string, n: number) =>
  new PutObjectCommand({ Bucket, Key, Body: new Uint8Array(n) });

describe('Zeiko S3 bucket statistics (ADR-060)', () => {
  it('counts objects, bytes, requests, errors and egress per bucket per day', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'stats-a' }));
    await client.send(new CreateBucketCommand({ Bucket: 'stats-b' }));
    await client.send(put('stats-a', 'a.bin', 10));
    await client.send(put('stats-a', 'b.bin', 20));
    await client.send(put('stats-a', 'c.bin', 30));
    await client.send(put('stats-b', 'z.bin', 5));
    const got = await client.send(new GetObjectCommand({ Bucket: 'stats-a', Key: 'c.bin' }));
    await got.Body!.transformToByteArray();
    await client.send(new HeadObjectCommand({ Bucket: 'stats-a', Key: 'a.bin' }));
    expect(
      await sdkError(client.send(new GetObjectCommand({ Bucket: 'stats-a', Key: 'none' }))),
    ).toBe('NoSuchKey');
    await rt.settle();

    const res = await user.req('GET', '/api/s3/buckets/stats-a/stats');
    expect(res.status).toBe(200);
    const stats = (await res.json()) as Stats;
    expect(stats.objects).toBe(3);
    expect(stats.bytes).toBe(60);
    expect(stats.days).toHaveLength(30);
    const today = stats.days[stats.days.length - 1]!;
    expect(today.day).toBe(wibDay(Date.now()));
    // Three puts, a get, a head and a miss; creating the bucket is not counted (it did not exist).
    expect(today).toMatchObject({ requests: 6, errors: 1, ingressBytes: 60, egressBytes: 30 });
    expect(stats.days.slice(0, -1).every((d) => d.requests === 0)).toBe(true);

    const other = (await (await user.req('GET', '/api/s3/buckets/stats-b/stats')).json()) as Stats;
    expect(other.objects).toBe(1);
    expect(other.days.at(-1)).toMatchObject({ requests: 1, ingressBytes: 5 });
  });

  it('names operations and times the way Amazon logs do', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(restOperation('GET', 'a.txt', q(''))).toBe('REST.GET.OBJECT');
    expect(restOperation('PUT', 'a.txt', q('uploadId=1&partNumber=2'))).toBe('REST.PUT.PART');
    expect(restOperation('POST', 'a.txt', q('uploads'))).toBe('REST.POST.UPLOADS');
    expect(restOperation('GET', null, q('list-type=2'))).toBe('REST.GET.BUCKET');
    expect(restOperation('PUT', null, q('logging'))).toBe('REST.PUT.LOGGING_STATUS');
    expect(restOperation('POST', null, q('delete'))).toBe('REST.POST.MULTI_OBJECT_DELETE');
    expect(logTime(Date.UTC(2019, 1, 6, 0, 0, 38))).toBe('[06/Feb/2019:00:00:38 +0000]');
  });
});

describe('Zeiko S3 access logs (ADR-060)', () => {
  it('delivers log lines as an object in the target bucket, without raw IPs', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'web' }));
    await client.send(new CreateBucketCommand({ Bucket: 'web-logs' }));
    await client.send(
      new PutBucketLoggingCommand({
        Bucket: 'web',
        BucketLoggingStatus: {
          LoggingEnabled: { TargetBucket: 'web-logs', TargetPrefix: 'access/' },
        },
      }),
    );
    const cfg = await client.send(new GetBucketLoggingCommand({ Bucket: 'web' }));
    expect(cfg.LoggingEnabled).toEqual({ TargetBucket: 'web-logs', TargetPrefix: 'access/' });

    await client.send(put('web', 'index.html', 12));
    await client.send(new PutBucketAclCommand({ Bucket: 'web', ACL: 'public-read' }));
    // A stranger (unsigned) from an address the owner must not see.
    const anon = await rt.fetch(
      new Request(`${S3_ORIGIN}/web/index.html?x=1`, {
        headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'curl/8 "quoted"' },
      }),
    );
    expect([200, 403]).toContain(anon.status);
    await rt.settle();

    // Nothing is written into the target until the hourly delivery.
    const before = await client.send(new ListObjectsV2Command({ Bucket: 'web-logs' }));
    expect(before.KeyCount).toBe(0);
    await rt.runCron(CRON.hourly);
    await rt.settle();
    const list = await client.send(
      new ListObjectsV2Command({ Bucket: 'web-logs', Prefix: 'access/' }),
    );
    expect(list.KeyCount).toBe(1);
    const key = list.Contents![0]!.Key!;
    expect(key).toMatch(/^access\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9A-F]{16}$/);
    const text = await (
      await client.send(new GetObjectCommand({ Bucket: 'web-logs', Key: key }))
    ).Body!.transformToString();
    const lines = text.trim().split('\n');
    // PutObject, PutBucketAcl and the anonymous GET (GetBucketLogging/PutBucketLogging came first
    // or were the switch itself, which is logged once logging is on: Get is).
    expect(lines.some((l) => l.includes(' REST.PUT.OBJECT index.html '))).toBe(true);
    expect(lines.some((l) => l.includes(' REST.PUT.ACL '))).toBe(true);
    const anonLine = lines.find((l) => l.includes(' REST.GET.OBJECT index.html '))!;
    expect(anonLine).toBeDefined();
    expect(text).not.toContain('203.0.113.9');
    expect(anonLine.split(' ')[0]).toBe(user.userId);
    expect(anonLine.split(' ')[1]).toBe('web');
    expect(anonLine).toContain('"GET /web/index.html?x=1 HTTP/1.1"');
    expect(anonLine).toContain('"curl/8 _quoted_"');
    // Delivered lines are gone; the next run writes nothing new.
    await rt.runCron(CRON.hourly);
    const again = await client.send(new ListObjectsV2Command({ Bucket: 'web-logs' }));
    expect(again.KeyCount).toBe(1);
  });

  it('only logs into the same owner’s bucket, and stops when the target is deleted', async () => {
    const a = await s3Setup();
    const b = await s3Setup({ rt: a.rt, email: 'lain@zeiko.test' });
    await a.client.send(new CreateBucketCommand({ Bucket: 'a-src' }));
    await b.client.send(new CreateBucketCommand({ Bucket: 'b-logs' }));
    expect(
      await sdkError(
        a.client.send(
          new PutBucketLoggingCommand({
            Bucket: 'a-src',
            BucketLoggingStatus: { LoggingEnabled: { TargetBucket: 'b-logs', TargetPrefix: '' } },
          }),
        ),
      ),
    ).toBe('InvalidTargetBucketForLogging');
    const viaApp = await a.user.req('PUT', '/api/s3/buckets/a-src/logging', {
      target: 'b-logs',
    });
    expect(viaApp.status).toBe(400);
    // B cannot read A's settings either.
    expect(await sdkError(b.client.send(new GetBucketLoggingCommand({ Bucket: 'a-src' })))).toBe(
      'AccessDenied',
    );

    await a.client.send(new CreateBucketCommand({ Bucket: 'a-logs' }));
    const on = await a.user.req('PUT', '/api/s3/buckets/a-src/logging', {
      target: 'a-logs',
      prefix: 'x/',
    });
    expect(on.status).toBe(200);
    await a.client.send(put('a-src', 'f', 1));
    await a.rt.settle();
    // The target goes: logging turns off and nothing is delivered anywhere.
    await a.client.send(new DeleteBucketCommand({ Bucket: 'a-logs' }));
    const stats = (await (await a.user.req('GET', '/api/s3/buckets/a-src/stats')).json()) as Stats;
    expect(stats.logging).toBeNull();
    // Someone else taking the name does not receive A's logs.
    await b.client.send(new CreateBucketCommand({ Bucket: 'a-logs' }));
    await a.rt.runCron(CRON.hourly);
    const theirs = await b.client.send(new ListObjectsV2Command({ Bucket: 'a-logs' }));
    expect(theirs.KeyCount).toBe(0);
  });

  it('drops waiting lines when logging is turned off, and the counters with the bucket', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'src' }));
    await client.send(new CreateBucketCommand({ Bucket: 'logs' }));
    expect((await user.req('PUT', '/api/s3/buckets/src/logging', { target: 'logs' })).status).toBe(
      200,
    );
    await client.send(put('src', 'f', 1));
    await rt.settle();
    const waiting = () =>
      (rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_log_lines').get() as { n: number }).n;
    expect(waiting()).toBeGreaterThan(0);
    expect((await user.req('DELETE', '/api/s3/buckets/src/logging')).status).toBe(204);
    expect(waiting()).toBe(0);
    await client.send(new DeleteObjectCommand({ Bucket: 'src', Key: 'f' }));
    await client.send(new DeleteBucketCommand({ Bucket: 'src' }));
    await rt.settle();
    const days = rt.d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM s3_bucket_days WHERE bucket = 'src'`)
      .get() as { n: number };
    expect(days.n).toBe(0);
  });
});
