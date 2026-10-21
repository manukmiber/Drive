// Queue shim. `auto` mode delivers messages asynchronously (dev server); `manual` mode keeps them
// until drain() so tests are deterministic. Retries follow max_retries, then go to `dead`.
export interface ShimMessage<T> {
  id: string;
  timestamp: Date;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ShimBatch<T> {
  queue: string;
  messages: ShimMessage<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

type Consumer<T> = (batch: ShimBatch<T>) => Promise<void>;

interface Pending<T> {
  id: string;
  body: T;
  attempts: number;
  readyAt: number;
  timestamp: Date;
}

export class ShimQueue<T = unknown> {
  private pending: Pending<T>[] = [];
  readonly dead: Pending<T>[] = [];
  readonly sent: T[] = [];
  private consumer: Consumer<T> | null = null;
  private inflight = new Set<Promise<void>>();

  constructor(
    readonly name: string,
    private opts: { mode: 'auto' | 'manual'; maxRetries: number; maxBatchSize: number },
  ) {}

  setConsumer(consumer: Consumer<T>): void {
    this.consumer = consumer;
  }

  async send(body: T, options?: { delaySeconds?: number }): Promise<void> {
    const item: Pending<T> = {
      id: crypto.randomUUID(),
      body: structuredClone(body),
      attempts: 1,
      readyAt: Date.now() + (options?.delaySeconds ?? 0) * 1000,
      timestamp: new Date(),
    };
    this.sent.push(item.body);
    this.pending.push(item);
    if (this.opts.mode === 'auto') this.schedule(item);
  }

  async sendBatch(messages: Iterable<{ body: T; delaySeconds?: number }>): Promise<void> {
    for (const m of messages) await this.send(m.body, { delaySeconds: m.delaySeconds ?? 0 });
  }

  private schedule(item: Pending<T>): void {
    const delay = Math.max(0, item.readyAt - Date.now());
    setTimeout(() => {
      const i = this.pending.indexOf(item);
      if (i === -1) return;
      this.pending.splice(i, 1);
      const p = this.deliver([item]).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, delay);
  }

  private async deliver(items: Pending<T>[]): Promise<void> {
    if (!this.consumer) throw new Error(`queue ${this.name} has no consumer`);
    const outcome = new Map<string, { kind: 'ack' } | { kind: 'retry'; delay: number }>();
    const messages: ShimMessage<T>[] = items.map((it) => ({
      id: it.id,
      timestamp: it.timestamp,
      body: it.body,
      attempts: it.attempts,
      ack: () => void outcome.set(it.id, { kind: 'ack' }),
      retry: (o) => void outcome.set(it.id, { kind: 'retry', delay: o?.delaySeconds ?? 0 }),
    }));
    let threw = false;
    try {
      await this.consumer({
        queue: this.name,
        messages,
        ackAll: () => items.forEach((it) => outcome.set(it.id, { kind: 'ack' })),
        retryAll: (o) =>
          items.forEach((it) => outcome.set(it.id, { kind: 'retry', delay: o?.delaySeconds ?? 0 })),
      });
    } catch (e) {
      threw = true;
      console.error(`[queue:${this.name}] consumer threw`, e);
    }
    for (const it of items) {
      const o =
        outcome.get(it.id) ??
        (threw ? { kind: 'retry' as const, delay: 0 } : { kind: 'ack' as const });
      if (o.kind === 'ack') continue;
      if (it.attempts > this.opts.maxRetries) {
        this.dead.push(it);
        console.error(
          `[queue:${this.name}] message ${it.id} dead-lettered after ${it.attempts} attempts`,
        );
        continue;
      }
      const next = { ...it, attempts: it.attempts + 1, readyAt: Date.now() + o.delay * 1000 };
      this.pending.push(next);
      if (this.opts.mode === 'auto') this.schedule(next);
    }
  }

  /** Manual mode: deliver everything (ignoring delays) until the queue is empty. */
  async drain(maxRounds = 50): Promise<number> {
    let delivered = 0;
    for (let round = 0; round < maxRounds && (this.pending.length || this.inflight.size); round++) {
      await Promise.all([...this.inflight]);
      while (this.pending.length) {
        const batch = this.pending.splice(0, this.opts.maxBatchSize);
        delivered += batch.length;
        await this.deliver(batch);
      }
    }
    return delivered;
  }

  get size(): number {
    return this.pending.length;
  }
}
