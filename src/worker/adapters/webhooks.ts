// A6 (ADR-094): how webhooks leave the Worker. Names are resolved over DNS-over-HTTPS first (so an
// address can be checked for being private), and a delivery is one POST that never follows a
// redirect. The mock keeps what was sent, for tests and the dev server.
export interface WebhookTransport {
  /** The addresses a host name has (A and AAAA); [] when it has none. */
  resolve(host: string): Promise<string[]>;
  /** One delivery. Throws on a network error or timeout. */
  send(url: string, body: string, headers: Record<string, string>): Promise<{ status: number }>;
}

const DOH = 'https://cloudflare-dns.com/dns-query';

export class HttpWebhookTransport implements WebhookTransport {
  async resolve(host: string): Promise<string[]> {
    const out: string[] = [];
    for (const type of ['A', 'AAAA']) {
      const res = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`dns ${res.status}`);
      const j = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
    }
    return out;
  }

  async send(url: string, body: string, headers: Record<string, string>) {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Only the status matters; the body is never read.
    await res.body?.cancel();
    return { status: res.status };
  }
}

export interface SentWebhook {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** Tests and dev: nothing leaves; answers come from `answer`, names from `dns`. */
export class MockWebhookTransport implements WebhookTransport {
  static sent: SentWebhook[] = [];
  static dns: Record<string, string[]> = {};
  /** A status, or an Error to throw, for each delivery (default 200). */
  static answer: (url: string) => number | Error = () => 200;

  static reset(): void {
    MockWebhookTransport.sent = [];
    MockWebhookTransport.dns = {};
    MockWebhookTransport.answer = () => 200;
  }

  resolve(host: string): Promise<string[]> {
    const known = MockWebhookTransport.dns[host];
    if (known) return Promise.resolve(known);
    return Promise.resolve(
      /(^|\.)(localhost|internal|local)$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34'],
    );
  }

  send(url: string, body: string, headers: Record<string, string>) {
    MockWebhookTransport.sent.push({ url, body, headers });
    const a = MockWebhookTransport.answer(url);
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({ status: a });
  }
}
