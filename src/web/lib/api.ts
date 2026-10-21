// Thin fetch wrapper for the Zeiko API. Errors arrive as { error: { code, message, data } }.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const CSRF_COOKIE = '__Host-zk.csrf';

function csrfToken(): string | null {
  const m = new RegExp(`(?:^|; )${CSRF_COOKIE.replace('.', '\\.')}=([^;]+)`).exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) headers.set('x-csrf-token', token);
  }
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string; data?: Record<string, unknown> };
  } | null;
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'INTERNAL', e?.message ?? res.statusText, e?.data);
  }
  return body as T;
}

export const postJson = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });

export const sendJson = <T>(
  method: 'PATCH' | 'PUT' | 'DELETE' | 'POST',
  path: string,
  data?: unknown,
) => api<T>(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
