// A big file from the /s3 page, in parts through the app (S4, ADR-075): several parts at once (the
// device's own setting, ADR-053), each tried again after a network error or a busy server, pause and
// resume (the stored parts are asked for again, so a reload of the list is the source of truth), and
// cancel (the upload is aborted, so its reserved storage comes back).
import { api, ApiError, postJson, sendJson } from './api';
import { transfer } from './transfer';
import { putWithProgress, type PutHandle } from '../upload/xhr';

export type S3UploadState = 'running' | 'paused' | 'failed' | 'done' | 'cancelled';

export interface S3UploadEvents {
  progress(loaded: number): void;
  state(state: S3UploadState, error?: unknown): void;
}

/** Waits before each retry of a part (ms). */
export const RETRY_WAITS = [1000, 2000, 4000, 8000, 16000];

/** Network trouble, a busy server, or a lost race: worth sending the part again. */
export function retryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.code === 'NETWORK' || e.status === 0 || e.status === 429 || e.status >= 500;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class S3MultipartUpload {
  private uploadId: string | null = null;
  private partSize = 0;
  private parts = 0;
  private readonly done = new Map<number, string>();
  private readonly inflight = new Map<number, { handle: PutHandle; loaded: number }>();
  private status: S3UploadState = 'running';
  /** Bumped on pause/cancel so a run that was stopped doesn't carry on. */
  private run = 0;

  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly file: File,
    private readonly on: S3UploadEvents,
  ) {}

  get state(): S3UploadState {
    return this.status;
  }

  private set(state: S3UploadState, error?: unknown): void {
    this.status = state;
    this.on.state(state, error);
  }

  private url(path = ''): string {
    return `${this.base}/uploads${this.uploadId ? `/${encodeURIComponent(this.uploadId)}` : ''}${path}`;
  }

  private sizeOf(n: number): number {
    return n < this.parts ? this.partSize : this.file.size - this.partSize * (this.parts - 1);
  }

  private report(): void {
    let loaded = 0;
    for (const n of this.done.keys()) loaded += this.sizeOf(n);
    for (const p of this.inflight.values()) loaded += p.loaded;
    this.on.progress(Math.min(loaded, this.file.size));
  }

  /** Starts, or carries on after pause() or a failure. Resolves when this run stops. */
  async start(): Promise<void> {
    const run = ++this.run;
    this.set('running');
    try {
      if (!this.uploadId) {
        const r = await postJson<{ uploadId: string; partSize: number; parts: number }>(
          `${this.base}/uploads`,
          { key: this.key, size: this.file.size, contentType: this.file.type || null },
        );
        this.uploadId = r.uploadId;
        this.partSize = r.partSize;
        this.parts = r.parts;
      } else {
        // What the server holds is what counts (a part may have landed after its request broke).
        const q = new URLSearchParams({ key: this.key });
        const { parts } = await api<{
          parts: Array<{ partNumber: number; etag: string; size: number }>;
        }>(this.url(`?${q}`));
        this.done.clear();
        for (const p of parts)
          if (p.size === this.sizeOf(p.partNumber)) this.done.set(p.partNumber, p.etag);
      }
      if (run !== this.run) return;
      this.report();
      const queue: number[] = [];
      for (let n = 1; n <= this.parts; n++) if (!this.done.has(n)) queue.push(n);
      const worker = async () => {
        for (let n = queue.shift(); n !== undefined && run === this.run; n = queue.shift())
          await this.sendPart(n, run);
      };
      const width = Math.max(1, Math.min(transfer.get().uploadParts, queue.length));
      await Promise.all(Array.from({ length: width }, worker));
      if (run !== this.run) return;
      const parts = [...this.done]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, etag]) => ({ partNumber, etag }));
      await postJson(this.url('/complete'), { key: this.key, parts });
      if (run !== this.run) return;
      this.on.progress(this.file.size);
      this.set('done');
    } catch (e) {
      if (run !== this.run) return;
      this.run++;
      for (const p of this.inflight.values()) p.handle.abort();
      this.inflight.clear();
      this.report();
      this.set('failed', e);
    }
  }

  private async sendPart(n: number, run: number): Promise<void> {
    const from = (n - 1) * this.partSize;
    const body = this.file.slice(from, from + this.sizeOf(n));
    const q = new URLSearchParams({ key: this.key });
    for (let attempt = 0; ; attempt++) {
      const handle = putWithProgress(this.url(`/parts/${n}?${q}`), body, (loaded) => {
        const p = this.inflight.get(n);
        if (p) p.loaded = loaded;
        this.report();
      });
      this.inflight.set(n, { handle, loaded: 0 });
      try {
        const { etag } = (await handle.promise) as { etag: string };
        this.inflight.delete(n);
        this.done.set(n, etag);
        this.report();
        return;
      } catch (e) {
        this.inflight.delete(n);
        this.report();
        if (run !== this.run) return;
        if (!retryable(e) || attempt >= RETRY_WAITS.length) throw e;
        await sleep(RETRY_WAITS[attempt]!);
        if (run !== this.run) return;
      }
    }
  }

  /** Stops sending; parts already stored stay, and start() carries on from them. */
  pause(): void {
    if (this.status !== 'running') return;
    this.run++;
    for (const p of this.inflight.values()) p.handle.abort();
    this.inflight.clear();
    this.report();
    this.set('paused');
  }

  /** Stops and throws the stored parts away (the reserved storage comes back). */
  async cancel(): Promise<void> {
    this.run++;
    for (const p of this.inflight.values()) p.handle.abort();
    this.inflight.clear();
    this.set('cancelled');
    if (!this.uploadId) return;
    const q = new URLSearchParams({ key: this.key });
    await sendJson('DELETE', this.url(`?${q}`)).catch(() => undefined);
  }
}
