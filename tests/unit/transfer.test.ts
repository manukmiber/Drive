// The device's transfer settings and the app's download queue (ADR-053).
import { describe, expect, it } from 'vitest';
import {
  DownloadManager,
  type DownloadDeps,
  type DownloadSource,
  type DownloadTask,
  type Sink,
} from '../../src/web/download/manager';
import { numbered, safeParts } from '../../src/web/download/names';
import {
  clampSettings,
  FALLBACK_LIMITS,
  limitsFrom,
  presetOf,
  presetValues,
  suggestPreset,
} from '../../src/web/lib/transfer-rules';

describe('transfer settings', () => {
  it('never goes past 20 files each way, even when config says more', () => {
    const l = limitsFrom({
      upload_parallel_files_cap: 50,
      download_parallel_files_cap: 99,
      upload_part_concurrency_cap: 8,
      upload_max_parallel_files: 3,
      upload_part_concurrency: 4,
      download_max_parallel_files: 3,
    });
    expect(l.uploadFilesMax).toBe(20);
    expect(l.downloadFilesMax).toBe(20);
    const s = clampSettings({ uploadFiles: 40, downloadFiles: 21, uploadParts: 100 }, l);
    expect(s).toMatchObject({ uploadFiles: 20, downloadFiles: 20, uploadParts: 8 });
    expect(clampSettings({ uploadFiles: 0, downloadFiles: -3 }, l)).toMatchObject({
      uploadFiles: 1,
      downloadFiles: 1,
    });
  });

  it('follows a lower ceiling from config, and falls back to the defaults', () => {
    const l = limitsFrom({ upload_parallel_files_cap: 5, download_parallel_files_cap: 4 });
    expect(clampSettings({ uploadFiles: 12, downloadFiles: 12 }, l)).toMatchObject({
      uploadFiles: 5,
      downloadFiles: 4,
    });
    expect(clampSettings(null, FALLBACK_LIMITS)).toEqual({
      uploadFiles: 3,
      uploadParts: 4,
      downloadFiles: 3,
      keepAwake: true,
    });
    expect(clampSettings({ uploadFiles: Number.NaN }, FALLBACK_LIMITS).uploadFiles).toBe(3);
  });

  it('has presets within the limits, and recognises them', () => {
    const l = limitsFrom({ upload_parallel_files_cap: 6 });
    expect(presetValues('max', l)).toEqual({ uploadFiles: 6, uploadParts: 8, downloadFiles: 20 });
    expect(presetValues('fast', l).uploadFiles).toBe(6);
    const s = clampSettings({ ...presetValues('saver', l), keepAwake: true }, l);
    expect(presetOf(s, l)).toBe('saver');
    expect(presetOf({ ...s, downloadFiles: 7 }, l)).toBeNull();
  });

  it('suggests from what the browser knows of the connection', () => {
    expect(suggestPreset(null)).toBeNull();
    expect(suggestPreset({ saveData: true, downlink: 10 })).toBe('saver');
    expect(suggestPreset({ effectiveType: '2g' })).toBe('saver');
    expect(suggestPreset({ effectiveType: '3g', downlink: 9 })).toBe('normal');
    expect(suggestPreset({ effectiveType: '4g', downlink: 1 })).toBe('saver');
    expect(suggestPreset({ effectiveType: '4g', downlink: 3 })).toBe('normal');
    expect(suggestPreset({ effectiveType: '4g', downlink: 10 })).toBe('fast');
  });
});

describe('folder names for "save to a folder"', () => {
  it('drops tricks and characters desktops refuse', () => {
    expect(safeParts('../a/./b:c/d?.txt')).toEqual(['a', 'b_c', 'd_.txt']);
    expect(safeParts('Foto/trailing. ')).toEqual(['Foto', 'trailing']);
    expect(numbered('a.jpg', 2)).toBe('a (2).jpg');
    expect(numbered('README', 1)).toBe('README (1)');
    expect(numbered('.env', 1)).toBe('.env (1)');
  });
});

// ── the download queue, over a fake network and an in-memory sink ──

class MemorySink implements Sink {
  readonly target = 'device' as const;
  files = new Map<string, number[]>();
  finished: string[] = [];
  discarded: string[] = [];
  room = true;
  async open(task: DownloadTask, offset: number) {
    const cur = (this.files.get(task.id) ?? []).slice(0, offset);
    expect(cur.length).toBe(offset);
    this.files.set(task.id, cur);
    return {
      write: async (c: Uint8Array) => {
        cur.push(...c);
      },
      close: async () => undefined,
    };
  }
  async finish(task: DownloadTask) {
    this.finished.push(task.path);
  }
  async discard(task: DownloadTask) {
    this.discarded.push(task.path);
    this.files.delete(task.id);
  }
  async hasRoom() {
    return this.room;
  }
  text(task: DownloadTask) {
    return new TextDecoder().decode(new Uint8Array(this.files.get(task.id) ?? []));
  }
}

interface Served {
  body: string;
  /** Answer status for the next requests (one per entry), before serving normally. */
  answers?: number[];
  /** Cut the stream after this many bytes, once. */
  cutAt?: number;
  /** Ignore Range (answer 200 with everything). */
  noRange?: boolean;
}

function fakeNet(files: Record<string, Served>) {
  let inFlight = 0;
  let maxInFlight = 0;
  const requests: Array<{ url: string; range: string | null }> = [];
  const gates: Array<() => void> = [];
  let hold = false;
  let online = true;
  let onlineWaiters: Array<() => void> = [];
  const deps: DownloadDeps = {
    async fetch(url, init) {
      const range = (init.headers as Record<string, string>).range ?? null;
      requests.push({ url, range });
      const f = files[url];
      if (!f) return new Response('gone', { status: 404 });
      const status = f.answers?.shift();
      if (status) return new Response('x', { status });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (hold)
        await new Promise<void>((resolve, reject) => {
          gates.push(resolve);
          init.signal?.addEventListener('abort', () => {
            inFlight--;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      const bytes = new TextEncoder().encode(f.body);
      const start = range && !f.noRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const part = bytes.subarray(start);
      const cut = f.cutAt;
      f.cutAt = undefined;
      const signal = init.signal;
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          // First pull: the bytes (up to the cut); second: the end, or the network dropping.
          if (pulls++ === 0) c.enqueue(cut !== undefined ? part.subarray(0, cut) : part);
          else if (cut !== undefined) c.error(new TypeError('network error'));
          else c.close();
        },
        start(c) {
          signal?.addEventListener('abort', () => {
            try {
              c.error(new DOMException('aborted', 'AbortError'));
            } catch {
              // already closed
            }
          });
        },
      });
      const done = () => inFlight--;
      const res = new Response(
        stream.pipeThrough(new TransformStream({ flush: () => void done() })),
        {
          status: start > 0 ? 206 : 200,
          headers:
            start > 0
              ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }
              : {},
        },
      );
      if (cut !== undefined) setTimeout(done, 0);
      return res;
    },
    handOff: () => undefined,
    online: () => online,
    waitOnline: () => new Promise<void>((r) => (online ? r() : onlineWaiters.push(r))),
    sleep: async () => undefined,
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
    random: () => 0.5,
  };
  return {
    deps,
    requests,
    maxInFlight: () => maxInFlight,
    hold(on: boolean) {
      hold = on;
      if (!on) for (const g of gates.splice(0)) g();
    },
    release(n = 1) {
      for (const g of gates.splice(0, n)) g();
    },
    setOnline(v: boolean) {
      online = v;
      if (v) {
        for (const w of onlineWaiters) w();
        onlineWaiters = [];
      }
    },
  };
}

const src = (name: string, size: number, extra: Partial<DownloadSource> = {}): DownloadSource => ({
  name,
  path: name,
  size,
  url: `/d/${name}`,
  ...extra,
});

async function settle(m: DownloadManager, until: (t: readonly DownloadTask[]) => boolean) {
  for (let i = 0; i < 400; i++) {
    const tasks = (m as unknown as { tasks: DownloadTask[] }).tasks;
    if (until(tasks)) return tasks;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('queue did not settle');
}
const allDone = (t: readonly DownloadTask[]) =>
  t.every((x) => ['done', 'error', 'canceled', 'paused'].includes(x.status));

describe('download queue (ADR-053)', () => {
  it('runs at most N files at once and follows a new N right away', async () => {
    const files: Record<string, Served> = {};
    for (let i = 0; i < 8; i++) files[`/d/f${i}`] = { body: `file-${i}` };
    const net = fakeNet(files);
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 2 }, net.deps);
    net.hold(true);
    m.add(
      Array.from({ length: 8 }, (_, i) => src(`f${i}`, 6)),
      sink,
    );
    await settle(m, () => net.requests.length === 2);
    await new Promise((r) => setTimeout(r, 5));
    expect(net.requests).toHaveLength(2);
    m.configure({ maxFiles: 5 });
    await settle(m, () => net.requests.length === 5);
    net.hold(false);
    const tasks = await settle(m, allDone);
    expect(net.maxInFlight()).toBeLessThanOrEqual(5);
    expect(tasks.every((t) => t.status === 'done' && t.target === 'device')).toBe(true);
    expect(tasks.map((t) => sink.text(t))).toEqual(
      Array.from({ length: 8 }, (_, i) => `file-${i}`),
    );
    expect(sink.finished).toHaveLength(8);
  });

  it('picks up a cut-off stream with Range and gets a new link when one expires', async () => {
    const net = fakeNet({
      '/d/big': { body: '0123456789', cutAt: 4 },
      '/d/old': { body: 'ignored', answers: [410] },
      '/d/new': { body: 'fresh' },
    });
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 3 }, net.deps);
    m.add([src('big', 10), src('old', 5, { refresh: async () => '/d/new' })], sink);
    const tasks = await settle(m, allDone);
    expect(tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(sink.text(tasks[0]!)).toBe('0123456789');
    expect(net.requests.filter((r) => r.url === '/d/big').map((r) => r.range)).toEqual([
      null,
      'bytes=4-',
    ]);
    expect(sink.text(tasks[1]!)).toBe('fresh');
  });

  it('starts over when the server ignores Range', async () => {
    const net = fakeNet({ '/d/f': { body: 'abcdef', cutAt: 3, noRange: true } });
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 1 }, net.deps);
    m.add([src('f', 6)], sink);
    const [task] = await settle(m, allDone);
    expect(task!.status).toBe('done');
    expect(sink.text(task!)).toBe('abcdef');
  });

  it('waits for the network instead of failing, and stops on errors that will not heal', async () => {
    const net = fakeNet({ '/d/a': { body: 'aa' }, '/d/gone': { body: 'x', answers: [404] } });
    net.setOnline(false);
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 2 }, net.deps);
    m.add([src('a', 2), src('gone', 1)], sink);
    const waiting = await settle(m, (t) => t[0]!.status === 'offline');
    expect(waiting[0]!.status).toBe('offline');
    expect(net.requests).toHaveLength(0);
    net.setOnline(true);
    const tasks = await settle(m, allDone);
    expect(tasks[0]!.status).toBe('done');
    expect(tasks[1]).toMatchObject({ status: 'error', errorCode: 'NOT_FOUND' });
    expect(net.requests.filter((r) => r.url === '/d/gone')).toHaveLength(1);
  });

  it('retries server errors with backoff, then gives up', async () => {
    const net = fakeNet({
      '/d/flaky': { body: 'ok', answers: [503, 502] },
      '/d/down': { body: 'x', answers: [500, 500, 500, 500, 500, 500, 500] },
    });
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 2 }, net.deps);
    m.add([src('flaky', 2), src('down', 1)], sink);
    const tasks = await settle(m, allDone);
    expect(tasks[0]!.status).toBe('done');
    expect(tasks[1]).toMatchObject({ status: 'error', errorCode: 'HTTP_500' });
    expect(net.requests.filter((r) => r.url === '/d/down')).toHaveLength(6);
  });

  it('pauses, resumes from where it was, and cancels (throwing the bytes away)', async () => {
    const net = fakeNet({ '/d/p': { body: 'paused-file' }, '/d/c': { body: 'canceled' } });
    const sink = new MemorySink();
    const m = new DownloadManager({ maxFiles: 2 }, net.deps);
    net.hold(true);
    m.add([src('p', 11), src('c', 8)], sink);
    const [p, c] = await settle(m, () => net.requests.length === 2);
    m.pause(p!.id);
    m.cancel(c!.id);
    net.hold(false);
    let tasks = await settle(m, allDone);
    expect(tasks.map((t) => t.status)).toEqual(['paused', 'canceled']);
    await settle(m, () => sink.discarded.includes('c'));
    m.resume(p!.id);
    tasks = await settle(m, (t) => t[0]!.status === 'done');
    expect(sink.text(tasks[0]!)).toBe('paused-file');
    expect(m.busy()).toBe(false);
    m.clearFinished();
    expect(m.getSnapshot()).toHaveLength(0);
  });

  it('hands files over to the browser when there is no room (or no private storage)', async () => {
    const handed: string[] = [];
    const net = fakeNet({});
    net.deps.handOff = (url) => handed.push(url);
    const sink = new MemorySink();
    sink.room = false;
    const m = new DownloadManager({ maxFiles: 2 }, net.deps);
    m.add([src('huge', 10)], sink);
    m.add([src('plain', 3)], null);
    const tasks = await settle(m, allDone);
    expect(tasks.map((t) => [t.status, t.target])).toEqual([
      ['done', 'browser'],
      ['done', 'browser'],
    ]);
    expect(handed.sort()).toEqual(['/d/huge', '/d/plain']);
    expect(net.requests).toHaveLength(0);
  });
});
