// Where the download queue writes (ADR-053).
// - device: the browser's private storage (OPFS), then handed to the Downloads folder through a
//   blob URL of the finished file; needs room for the file twice for a moment.
// - folder: a folder the person picked (File System Access API, Chrome/Edge desktop), with the
//   batch's folder structure kept; nothing is ever overwritten ("a (1).jpg").
import type { DownloadTask, Sink, SinkWriter } from './manager';
import { numbered, safeParts } from './names';

const DIR = 'zk-downloads';
/** How long a finished file stays in private storage for the browser to copy it out. */
const KEEP_MS = 15 * 60_000;
/** Left over from a tab that closed mid-way: cleared on the next start. */
const STALE_MS = 6 * 3600_000;
const SPARE_BYTES = 64 * 1024 * 1024;

type Writable = FileSystemWritableFileStream;

function writer(w: Writable): SinkWriter {
  return {
    // Copy into a plain ArrayBuffer-backed view: the DOM type wants one, and chunks may be shared.
    write: (chunk) => w.write(new Uint8Array(chunk)),
    close: () => w.close(),
  };
}

async function openAt(handle: FileSystemFileHandle, offset: number): Promise<SinkWriter> {
  const w = await handle.createWritable({ keepExistingData: offset > 0 });
  if (offset > 0) {
    await w.truncate(offset);
    await w.seek(offset);
  }
  return writer(w);
}

export function deviceSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

async function privateDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** Drops files a closed tab left behind. */
export async function sweepDevice(now = Date.now()): Promise<void> {
  if (!deviceSupported()) return;
  try {
    const dir = await privateDir();
    const names: string[] = [];
    for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind !== 'file') continue;
      const f = await (h as FileSystemFileHandle).getFile().catch(() => null);
      if (!f || now - f.lastModified > STALE_MS) names.push(name);
    }
    for (const n of names) await dir.removeEntry(n).catch(() => undefined);
  } catch {
    // private storage blocked: nothing to sweep
  }
}

export function deviceSink(handOff: (url: string, name: string) => void): Sink {
  return {
    target: 'device',
    async open(task, offset) {
      const dir = await privateDir();
      return openAt(await dir.getFileHandle(task.id, { create: true }), offset);
    },
    async finish(task) {
      const dir = await privateDir();
      const file = await (await dir.getFileHandle(task.id)).getFile();
      const url = URL.createObjectURL(file);
      handOff(url, task.name);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        void dir.removeEntry(task.id).catch(() => undefined);
      }, KEEP_MS);
    },
    async discard(task) {
      const dir = await privateDir();
      await dir.removeEntry(task.id).catch(() => undefined);
    },
    async hasRoom(bytes) {
      try {
        const e = await navigator.storage.estimate();
        if (e.quota === undefined || e.usage === undefined) return true;
        return e.quota - e.usage > bytes + SPARE_BYTES;
      } catch {
        return true;
      }
    },
  };
}

export function folderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Must run inside the click (the picker needs a user gesture). Null = the person closed it. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as {
    showDirectoryPicker: (o: {
      mode: 'readwrite';
      id?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  };
  try {
    return await w.showDirectoryPicker({ mode: 'readwrite', id: 'zeiko-downloads' });
  } catch {
    return null;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TypeMismatchError') return true; // a folder
    return false;
  }
}

export interface FolderSink extends Sink {
  readonly name: string;
  /** Makes the batch's folders, empty ones included. */
  ensureFolders(paths: string[]): Promise<void>;
}

export function folderSink(root: FileSystemDirectoryHandle): FolderSink {
  const files = new Map<string, { dir: FileSystemDirectoryHandle; name: string }>();

  async function dirFor(parts: string[]): Promise<FileSystemDirectoryHandle> {
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    return d;
  }

  async function place(task: DownloadTask) {
    let at = files.get(task.id);
    if (at) return at;
    const parts = safeParts(task.path);
    const base = parts.pop() ?? (safeParts(task.name)[0] || 'file');
    const dir = await dirFor(parts);
    let name = base;
    for (let n = 1; (await exists(dir, name)) && n < 1000; n++) name = numbered(base, n);
    at = { dir, name };
    files.set(task.id, at);
    return at;
  }

  return {
    target: 'folder',
    name: root.name,
    async open(task, offset) {
      const at = await place(task);
      return openAt(await at.dir.getFileHandle(at.name, { create: true }), offset);
    },
    async finish() {
      // Already in place.
    },
    async discard(task) {
      const at = files.get(task.id);
      if (at) await at.dir.removeEntry(at.name).catch(() => undefined);
    },
    async ensureFolders(paths) {
      for (const p of paths) {
        const parts = safeParts(p);
        if (parts.length) await dirFor(parts).catch(() => undefined);
      }
    },
  };
}
