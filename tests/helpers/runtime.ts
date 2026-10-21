import { afterEach } from 'vitest';
import { createDevRuntime, type DevRuntime, type DevRuntimeOptions } from '../../dev/env';

const open: DevRuntime[] = [];

/** Fresh in-memory runtime per test (D1 in :memory:, R2 in a temp dir, manual queues). */
export async function makeRuntime(opts: DevRuntimeOptions = {}): Promise<DevRuntime> {
  const rt = await createDevRuntime(opts);
  open.push(rt);
  return rt;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

export const APP = 'http://localhost:5173';

export function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${APP}${path}`, {
    method,
    headers: { origin: APP, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
