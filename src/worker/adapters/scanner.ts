// Scanner adapter chain (SPEC §14.2). The file content never leaves our infrastructure.
// `mock`: streams the object once, computes SHA-256 + CRC32, flags the EICAR test string.
// `container`: Container `scanner` (ClamAV + hashing) — wired in Fase 3.
import { Crc32 } from '../lib/crc32';
import { Sha256 } from '../lib/sha256';
import { sniffMime } from '../lib/sniff';

export interface ScanInput {
  key: string;
  size: number;
  /** Files above this size are hashed but not virus-scanned (status `skipped`). */
  maxScanBytes: number;
}

export interface ScanResult {
  status: 'clean' | 'infected' | 'skipped' | 'error';
  sha256: string | null;
  crc32: number | null;
  sniffedMime: string | null;
  detail: string | null;
}

export interface Scanner {
  readonly name: string;
  scan(input: ScanInput): Promise<ScanResult>;
}

const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

export class MockScanner implements Scanner {
  readonly name = 'mock';
  constructor(private bucket: R2Bucket) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const obj = await this.bucket.get(input.key);
    if (!obj)
      return {
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: 'object missing',
      };
    const sha = new Sha256();
    const crc = new Crc32();
    let head = new Uint8Array(0);
    const reader = obj.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sha.update(value);
      crc.update(value);
      if (head.length < 4096) {
        const merged = new Uint8Array(Math.min(4096, head.length + value.length));
        merged.set(head);
        merged.set(value.subarray(0, merged.length - head.length), head.length);
        head = merged;
      }
    }
    const headText = new TextDecoder('latin1').decode(head);
    const infected = headText.includes(EICAR);
    const status = infected ? 'infected' : input.size > input.maxScanBytes ? 'skipped' : 'clean';
    return {
      status,
      sha256: sha.hex(),
      crc32: crc.digest(),
      sniffedMime: sniffMime(head),
      detail: infected ? 'Eicar-Test-Signature' : status === 'skipped' ? 'too large' : null,
    };
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Container scanner: the Worker streams the R2 object into Container `scanner` once; the container
 * hashes it and (≤ maxScanBytes) pipes it through clamd. Instances are picked at random to spread
 * load across `instances` Durable Objects.
 */
export class ContainerScanner implements Scanner {
  readonly name = 'container';
  constructor(
    private bucket: R2Bucket,
    private ns: DurableObjectNamespace,
    private instances = 3,
  ) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const obj = await this.bucket.get(input.key);
    if (!obj)
      return {
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: 'object missing',
      };
    const doScan = input.size <= input.maxScanBytes;
    const stub = this.ns.get(
      this.ns.idFromName(`scanner-${Math.floor(Math.random() * this.instances)}`),
    );
    let res: Response;
    try {
      res = await stub.fetch(`http://scanner/scan?scan=${doScan ? 1 : 0}`, {
        method: 'POST',
        body: obj.body,
        headers: { 'content-length': String(input.size) },
      });
    } catch (e) {
      return {
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: `container: ${String(e)}`,
      };
    }
    if (!res.ok)
      return {
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: `container HTTP ${res.status}`,
      };
    const r = (await res.json()) as {
      sha256: string;
      crc32: number;
      size: number;
      head: string;
      scanned: boolean;
      infected: boolean;
      virus?: string;
      error?: string;
    };
    if (r.size !== input.size) {
      return {
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: `size mismatch ${r.size}`,
      };
    }
    const base = {
      sha256: r.sha256,
      crc32: r.crc32 >>> 0,
      sniffedMime: sniffMime(b64ToBytes(r.head)),
    };
    if (r.error && doScan) return { status: 'error', ...base, detail: r.error };
    if (r.infected) return { status: 'infected', ...base, detail: r.virus ?? 'malware' };
    return { status: doScan ? 'clean' : 'skipped', ...base, detail: doScan ? null : 'too large' };
  }
}
