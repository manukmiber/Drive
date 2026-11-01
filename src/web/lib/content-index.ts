// D6 (ADR-090): sends the text this browser took from files to the person's Drive, in batches
// (one R2 write per batch and space), only while "search file contents" is on. After an upload the
// text comes from the local file; "Index again" downloads what has none yet.
import { api, ApiError } from './api';
import { extractText, textKind } from './content-text';
import { previewInfo } from './files';
import type { NodeDto } from './files';

let enabled: Promise<boolean> | null = null;
let full = false;
const queue: Array<{ id: string; text: string }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;

const BATCH_FILES = 20;
const BATCH_BYTES = 900 * 1024;
/** Characters kept per file; the server cuts to its own config too. */
export const TEXT_MAX_CHARS = 20_000;

/** The person's switch, read once per page load (and set when they flip it). */
export function contentSearchEnabled(): Promise<boolean> {
  enabled ??= api<{ contentSearch: boolean }>('/api/drive/settings')
    .then((r) => r.contentSearch)
    .catch(() => false);
  return enabled;
}

export function rememberContentSearch(on: boolean): void {
  enabled = Promise.resolve(on);
  if (on) full = false;
}

/** True once the server said the space's search text is full (until the page reloads). */
export const contentIndexFull = () => full;

async function flush(): Promise<void> {
  while (queue.length && !full) {
    const batch: typeof queue = [];
    let bytes = 0;
    while (queue.length && batch.length < BATCH_FILES) {
      const line = JSON.stringify(queue[0]);
      if (batch.length && bytes + line.length > BATCH_BYTES) break;
      batch.push(queue.shift()!);
      bytes += line.length + 1;
    }
    try {
      await api('/api/drive/texts', {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: batch.map((b) => JSON.stringify(b)).join('\n'),
      });
    } catch (e) {
      if (e instanceof ApiError && e.data?.reason === 'CONTENT_INDEX_FULL') full = true;
      if (e instanceof ApiError && e.data?.reason === 'CONTENT_SEARCH_OFF') {
        rememberContentSearch(false);
        queue.length = 0;
      }
      // Anything else: these files simply stay without text, "Index again" finds them later.
    }
  }
}

function schedule(delay = 2000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    sending = (sending ?? Promise.resolve()).then(flush);
  }, delay);
}

/** Waits for everything queued to be sent. */
export async function flushTexts(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  sending = (sending ?? Promise.resolve()).then(flush);
  await sending;
}

/** After an upload: the text of the file just sent, from the local copy. */
export async function indexUploaded(node: NodeDto, file: Blob): Promise<void> {
  if (full || node.kind !== 'file' || !textKind(node.name, node.mime ?? file.type)) return;
  if (!(await contentSearchEnabled())) return;
  const text = await extractText(file, node.name, node.mime ?? file.type, TEXT_MAX_CHARS);
  if (!text) return;
  queue.push({ id: node.id, text });
  schedule();
}

interface Missing {
  items: Array<{ id: string; name: string; mime: string | null; size: number }>;
  total: number;
}

/**
 * "Index again": documents of the person's spaces with no text yet, downloaded here one by one.
 * Returns how many got text. `signal` stops it.
 */
export async function reindexMissing(
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let indexed = 0;
  let done = 0;
  const tried = new Set<string>();
  for (let round = 0; round < 50 && !full && !signal?.aborted; round++) {
    const missing = await api<Missing>('/api/drive/texts/missing');
    const fresh = missing.items.filter((i) => !tried.has(i.id));
    if (!fresh.length) break;
    const total = done + fresh.length + Math.max(0, missing.total - missing.items.length);
    for (const it of fresh) {
      if (signal?.aborted || full) break;
      tried.add(it.id);
      try {
        const { url } = await previewInfo(it.id);
        const res = await fetch(url, { credentials: 'omit' });
        if (res.ok) {
          const text = await extractText(await res.blob(), it.name, it.mime, TEXT_MAX_CHARS);
          if (text) {
            queue.push({ id: it.id, text });
            indexed++;
            if (queue.length >= BATCH_FILES) await flushTexts();
          }
        }
      } catch {
        // A file that cannot be fetched or read stays without text.
      }
      done++;
      onProgress(done, Math.max(total, done));
    }
    await flushTexts();
  }
  return indexed;
}
