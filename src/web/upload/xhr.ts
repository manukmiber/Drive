// PUT with upload progress (fetch() has no upload progress events).
import { ApiError } from '../lib/api';

function csrf(): string | null {
  const m = /(?:^|; )__Host-zk\.csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

export interface PutHandle {
  promise: Promise<unknown>;
  abort(): void;
}

export function putWithProgress(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  headers: Record<string, string> = {},
): PutHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<unknown>((resolve, reject) => {
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    const token = csrf();
    if (token) xhr.setRequestHeader('x-csrf-token', token);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = (
        data as { error?: { code: string; message: string; data?: Record<string, unknown> } } | null
      )?.error;
      reject(
        new ApiError(
          xhr.status,
          err?.code ?? 'INTERNAL',
          err?.message ?? xhr.statusText,
          err?.data,
        ),
      );
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'network error'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'aborted'));
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}
