// Global upload queue (SPEC §5.2 client): ≤ N files at once, ≤ M parallel parts per file, per-part
// retry with exponential backoff + jitter (max 5), pause/resume/cancel, resume after refresh via
// IndexedDB, then a browser-made thumbnail.
import { api, ApiError, sendJson } from '../lib/api';
import type { NodeDto } from '../lib/files';
import { deleteResume, fingerprint, getResume, putResume } from './idb';
import { makeAndUploadThumb } from './thumbs';
import { putWithProgress, type PutHandle } from './xhr';

const SIMPLE_MAX = 16 * 1024 * 1024;
const MAX_PART_RETRIES = 5;

export type TaskStatus =
  | 'queued'
  | 'resumable'
  | 'conflict'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'done'
  | 'error'
  | 'canceled'
  | 'skipped';

export type ConflictChoice = 'replace' | 'rename' | 'skip';

export interface UploadTask {
  id: string;
  file: File;
  parentId: string;
  name: string;
  size: number;
  status: TaskStatus;
  loaded: number;
  speed: number; // bytes/s
  error: string | null;
  errorCode: string | null;
  uploadId: string | null;
  node: NodeDto | null;
  onConflict: 'error' | 'rename' | 'replace';
  batchId: string;
}

interface Runtime {
  handles: Set<PutHandle>;
  partLoaded: Map<number, number>;
  doneBytes: number;
  samples: Array<[number, number]>;
  paused: boolean;
  canceled: boolean;
}

export interface ManagerOptions {
  maxFiles: number;
  partConcurrency: number;
  onUploaded: (node: NodeDto, parentId: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());

export class UploadManager {
  private tasks: UploadTask[] = [];
  private runtime = new Map<string, Runtime>();
  private listeners = new Set<() => void>();
  private snapshot: readonly UploadTask[] = [];
  /** "Terapkan ke semua" choice per batch. */
  private batchChoice = new Map<string, ConflictChoice>();

  constructor(private opts: ManagerOptions) {}

  configure(o: Partial<Pick<ManagerOptions, 'maxFiles' | 'partConcurrency'>>): void {
    Object.assign(this.opts, o);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): readonly UploadTask[] => this.snapshot;

  private emit(): void {
    this.snapshot = this.tasks.map((t) => ({ ...t }));
    for (const l of this.listeners) l();
  }

  private patch(id: string, p: Partial<UploadTask>): void {
    const t = this.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, p);
    this.emit();
  }

  async add(items: Array<{ file: File; parentId: string; name?: string }>): Promise<void> {
    const batchId = crypto.randomUUID();
    for (const it of items) {
      const task: UploadTask = {
        id: crypto.randomUUID(),
        file: it.file,
        parentId: it.parentId,
        name: it.name ?? it.file.name,
        size: it.file.size,
        status: 'queued',
        loaded: 0,
        speed: 0,
        error: null,
        errorCode: null,
        uploadId: null,
        node: null,
        onConflict: 'error',
        batchId,
      };
      if (task.size > SIMPLE_MAX) {
        const rec = await getResume(fingerprint(it.file, it.parentId));
        if (rec) {
          task.uploadId = rec.uploadId;
          task.status = 'resumable';
        }
      }
      this.tasks.push(task);
    }
    this.emit();
    this.pump();
  }

  /** Answer the "Lanjutkan upload?" offer. */
  resumeChoice(id: string, resume: boolean): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status !== 'resumable') return;
    if (!resume) {
      void deleteResume(fingerprint(t.file, t.parentId));
      if (t.uploadId) void sendJson('DELETE', `/api/uploads/${t.uploadId}`).catch(() => undefined);
      t.uploadId = null;
    }
    this.patch(id, { status: 'queued' });
    this.pump();
  }

  resolveConflict(id: string, choice: ConflictChoice, applyToAll: boolean): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status !== 'conflict') return;
    if (applyToAll) {
      this.batchChoice.set(t.batchId, choice);
      for (const other of this.tasks) {
        if (other.batchId === t.batchId && other.status === 'conflict' && other.id !== id)
          this.applyChoice(other, choice);
      }
    }
    this.applyChoice(t, choice);
    this.emit();
    this.pump();
  }

  private applyChoice(t: UploadTask, choice: ConflictChoice): void {
    if (choice === 'skip') t.status = 'skipped';
    else {
      t.onConflict = choice;
      t.status = 'queued';
    }
  }

  pause(id: string): void {
    const rt = this.runtime.get(id);
    if (rt) {
      rt.paused = true;
      for (const h of rt.handles) h.abort();
    }
    this.patch(id, { status: 'paused', speed: 0 });
  }

  resume(id: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (t && (t.status === 'paused' || t.status === 'error')) {
      this.patch(id, { status: 'queued', error: null, errorCode: null });
      this.pump();
    }
  }

  cancel(id: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const rt = this.runtime.get(id);
    if (rt) {
      rt.canceled = true;
      for (const h of rt.handles) h.abort();
    }
    if (t.uploadId && t.status !== 'done') {
      void sendJson('DELETE', `/api/uploads/${t.uploadId}`).catch(() => undefined);
      void deleteResume(fingerprint(t.file, t.parentId));
    }
    this.patch(id, { status: 'canceled', speed: 0 });
    this.pump();
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => !['done', 'canceled', 'skipped'].includes(t.status));
    this.emit();
  }

  private active(): number {
    return this.tasks.filter((t) => t.status === 'uploading' || t.status === 'completing').length;
  }

  private pump(): void {
    while (this.active() < this.opts.maxFiles) {
      const next = this.tasks.find((t) => t.status === 'queued');
      if (!next) return;
      next.status = 'uploading';
      this.emit();
      void this.run(next);
    }
  }

  private progress(t: UploadTask, rt: Runtime): void {
    let loaded = rt.doneBytes;
    for (const v of rt.partLoaded.values()) loaded += v;
    const now = performance.now();
    rt.samples.push([now, loaded]);
    while (rt.samples.length > 2 && now - rt.samples[0]![0] > 3000) rt.samples.shift();
    const [t0, b0] = rt.samples[0]!;
    const speed = now - t0 > 250 ? ((loaded - b0) * 1000) / (now - t0) : t.speed;
    t.loaded = Math.min(loaded, t.size);
    t.speed = speed;
    this.emit();
  }

  private async run(t: UploadTask): Promise<void> {
    const rt: Runtime = {
      handles: new Set(),
      partLoaded: new Map(),
      doneBytes: 0,
      samples: [],
      paused: false,
      canceled: false,
    };
    this.runtime.set(t.id, rt);
    try {
      const node =
        t.size <= SIMPLE_MAX ? await this.runSimple(t, rt) : await this.runMultipart(t, rt);
      if (!node) return;
      this.patch(t.id, { status: 'done', node, loaded: t.size, speed: 0 });
      this.opts.onUploaded(node, t.parentId);
      void makeAndUploadThumb(node.id, t.file).catch(() => undefined);
    } catch (e) {
      if (rt.canceled || rt.paused) return;
      const err = e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e));
      const choice = this.batchChoice.get(t.batchId);
      if (err.code === 'NAME_CONFLICT' && choice) {
        this.applyChoice(t, choice);
        this.emit();
      } else if (err.code === 'NAME_CONFLICT') {
        this.patch(t.id, { status: 'conflict', speed: 0 });
      } else {
        this.patch(t.id, { status: 'error', error: err.message, errorCode: err.code, speed: 0 });
      }
    } finally {
      this.runtime.delete(t.id);
      this.pump();
    }
  }

  private async runSimple(t: UploadTask, rt: Runtime): Promise<NodeDto | null> {
    const q = new URLSearchParams({
      parentId: t.parentId,
      name: t.name,
      size: String(t.size),
      lastModified: String(t.file.lastModified),
      onConflict: t.onConflict,
    });
    if (t.file.type) q.set('mime', t.file.type);
    for (let attempt = 0; ; attempt++) {
      const h = putWithProgress(`/api/uploads/simple?${q}`, t.file, (loaded) => {
        rt.partLoaded.set(1, loaded);
        this.progress(t, rt);
      });
      rt.handles.add(h);
      try {
        const res = (await h.promise) as { node: NodeDto };
        return res.node;
      } catch (e) {
        if (rt.paused || rt.canceled) return null;
        if (!(e instanceof ApiError) || !retryable(e) || attempt >= MAX_PART_RETRIES) throw e;
        await sleep(backoff(attempt));
      } finally {
        rt.handles.delete(h);
      }
    }
  }

  private async runMultipart(t: UploadTask, rt: Runtime): Promise<NodeDto | null> {
    const fp = fingerprint(t.file, t.parentId);
    let partSize: number;
    let totalParts: number;
    let done = new Set<number>();
    let uploadId = t.uploadId;

    if (uploadId) {
      const st = await api<{
        status: string;
        partSize: number;
        totalParts: number;
        uploadedParts: number[];
      }>(`/api/uploads/${uploadId}`).catch(() => null);
      if (st && st.status === 'active') {
        partSize = st.partSize;
        totalParts = st.totalParts;
        done = new Set(st.uploadedParts);
      } else {
        uploadId = null;
        await deleteResume(fp);
      }
    }
    if (!uploadId) {
      const init = await sendJson<{ uploadId: string; partSize: number; totalParts: number }>(
        'POST',
        '/api/uploads',
        {
          parentId: t.parentId,
          name: t.name,
          size: t.size,
          mime: t.file.type || null,
          lastModified: t.file.lastModified,
          onConflict: t.onConflict,
        },
      );
      uploadId = init.uploadId;
      partSize = init.partSize;
      totalParts = init.totalParts;
      await putResume({
        fingerprint: fp,
        uploadId,
        parentId: t.parentId,
        name: t.name,
        size: t.size,
        createdAt: Date.now(),
      });
    }
    t.uploadId = uploadId;
    const ps = partSize!;
    const total = totalParts!;
    for (const n of done) rt.doneBytes += n < total ? ps : t.size - ps * (total - 1);
    this.progress(t, rt);

    const queue = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
    const worker = async () => {
      for (;;) {
        const n = queue.shift();
        if (n === undefined || rt.paused || rt.canceled) return;
        const start = (n - 1) * ps;
        const chunk = t.file.slice(start, Math.min(start + ps, t.size));
        for (let attempt = 0; ; attempt++) {
          const h = putWithProgress(`/api/uploads/${uploadId}/parts/${n}`, chunk, (loaded) => {
            rt.partLoaded.set(n, loaded);
            this.progress(t, rt);
          });
          rt.handles.add(h);
          try {
            await h.promise;
            rt.partLoaded.delete(n);
            rt.doneBytes += chunk.size;
            this.progress(t, rt);
            break;
          } catch (e) {
            rt.partLoaded.delete(n);
            if (rt.paused || rt.canceled) return;
            if (!(e instanceof ApiError) || !retryable(e) || attempt >= MAX_PART_RETRIES) throw e;
            await sleep(backoff(attempt));
          } finally {
            rt.handles.delete(h);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.opts.partConcurrency, queue.length || 1) }, worker),
    );
    if (rt.paused || rt.canceled) return null;

    this.patch(t.id, { status: 'completing' });
    const res = await sendJson<{ node: NodeDto }>('POST', `/api/uploads/${uploadId}/complete`);
    await deleteResume(fp);
    return res.node;
  }
}

function retryable(e: ApiError): boolean {
  return e.status === 0 || e.status === 429 || e.status >= 500;
}
