// Getting a file into an editor and the result back out (ADR-050). Drive files come through the
// preview URL (USERCONTENT_ORIGIN, CORS for the app), so the same access and scan checks apply;
// results go through the normal upload queue (quota, scan, thumbnail, folder permission).
import { TEXT_EXT } from '../../shared/preview';
import { api } from '../lib/api';
import { nodeInfo, previewInfo, type NodeDto } from '../lib/files';
import type { Catalog, Me } from '../lib/types';
import { uploads } from '../upload/useUploads';

export type Tool = 'photo' | 'video' | 'pdf' | 'text' | 'doc' | 'sheet' | 'zip';

/** What an editor opens: Drive files, files from this device, or both. */
export interface EditRequest {
  tool: Tool;
  nodes: NodeDto[];
  files: File[];
  /** PDF tools: start from these pictures made into one PDF. */
  fromImages?: boolean;
  /** A new, empty file (the New menu, ADR-051); saved into `folderId`, or My Drive without one. */
  blank?: { name: string; folderId?: string };
}

/** One file the editor works on. */
export interface Source {
  name: string;
  blob: Blob;
  /** Null for a file from this device. */
  node: NodeDto | null;
  /** A file without a node: the folder it goes to (a new file, or one saved from the editor). */
  folderId?: string;
  /** Already saved to Drive under `name` in `folderId`, so saving again can replace it. */
  saved?: boolean;
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
export const isDoc = (_mime: string | null, name: string) => /\.docx$/i.test(name);
export const isSheet = (_mime: string | null, name: string) => /\.(xlsx|csv|tsv)$/i.test(name);
export const isZip = (mime: string | null, name: string) =>
  mime === 'application/zip' || mime === 'application/x-zip-compressed' || /\.zip$/i.test(name);
export const isText = (mime: string | null, name: string) =>
  TEXT_EXT.has(extOf(name)) ||
  /^text\//.test(mime ?? '') ||
  mime === 'application/json' ||
  mime === 'application/xml';

/** Drive files an editor can open: ready (scanned) files only. */
export const editable = (n: NodeDto) => n.kind === 'file' && n.status === 'ready';

export function toolFor(mime: string | null, name: string): Tool | null {
  if (isPdf(mime, name)) return 'pdf';
  if (isVideo(mime, name)) return 'video';
  if (isImage(mime, name)) return 'photo';
  if (isDoc(mime, name)) return 'doc';
  if (isSheet(mime, name)) return 'sheet';
  if (isZip(mime, name)) return 'zip';
  if (isText(mime, name)) return 'text';
  return null;
}

export function maxBytes(c: Catalog['config'] | undefined, tool: Tool): number {
  if (!c) return 0;
  const max: Record<Tool, number> = {
    photo: c.editor_image_max_bytes,
    video: c.editor_video_max_bytes,
    pdf: c.editor_pdf_max_bytes,
    text: c.editor_text_max_bytes,
    doc: c.editor_doc_max_bytes,
    sheet: c.editor_sheet_max_bytes,
    zip: c.editor_zip_max_bytes,
  };
  return max[tool];
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
  return ext ? `${base} (${suffix}).${ext}` : `${base} (${suffix})`;
}

export const extOf = (name: string) => splitName(name)[1].toLowerCase();

export function withExt(name: string, ext: string): string {
  const [base, old] = splitName(name);
  return old.toLowerCase() === ext ? name : `${base}.${ext}`;
}

/**
 * Where a result is saved: next to the Drive file (or in the folder a new file was made in) when
 * this person may add files there, else in their own Drive (a family folder they can only read,
 * or a file from this device).
 */
export async function saveFolder(
  source: Pick<Source, 'node' | 'folderId'> | null,
): Promise<{ parentId: string; same: boolean }> {
  const me = await api<Me>('/api/me');
  const root = me.space.personalRootId;
  const folderId = source?.node ? source.node.parentId : source?.folderId;
  if (!folderId) return { parentId: root, same: false };
  const parent = await nodeInfo(folderId).catch(() => null);
  return parent?.access.edit ? { parentId: folderId, same: true } : { parentId: root, same: false };
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
