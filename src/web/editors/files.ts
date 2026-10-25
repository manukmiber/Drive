// Getting a file into an editor and the result back out (ADR-050). Drive files come through the
// preview URL (USERCONTENT_ORIGIN, CORS for the app), so the same access and scan checks apply;
// results go through the normal upload queue (quota, scan, thumbnail, folder permission).
import { api } from '../lib/api';
import { nodeInfo, previewInfo, type NodeDto } from '../lib/files';
import type { Catalog, Me } from '../lib/types';
import { uploads } from '../upload/useUploads';

export type Tool = 'photo' | 'video' | 'pdf';

/** What an editor opens: Drive files, files from this device, or both. */
export interface EditRequest {
  tool: Tool;
  nodes: NodeDto[];
  files: File[];
  /** PDF tools: start from these pictures made into one PDF. */
  fromImages?: boolean;
}

/** One file the editor works on. */
export interface Source {
  name: string;
  blob: Blob;
  /** Null for a file from this device. */
  node: NodeDto | null;
}

export class TooLargeError extends Error {
  constructor(readonly max: number) {
    super('TOO_LARGE');
  }
}

const IMAGE = /^image\/(jpeg|png|webp|avif|gif|bmp|heic|heif)$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;

export const isImage = (mime: string | null, name: string) =>
  IMAGE.test(mime ?? '') || IMAGE_EXT.test(name);
export const isVideo = (mime: string | null, name: string) =>
  (mime ?? '').startsWith('video/') || VIDEO_EXT.test(name);
export const isPdf = (mime: string | null, name: string) =>
  mime === 'application/pdf' || /\.pdf$/i.test(name);

/** Drive files an editor can open: ready (scanned) files only. */
export const editable = (n: NodeDto) => n.kind === 'file' && n.status === 'ready';

export function toolFor(mime: string | null, name: string): Tool | null {
  if (isPdf(mime, name)) return 'pdf';
  if (isVideo(mime, name)) return 'video';
  if (isImage(mime, name)) return 'photo';
  return null;
}

export function maxBytes(c: Catalog['config'] | undefined, tool: Tool): number {
  if (!c) return 0;
  return tool === 'photo'
    ? c.editor_image_max_bytes
    : tool === 'video'
      ? c.editor_video_max_bytes
      : c.editor_pdf_max_bytes;
}

/** Downloads a Drive file's bytes into memory, reporting 0…1. */
export async function loadNode(
  node: NodeDto,
  max: number,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (max && node.size > max) throw new TooLargeError(max);
  const { url } = await previewInfo(node.id);
  const res = await fetch(url, { signal, credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress(node.size ? Math.min(1, got / node.size) : 0);
  }
  return new Blob(chunks, { type: node.mime ?? '' });
}

export function fromFile(f: File, max: number): Source {
  if (max && f.size > max) throw new TooLargeError(max);
  return { name: f.name, blob: f, node: null };
}

const splitName = (name: string): [string, string] => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
};

/** "liburan.jpg" → "liburan (edit).webp"; `suffix` is the words in the brackets. */
export function resultName(name: string, ext: string, suffix: string): string {
  const [base] = splitName(name);
  return `${base} (${suffix}).${ext}`;
}

export const extOf = (name: string) => splitName(name)[1].toLowerCase();

export function withExt(name: string, ext: string): string {
  const [base, old] = splitName(name);
  return old.toLowerCase() === ext ? name : `${base}.${ext}`;
}

/**
 * Where a result is saved: next to the Drive file when this person may add files there, else in
 * their own Drive (a family folder they can only read, or a file from this device).
 */
export async function saveFolder(
  node: NodeDto | null,
): Promise<{ parentId: string; same: boolean }> {
  const me = await api<Me>('/api/me');
  const root = me.space.personalRootId;
  if (!node?.parentId) return { parentId: root, same: false };
  const parent = await nodeInfo(node.parentId).catch(() => null);
  return parent?.access.edit
    ? { parentId: node.parentId, same: true }
    : { parentId: root, same: false };
}

/** Queues the result for upload; `replace` sends the old file of the same name to the Trash. */
export function saveToDrive(blob: Blob, name: string, parentId: string, replace: boolean): void {
  const file = new File([blob], name, { type: blob.type, lastModified: Date.now() });
  void uploads().add([{ file, parentId, name, onConflict: replace ? 'replace' : 'rename' }]);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
