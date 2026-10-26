// The app's download queue (ADR-053): "download separately" fetches a few files at a time (the
// person's own number, at most 20), shows progress, pauses and resumes with Range, retries with
// backoff, waits for the network to come back, and gets a fresh signed link when one expires.
// Where the bytes go is a Sink: the browser's private storage then the Downloads folder, a folder
// the person picked, or (when neither works) the browser's own download manager.

export type DownloadStatus =
  'queued' | 'downloading' | 'paused' | 'offline' | 'saving' | 'done' | 'error' | 'canceled';

/** Where a task's bytes end up. `browser` = handed to the browser's own downloads. */
export type DownloadTarget = 'device' | 'folder' | 'browser';

export interface DownloadSource {
  /** Shown to the person; the last part of `path`. */
  name: string;
  /** Path inside the batch ("Foto/2024/a.jpg"); folders are kept when saving to a folder. */
  path: string;
  size: number;
  url: string;
  /** A fresh link when the old one expired (410/403). Null = cannot refresh. */
  refresh?: (() => Promise<string>) | null;
}

export interface DownloadTask {
  id: string;
  batchId: string;
  name: string;
  path: string;
  size: number;
  status: DownloadStatus;
  target: DownloadTarget;
  loaded: number;
  speed: number;
  error: string | null;
  errorCode: string | null;
}

export interface SinkWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** Keeps what was written (pause, network drop); the next open continues from there. */
  close(): Promise<void>;
}

export interface Sink {
  readonly target: Exclude<DownloadTarget, 'browser'>;
  /** A writer whose content is exactly the first `offset` bytes already written. */
  open(task: DownloadTask, offset: number): Promise<SinkWriter>;
  /** All bytes are in: hand the file over (Downloads folder) or just keep it (picked folder). */
  finish(task: DownloadTask): Promise<void>;
  /** Canceled: throw away what was written. */
  discard(task: DownloadTask): Promise<void>;
  /** Room for this many more bytes? False sends the task to the browser instead. */
  hasRoom?(bytes: number): Promise<boolean>;
}

/** What the queue passes to fetch (the browser adds credentials: 'omit', cache: 'no-store'). */
export interface FetchInit {
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface DownloadDeps {
  fetch: (url: string, init: FetchInit) => Promise<Response>;
  /** Hands a URL to the browser's own download (an <a download> click). */
  handOff: (url: string, name: string) => void;
  online: () => boolean;
  /** Resolves when the network is back. */
  waitOnline: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
}

export interface DownloadOptions {
  maxFiles: number;
}

const MAX_RETRIES = 5;
const MAX_REFRESHES = 2;
const EMIT_MS = 120;
const HANDOFF_GAP_MS = 400;

class Stop extends Error {}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

interface Runtime {
  controller: AbortController | null;
  paused: boolean;
  canceled: boolean;
  url: string;
  refresh: (() => Promise<string>) | null;
  samples: Array<[number, number]>;
  sink: Sink | null;
}

export class DownloadManager {
  private tasks: DownloadTask[] = [];
  private runtime = new Map<string, Runtime>();
  private listeners = new Set<() => void>();
  private snapshot: readonly DownloadTask[] = [];
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private opts: DownloadOptions,
    private deps: DownloadDeps,
  ) {}

  configure(o: Partial<DownloadOptions>): void {
    Object.assign(this.opts, o);
    this.pump();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): readonly DownloadTask[] => this.snapshot;

  private emitNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.snapshot = this.tasks.map((t) => ({ ...t }));
    for (const l of this.listeners) l();
  }

  /** Progress ticks are batched: twenty streams would otherwise re-render on every chunk. */
  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => this.emitNow(), EMIT_MS);
  }

  private patch(t: DownloadTask, p: Partial<DownloadTask>): void {
    Object.assign(t, p);
    this.emitNow();
  }

  /**
   * Queues a batch. `sink` null = every file goes to the browser's own download manager (no
   * progress, no queue); otherwise files the sink has no room for go there instead.
   */
  add(items: DownloadSource[], sink: Sink | null): string {
    const batchId = crypto.randomUUID();
    for (const it of items) {
      const task: DownloadTask = {
        id: crypto.randomUUID(),
        batchId,
        name: it.name,
        path: it.path,
        size: it.size,
        status: 'queued',
        target: sink?.target ?? 'browser',
        loaded: 0,
        speed: 0,
        error: null,
        errorCode: null,
      };
      this.tasks.push(task);
      this.runtime.set(task.id, {
        controller: null,
        paused: false,
        canceled: false,
        url: it.url,
        refresh: it.refresh ?? null,
        samples: [],
        sink,
      });
    }
    this.emitNow();
    this.pump();
    return batchId;
  }

  pause(id: string): void {
    const t = this.find(id);
    const rt = this.runtime.get(id);
    if (!t || !rt || !['queued', 'downloading', 'offline'].includes(t.status)) return;
    rt.paused = true;
    rt.controller?.abort();
    this.patch(t, { status: 'paused', speed: 0 });
    this.pump();
  }

  resume(id: string): void {
    const t = this.find(id);
    const rt = this.runtime.get(id);
    if (!t || !rt || (t.status !== 'paused' && t.status !== 'error')) return;
    rt.paused = false;
    this.patch(t, { status: 'queued', error: null, errorCode: null });
    this.pump();
  }

  cancel(id: string): void {
    const t = this.find(id);
    const rt = this.runtime.get(id);
    if (!t || !rt || t.status === 'done' || t.status === 'canceled') return;
    const wasRunning = t.status === 'downloading' || t.status === 'offline';
    rt.canceled = true;
    rt.controller?.abort();
    this.patch(t, { status: 'canceled', speed: 0 });
    // A running task discards its own bytes once its stream has stopped.
    if (!wasRunning && rt.sink) void rt.sink.discard(t).catch(() => undefined);
    this.pump();
  }

  pauseAll(): void {
    for (const t of this.tasks) this.pause(t.id);
  }

  resumeAll(): void {
    for (const t of this.tasks)
      if (t.status === 'paused' || t.status === 'error') this.resume(t.id);
  }

  cancelAll(): void {
    for (const t of this.tasks) this.cancel(t.id);
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => {
      const keep = !['done', 'canceled'].includes(t.status);
      if (!keep) this.runtime.delete(t.id);
      return keep;
    });
    this.emitNow();
  }

  /** Something still queued, running or paused (the page should not close silently). */
  busy(): boolean {
    return this.tasks.some((t) =>
      ['queued', 'downloading', 'offline', 'saving'].includes(t.status),
    );
  }

  private find(id: string): DownloadTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  private active(): number {
    return this.tasks.filter((t) => ['downloading', 'offline', 'saving'].includes(t.status)).length;
  }

  private pump(): void {
    while (this.active() < Math.max(1, this.opts.maxFiles)) {
      const next = this.tasks.find((t) => t.status === 'queued');
      if (!next) return;
      next.status = 'downloading';
      this.emitNow();
      void this.run(next);
    }
  }

  private progress(t: DownloadTask, rt: Runtime): void {
    const now = this.deps.now();
    rt.samples.push([now, t.loaded]);
    while (rt.samples.length > 2 && now - rt.samples[0]![0] > 3000) rt.samples.shift();
    const [t0, b0] = rt.samples[0]!;
    if (now - t0 > 250) t.speed = ((t.loaded - b0) * 1000) / (now - t0);
    this.emitSoon();
  }

  private stopped(rt: Runtime): boolean {
    return rt.paused || rt.canceled;
  }

  private async run(t: DownloadTask): Promise<void> {
    const rt = this.runtime.get(t.id)!;
    rt.samples = [];
    try {
      const sink = rt.sink;
      if (!sink || (t.loaded === 0 && sink.hasRoom && !(await sink.hasRoom(t.size)))) {
        // No private storage (or no room): the browser's own download takes it from here.
        t.target = 'browser';
        this.deps.handOff(rt.url, t.name);
        // Paced: browsers drop (or ask about) many downloads that start in the same instant.
        await this.deps.sleep(HANDOFF_GAP_MS);
        this.patch(t, { status: 'done', loaded: t.size, speed: 0 });
        return;
      }
      await this.fetchAll(t, rt, sink);
      if (this.stopped(rt)) throw new Stop();
      this.patch(t, { status: 'saving', speed: 0 });
      await sink.finish(t);
      this.patch(t, { status: 'done', loaded: t.size, speed: 0 });
    } catch (e) {
      if (e instanceof Stop || this.stopped(rt)) {
        if (rt.canceled && rt.sink) await rt.sink.discard(t).catch(() => undefined);
        return;
      }
      const code =
        e instanceof HttpError ? e.code : e instanceof DOMException ? e.name : 'INTERNAL';
      const message = e instanceof Error ? e.message : String(e);
      this.patch(t, { status: 'error', error: message, errorCode: code, speed: 0 });
    } finally {
      rt.controller = null;
      this.pump();
    }
  }

  /** Streams the file into the sink, resuming with Range after every interruption. */
  private async fetchAll(t: DownloadTask, rt: Runtime, sink: Sink): Promise<void> {
    let attempt = 0;
    let refreshes = 0;
    for (;;) {
      if (this.stopped(rt)) throw new Stop();
      if (!this.deps.online()) {
        this.patch(t, { status: 'offline', speed: 0 });
        await this.deps.waitOnline();
        if (this.stopped(rt)) throw new Stop();
        this.patch(t, { status: 'downloading' });
      }
      const controller = new AbortController();
      rt.controller = controller;
      let writer: SinkWriter | null = null;
      try {
        const headers: Record<string, string> = {};
        if (t.loaded > 0) headers.range = `bytes=${t.loaded}-`;
        const res = await this.deps.fetch(rt.url, { headers, signal: controller.signal });
        if ((res.status === 410 || res.status === 403) && rt.refresh && refreshes < MAX_REFRESHES) {
          // The signed link ran out (they last hours; a long queue can outlive one).
          refreshes++;
          await res.body?.cancel().catch(() => undefined);
          rt.url = await rt.refresh();
          continue;
        }
        if (res.status === 416) {
          await res.body?.cancel().catch(() => undefined);
          if (t.size > 0 && t.loaded >= t.size) return; // already complete
          t.loaded = 0;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new HttpError(res.status, res.status === 404 ? 'NOT_FOUND' : `HTTP_${res.status}`);
        }
        // The server ignored Range: start over rather than glue two different starts together.
        if (t.loaded > 0 && res.status !== 206) t.loaded = 0;
        if (res.status === 206) {
          const start = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
          if (!start || Number(start[1]) !== t.loaded) {
            await res.body?.cancel().catch(() => undefined);
            t.loaded = 0;
            continue;
          }
        }
        writer = await sink.open(t, t.loaded);
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            t.loaded += value.length;
            attempt = 0;
            this.progress(t, rt);
          }
        }
        await writer.close();
        writer = null;
        if (t.size > 0 && t.loaded !== t.size) {
          // A cut-off stream that still ended "cleanly": fetch the rest.
          if (t.loaded > t.size) t.loaded = 0;
          throw new HttpError(0, 'INCOMPLETE');
        }
        return;
      } catch (e) {
        if (writer) await writer.close().catch(() => undefined);
        if (this.stopped(rt)) throw new Stop();
        const retryable =
          !(e instanceof HttpError) ||
          e.status === 0 ||
          e.status === 408 ||
          e.status === 429 ||
          e.status >= 500;
        // Storage errors (quota, permission) will not fix themselves.
        if (e instanceof DOMException && e.name !== 'AbortError' && e.name !== 'NetworkError')
          throw e;
        if (!retryable) throw e;
        if (!this.deps.online()) continue; // wait for the network without using up attempts
        if (attempt >= MAX_RETRIES) throw e instanceof HttpError ? e : new HttpError(0, 'NETWORK');
        await this.deps.sleep(Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.deps.random()));
        attempt++;
      } finally {
        rt.controller = null;
      }
    }
  }
}
