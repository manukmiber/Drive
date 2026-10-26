// The relay's side of Drive (ADR-036, ADR-057): the ops API with the key the relay holds.
import type { DevRuntime } from '../../dev/env';
import { APP } from './runtime';

export const OPS_KEY = 'ops-key-for-tests-0123456789abcdef';

/** `ops('POST', '/reports/…', body)` → `/api/ops/reports/…` with the ops bearer. */
export function opsCall(rt: DevRuntime) {
  return (method: string, path: string, body?: unknown) =>
    rt.fetch(
      new Request(`${APP}/api/ops${path}`, {
        method,
        headers: { authorization: `Bearer ${OPS_KEY}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

/** The relay's operator: gives the runtime the ops key, then calls the ops API with it. */
export function operator(rt: DevRuntime): ReturnType<typeof opsCall> {
  rt.env.ZEIKO_OPS_TOKEN = OPS_KEY;
  return opsCall(rt);
}

/** A creative image as the relay sends it: base64 in JSON (its forwarder carries JSON only). */
export const imageBody = (advertiserId: string, bytes: Uint8Array) => ({
  advertiserId,
  imageBase64: Buffer.from(bytes).toString('base64'),
});
