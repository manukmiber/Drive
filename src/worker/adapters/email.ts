// EmailSender adapter (SPEC §6.5, ADR-013). `cloudflare` uses the send_email binding builder API;
// `mock` records messages in KV so the dev mailbox (/__dev/mail) can show them.
export interface OutboundEmail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Free-form tag for logs/metrics, e.g. "otp", "share", "invoice". */
  tag: string;
}

export interface EmailSender {
  readonly name: string;
  send(msg: OutboundEmail): Promise<{ id: string }>;
}

export class CloudflareEmailSender implements EmailSender {
  readonly name = 'cloudflare';
  constructor(
    private binding: SendEmail,
    private from: string,
  ) {}
  async send(msg: OutboundEmail): Promise<{ id: string }> {
    const res = await this.binding.send({
      from: { email: this.from, name: 'Zeiko' },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
    });
    return { id: res.messageId };
  }
}

export const DEV_MAIL_PREFIX = 'dev:mail:';

export class MockEmailSender implements EmailSender {
  readonly name = 'mock';
  constructor(
    private kv: KVNamespace,
    private from: string,
  ) {}
  async send(msg: OutboundEmail): Promise<{ id: string }> {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const record = { id, from: this.from, sentAt: Date.now(), ...msg };
    await this.kv.put(`${DEV_MAIL_PREFIX}${id}`, JSON.stringify(record), { expirationTtl: 86_400 });
    console.log(`[mock-email] to=${msg.to.join(',')} subject="${msg.subject}"\n${msg.text}`);
    return { id };
  }
}
