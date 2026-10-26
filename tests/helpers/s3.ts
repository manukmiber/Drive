// Zeiko S3 test helpers (ADR-044): the real AWS SDK v3 client, wired to the in-memory Worker.
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import type { DevRuntime } from '../../dev/env';
import { makeRuntime } from './runtime';
import { OPS_KEY, opsCall } from './ops';
import { signIn, type Session } from './session';

export { OPS_KEY, opsCall };

export const S3_ORIGIN = 'https://s3.zeiko.test';

interface SdkRequest {
  method: string;
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
}

function queryString(q: SdkRequest['query']): string {
  const esc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v === null) parts.push(esc(k));
    else for (const one of Array.isArray(v) ? v : [v]) parts.push(`${esc(k)}=${esc(one)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** A request handler for the SDK that calls the Worker in-process instead of the network. */
export class RuntimeHandler {
  readonly metadata = { handlerProtocol: 'http/1.1' };
  /** Every request the SDK sent (for asserting on the wire format). */
  readonly sent: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  constructor(private rt: DevRuntime) {}

  async handle(req: SdkRequest) {
    const url = `${req.protocol}//${req.hostname}${req.port ? `:${req.port}` : ''}${req.path}${queryString(req.query)}`;
    this.sent.push({ method: req.method, url, headers: { ...req.headers } });
    let body: BodyInit | null = null;
    const b = req.body;
    if (b instanceof Readable) body = Readable.toWeb(b) as unknown as ReadableStream;
    else if (typeof b === 'string' || b instanceof Uint8Array) body = b as BodyInit;
    else if (b && typeof (b as ReadableStream).getReader === 'function') body = b as ReadableStream;
    const res = await this.rt.fetch(
      new Request(url, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      } as RequestInit),
    );
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return {
      response: {
        statusCode: res.status,
        reason: res.statusText,
        headers,
        body: res.body ? Readable.fromWeb(res.body as never) : Readable.from([]),
      },
    };
  }
  updateHttpClientConfig() {}
  httpHandlerConfigs() {
    return {};
  }
}

export function s3Client(
  rt: DevRuntime,
  key: { id: string; secret: string },
  handler = new RuntimeHandler(rt),
): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: S3_ORIGIN,
    forcePathStyle: true,
    credentials: { accessKeyId: key.id, secretAccessKey: key.secret },
    requestHandler: handler as never,
    maxAttempts: 1,
  });
}


export interface S3Setup {
  rt: DevRuntime;
  user: Session;
  key: { id: string; secret: string };
  client: S3Client;
  handler: RuntimeHandler;
  ops: ReturnType<typeof opsCall>;
}

/** A Drive user the operator gave Zeiko S3 (`limitBytes`), with one access key and a client. */
export async function s3Setup(
  opts: { limitBytes?: number; email?: string; rt?: DevRuntime; extraD1?: string[] } = {},
): Promise<S3Setup> {
  const rt =
    opts.rt ??
    (await makeRuntime({
      vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN },
      ...(opts.extraD1 ? { extraD1: opts.extraD1 } : {}),
    }));
  const user = await signIn(rt, opts.email ?? 'penyimpan@zeiko.test');
  const ops = opsCall(rt);
  const enabled = await ops('POST', '/s3/accounts', {
    userId: user.userId,
    limitBytes: opts.limitBytes ?? 1024 ** 3,
    reason: 'test account',
  });
  if (enabled.status !== 200) throw new Error(`enable: ${enabled.status} ${await enabled.text()}`);
  const created = await user.req('POST', '/api/s3/keys', { label: 'laptop' });
  if (created.status !== 201) throw new Error(`key: ${created.status} ${await created.text()}`);
  const key = ((await created.json()) as { key: { id: string; secret: string } }).key;
  const handler = new RuntimeHandler(rt);
  return { rt, user, key, client: s3Client(rt, key, handler), handler, ops };
}

export function usage(rt: DevRuntime, userId: string) {
  return rt.d1.sqlite
    .prepare(
      'SELECT used_bytes AS used, reserved_bytes AS reserved FROM s3_accounts WHERE user_id = ?',
    )
    .get(userId) as { used: number; reserved: number };
}
