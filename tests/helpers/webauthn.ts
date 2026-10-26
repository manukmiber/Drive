// A software passkey for tests: an ES256 key the "authenticator" signs assertions with, stored the
// way @better-auth/passkey stores a registered one (COSE public key, base64).
import { base64 } from '@better-auth/utils/base64';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { DevRuntime } from '../../dev/env';

export interface SoftPasskey {
  credentialId: string;
  /** Signs an assertion for `challenge` at `origin` (rpID = the origin's host). */
  assert(challenge: string, origin: string, counter?: number): Promise<Record<string, unknown>>;
}

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
}

/** WebCrypto gives ECDSA as r‖s; WebAuthn wants it DER-encoded. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0]! & 0x80 ? Uint8Array.from([0, ...v]) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([
    0x30,
    r.length + s.length + 4,
    0x02,
    r.length,
    ...r,
    0x02,
    s.length,
    ...s,
  ]);
}

/** Makes a passkey and stores it for `userId`, as a finished registration would. */
export async function addSoftPasskey(rt: DevRuntime, userId: string): Promise<SoftPasskey> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.slice(1, 33)],
      [-3, raw.slice(33)],
    ]),
  );
  const credentialId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
  rt.d1.sqlite
    .prepare(
      `INSERT INTO passkeys (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at)
       VALUES (?, 'test', ?, ?, ?, 0, 'singleDevice', 0, 'internal', ?)`,
    )
    .run(`pk_${credentialId}`, base64.encode(cose), userId, credentialId, Date.now());
  return {
    credentialId,
    async assert(challenge, origin, counter = 1) {
      const clientData = enc.encode(
        JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
      );
      const authData = Uint8Array.from([
        ...(await sha256(enc.encode(new URL(origin).hostname))),
        0x05, // user present + verified
        (counter >>> 24) & 0xff,
        (counter >>> 16) & 0xff,
        (counter >>> 8) & 0xff,
        counter & 0xff,
      ]);
      const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(clientData)),
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature: isoBase64URL.fromBuffer(new Uint8Array(der(sig))),
        },
      };
    },
  };
}
