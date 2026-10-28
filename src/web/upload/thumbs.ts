// Browser-side thumbnails (never Cloudflare Images — that quota is for compression, SPEC §5.2).
import { ApiError } from '../lib/api';

const MAX = 320;
const IMAGE = /^image\/(jpeg|png|webp|gif|avif|bmp)$/;
let worker: Worker | null = null;
const pending = new Map<string, (b: Blob | null) => void>();

function imageWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./thumb.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: string; blob: Blob | null }>) => {
      pending.get(e.data.id)?.(e.data.blob);
      pending.delete(e.data.id);
    };
  }
  return worker;
}

function imageThumb(file: File): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    imageWorker().postMessage({ id, file });
  });
}

function videoThumb(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let finished = false;
    const done = (b: Blob | null) => {
      if (finished) return;
      finished = true;
      // Stop the element first: revoking while it still reads logs ERR_FILE_NOT_FOUND per request.
      video.onloadedmetadata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(b);
    };
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 2) / 2);
    };
    video.onseeked = () => {
      const scale = Math.min(1, MAX / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => done(b && b.type === 'image/webp' ? b : null), 'image/webp', 0.75);
    };
    video.onerror = () => done(null);
    setTimeout(() => done(null), 15_000);
  });
}

/** JPEG XL, which browsers rarely decode themselves: libjxl in WebAssembly (ADR-067). */
async function jxlThumb(file: File): Promise<Blob | null> {
  const { decodeJxl } = await import('../editors/codecs/image');
  const data = await decodeJxl(file);
  const full = document.createElement('canvas');
  full.width = data.width;
  full.height = data.height;
  full.getContext('2d')!.putImageData(data, 0, 0);
  const scale = Math.min(1, MAX / Math.max(data.width, data.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(data.width * scale));
  canvas.height = Math.max(1, Math.round(data.height * scale));
  canvas.getContext('2d')!.drawImage(full, 0, 0, canvas.width, canvas.height);
  full.width = full.height = 0;
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b && b.type === 'image/webp' ? b : null), 'image/webp', 0.75),
  );
}

export async function makeAndUploadThumb(nodeId: string, file: File): Promise<void> {
  const type = file.type.toLowerCase();
  let blob: Blob | null = null;
  if ((type === 'image/jxl' || /\.jxl$/i.test(file.name)) && file.size < 60 * 1024 * 1024)
    blob = await jxlThumb(file).catch(() => null);
  else if (IMAGE.test(type) && file.size < 60 * 1024 * 1024) blob = await imageThumb(file);
  else if (type.startsWith('video/')) blob = await videoThumb(file);
  if (!blob || blob.size > 128 * 1024) return;
  const token = /(?:^|; )__Host-zk\.csrf=([^;]+)/.exec(document.cookie)?.[1];
  const res = await fetch(`/api/files/${nodeId}/thumbnail`, {
    method: 'PUT',
    body: blob,
    credentials: 'same-origin',
    headers: {
      'content-type': 'image/webp',
      ...(token ? { 'x-csrf-token': decodeURIComponent(token) } : {}),
    },
  });
  if (!res.ok && res.status !== 404)
    throw new ApiError(res.status, 'THUMB', 'thumbnail upload failed');
}
