// Media compression API (SPEC §11).
import { api, ApiError, postJson } from './api';
import type { NodeDto } from './files';

export type Quality = 'hemat' | 'seimbang' | 'tinggi';
export interface MediaOptions {
  image: { format: 'avif' | 'webp' | 'jpeg'; quality: Quality; maxWidth?: number };
  video: { preset: '1080p' | '720p' | '480p'; quality: Quality };
}

export interface CompressJob {
  id: string;
  batchId: string | null;
  kind: 'image' | 'video';
  engine: string;
  name: string;
  size: number;
  status: 'uploading' | 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  save: 'copy' | 'replace';
  standalone: boolean;
  creditsUsed: number;
  savedBytes: number | null;
  outNodeId: string | null;
  error: string | null;
  createdAt: number;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|heic|heif|bmp|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|3gp)$/i;

/** Mirrors the server's kindOf (services/compress.ts). */
export function mediaKind(name: string, mime: string | null): 'image' | 'video' | null {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/') && !m.includes('svg') && !m.includes('gif')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (IMAGE_EXT.test(name)) return 'image';
  if (VIDEO_EXT.test(name)) return 'video';
  return null;
}

export const isCompressible = (n: NodeDto) =>
  n.kind === 'file' && n.status === 'ready' && mediaKind(n.name, n.mime) !== null;

export const listCompressJobs = () =>
  api<{ credits: number; jobs: CompressJob[] }>('/api/compress');

export const startCompress = (nodeIds: string[], o: MediaOptions & { save: 'copy' | 'replace' }) =>
  postJson<{ batchId: string; queued: number; failed: Array<{ nodeId: string; reason: string }> }>(
    '/api/compress',
    { nodeIds, ...o },
  );

/** Standalone: chunked upload to tmp/compress, then queue the job. */
export async function compressStandalone(
  file: File,
  o: MediaOptions,
  onProgress: (ratio: number) => void,
): Promise<CompressJob> {
  const start = await postJson<{ jobId: string; partSize: number; parts: number }>(
    '/api/compress/standalone',
    { name: file.name, size: file.size, mime: file.type || null, ...o },
  );
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let n = 1; n <= start.parts; n++) {
    const chunk = file.slice((n - 1) * start.partSize, Math.min(file.size, n * start.partSize));
    parts.push(
      await api<{ partNumber: number; etag: string }>(
        `/api/compress/standalone/${start.jobId}/parts/${n}`,
        { method: 'PUT', body: chunk, headers: { 'content-type': 'application/octet-stream' } },
      ),
    );
    onProgress(n / start.parts);
  }
  return postJson<CompressJob>(`/api/compress/standalone/${start.jobId}/complete`, { parts });
}

export function standaloneResultUrl(jobId: string): string {
  return `/api/compress/standalone/${jobId}/result`;
}

export function reasonCode(e: unknown): string {
  if (e instanceof ApiError) return e.code === 'BAD_REQUEST' ? e.message : e.code;
  return 'ERROR';
}
