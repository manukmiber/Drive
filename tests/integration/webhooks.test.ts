// A6 (ADR-094): webhooks for Drive and Zeiko S3: where they may point (no SSRF), signed deliveries,
// retries with backoff, turning off an endpoint that keeps failing, and events only from the
// person's own files and buckets.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutBucketNotificationConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockWebhookTransport } from '../../src/worker/adapters/webhooks';
import { hmacSha256, toHex } from '../../src/worker/lib/crypto';
import { isPrivateAddress, webhookBackoff } from '../../src/worker/services/webhooks';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { s3Setup } from '../helpers/s3';
import { signIn, type Session } from '../helpers/session';

interface Created {
  webhook: { id: string; enabled: boolean };
  secret: string;
}

async function hook(s: Session, body: Record<string, unknown>): Promise<Response> {
  return s.req('POST', '/api/webhooks', body);
}

async function setup() {
  const rt = await makeRuntime();
  const s = await signIn(rt, 'pengembang@example.com');
  await grantPlan(rt, s.userId);
  return { rt, s, root: await rootOf(s) };
}

const sentTo = (url: string) => MockWebhookTransport.sent.filter((x) => x.url === url);

beforeEach(() => MockWebhookTransport.reset());

describe('Webhooks (A6, ADR-094)', () => {
  it('refuses endpoints that are not public https (SSRF)', async () => {
    const { s } = await setup();
    MockWebhookTransport.dns['rebind.example.com'] = ['10.1.2.3'];
    MockWebhookTransport.dns['v6.example.com'] = ['2606:4700::1111', 'fd00::1'];
    for (const url of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.8/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://hooks.example.com:8443/x',
      'https://user:pass@hooks.example.com/x',
      'https://printer.internal/x',
      'https://rebind.example.com/x',
      'https://v6.example.com/x',
      'https://intranet/x',
    ]) {
      const res = await hook(s, { url, events: ['drive.file.uploaded'] });
      expect(res.status, url).toBe(400);
    }
    expect((await hook(s, { url: 'https://hooks.example.com/zeiko', events: [] })).status).toBe(
      201,
    );
    for (const [ip, priv] of [
      ['8.8.8.8', false],
      ['100.64.1.1', true],
      ['192.168.1.1', true],
      ['::ffff:127.0.0.1', true],
      ['64:ff9b::10.0.0.1', true],
      ['fe80::1', true],
      ['ff02::1', true],
      ['2606:4700::1111', false],
    ] as const)
      expect(isPrivateAddress(ip), ip).toBe(priv);
  });

  it('sends Drive events signed with the endpoint secret, only for the person’s own files', async () => {
    const { rt, s, root } = await setup();
    const res = await hook(s, {
      url: 'https://hooks.example.com/drive',
      events: ['drive.file.uploaded', 'drive.item.trashed'],
    });
    const { webhook, secret } = (await res.json()) as Created;
    expect(secret).toMatch(/^whsec_/);
    const file = await uploadText(s, root, 'laporan.txt', 'isi rahasia');
    await rt.settle();
    // Someone else's upload is none of this endpoint's business.
    const other = await signIn(rt, 'orang-lain@example.com');
    await grantPlan(rt, other.userId);
    await uploadText(other, await rootOf(other), 'punyanya.txt', 'x');
    await rt.settle();
    const sent = sentTo('https://hooks.example.com/drive');
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    const body = JSON.parse(msg.body) as {
      events: Array<{ type: string; item: { id: string; name: string } }>;
    };
    expect(body.events.map((e) => [e.type, e.item.id, e.item.name])).toEqual([
      ['drive.file.uploaded', file.id, 'laporan.txt'],
    ]);
    // Metadata only: no contents, no download link.
    expect(msg.body).not.toContain('isi rahasia');
    expect(msg.body).not.toMatch(/https?:\/\//);
    // The signature a receiver checks.
    const ts = msg.headers['zeiko-timestamp']!;
    expect(msg.headers['zeiko-signature']).toBe(
      `v1=${toHex(await hmacSha256(secret, `${ts}.${msg.body}`))}`,
    );
    expect(msg.headers['zeiko-webhook-id']).toBe(webhook.id);
    expect(msg.headers['zeiko-event']).toBe('drive.file.uploaded');
    // Trash: one more delivery; the log shows both as delivered.
    expect((await s.req('POST', '/api/nodes/trash', { ids: [file.id] })).status).toBe(200);
    await rt.settle();
    expect(sentTo('https://hooks.example.com/drive')).toHaveLength(2);
    const log = (await (await s.req('GET', '/api/webhooks/deliveries')).json()) as {
      items: Array<{ event: string; status: string; responseStatus: number }>;
    };
    expect(log.items.map((d) => [d.event, d.status, d.responseStatus])).toEqual([
      ['drive.item.trashed', 'ok', 200],
      ['drive.file.uploaded', 'ok', 200],
    ]);
    // Other people never see this endpoint or its log.
    expect((await (await other.req('GET', '/api/webhooks')).json()) as unknown).toMatchObject({
      items: [],
    });
    expect(
      (await other.req('PATCH', `/api/webhooks/${webhook.id}`, { enabled: false })).status,
    ).toBe(404);
    expect((await other.req('DELETE', `/api/webhooks/${webhook.id}`)).status).toBe(404);
  });

  it('retries with backoff, then turns off an endpoint that keeps failing', async () => {
    const { rt, s, root } = await setup();
    expect(webhookBackoff(1)).toBe(30);
    expect(webhookBackoff(2)).toBe(120);
    const { webhook } = (await (
      await hook(s, { url: 'https://down.example.com/x', events: ['drive.file.uploaded'] })
    ).json()) as Created;
    // A failure, then success: delivered on the second try.
    let n = 0;
    MockWebhookTransport.answer = () => (++n === 1 ? 503 : 200);
    await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    const delayed = rt.queues.NOTIFY_QUEUE.sent.filter(
      (m) =>
        (m as { type: string; attempt?: number }).type === 'webhook' &&
        (m as { attempt: number }).attempt === 1,
    );
    expect(delayed).toHaveLength(1);
    let log = (await (await s.req('GET', '/api/webhooks/deliveries')).json()) as {
      items: Array<{ status: string; attempts: number }>;
    };
    expect(log.items[0]).toMatchObject({ status: 'ok', attempts: 2 });
    // Now it always fails: each delivery gives up after its tries, and after enough of them the
    // endpoint is off and its owner is told.
    MockWebhookTransport.answer = () => new Error('connection refused');
    for (let i = 0; i < 5; i++) {
      await uploadText(s, root, `gagal-${i}.txt`, 'x');
      await rt.settle();
    }
    log = (await (await s.req('GET', '/api/webhooks/deliveries')).json()) as typeof log;
    expect(log.items[0]).toMatchObject({ status: 'failed', attempts: 6 });
    const list = (await (await s.req('GET', '/api/webhooks')).json()) as {
      items: Array<{ id: string; enabled: boolean; disabledReason: string }>;
    };
    expect(list.items[0]).toMatchObject({
      id: webhook.id,
      enabled: false,
      disabledReason: 'failing',
    });
    const notices = rt.queues.NOTIFY_QUEUE.sent.filter(
      (m) => (m as { type: string; kind?: string }).kind === 'webhook_disabled',
    );
    expect(notices).toHaveLength(1);
    // Off means nothing more is sent, until it is turned on again.
    const before = MockWebhookTransport.sent.length;
    await uploadText(s, root, 'diam.txt', 'x');
    await rt.settle();
    expect(MockWebhookTransport.sent.length).toBe(before);
    MockWebhookTransport.answer = () => 200;
    expect((await s.req('PATCH', `/api/webhooks/${webhook.id}`, { enabled: true })).status).toBe(
      200,
    );
    expect((await s.req('POST', `/api/webhooks/${webhook.id}/test`)).status).toBe(202);
    await rt.settle();
    expect(JSON.parse(MockWebhookTransport.sent.at(-1)!.body)).toMatchObject({
      events: [{ type: 'webhook.test' }],
    });
  });

  it('sends S3 events from a bucket notification configuration, filtered, to the owner only', async () => {
    const s = await s3Setup();
    const created = (await (
      await s.user.req('POST', '/api/webhooks', { url: 'https://hooks.example.com/s3', events: [] })
    ).json()) as Created;
    await s.client.send(new CreateBucketCommand({ Bucket: 'foto' }));
    await s.client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: 'foto',
        NotificationConfiguration: {
          TopicConfigurations: [
            {
              Id: 'jpg-masuk',
              TopicArn: `arn:zeiko:webhook:::${created.webhook.id}`,
              Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
              Filter: {
                Key: {
                  FilterRules: [
                    { Name: 'prefix', Value: 'img/' },
                    { Name: 'suffix', Value: '.jpg' },
                  ],
                },
              },
            },
          ],
        },
      }),
    );
    const got = await s.client.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: 'foto' }),
    );
    expect(got.TopicConfigurations?.[0]).toMatchObject({
      Id: 'jpg-masuk',
      TopicArn: `arn:zeiko:webhook:::${created.webhook.id}`,
    });
    for (const Key of ['img/a.jpg', 'img/b.png', 'lain/c.jpg'])
      await s.client.send(new PutObjectCommand({ Bucket: 'foto', Key, Body: 'x' }));
    await s.client.send(new DeleteObjectCommand({ Bucket: 'foto', Key: 'img/a.jpg' }));
    await s.rt.settle();
    const records = sentTo('https://hooks.example.com/s3').flatMap(
      (m) =>
        (
          JSON.parse(m.body) as {
            Records: Array<{ eventName: string; s3: { object: { key: string } } }>;
          }
        ).Records,
    );
    expect(records.map((r) => [r.eventName, r.s3.object.key])).toEqual([
      ['ObjectCreated:Put', 'img/a.jpg'],
      ['ObjectRemoved:Delete', 'img/a.jpg'],
    ]);
    // Someone else's webhook can't be a destination.
    const other = await signIn(s.rt, 'lain@example.com');
    const theirs = (await (
      await other.req('POST', '/api/webhooks', {
        url: 'https://hooks.example.com/lain',
        events: [],
      })
    ).json()) as Created;
    await expect(
      s.client.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: 'foto',
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                QueueArn: `arn:zeiko:webhook:::${theirs.webhook.id}`,
                Events: ['s3:ObjectCreated:*'],
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'InvalidArgument' });
  });
});
