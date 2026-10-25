// VirusTotal (ADR-046): a file's SHA-256 is looked up; a file VirusTotal has never seen can be sent
// whole for analysis. Which files, how often, and what a verdict means is services/virustotal.ts.
// `HttpVirusTotal` is the API v3 with the owner's key; `MockVirusTotal` answers from a fixed list.

export interface VtReport {
  malicious: number;
  suspicious: number;
  /** Engines that gave an answer (malicious + suspicious + undetected + harmless). */
  engines: number;
  label: string | null;
}

/** `rate`: over the key's quota (HTTP 429). `auth`: the key is wrong or blocked. */
export class VtError extends Error {
  constructor(
    readonly kind: 'rate' | 'auth' | 'http',
    message: string,
  ) {
    super(message);
  }
}

export interface VirusTotal {
  readonly name: string;
  /** Whether requests count against a quota (the real key: 4 a minute, 500 a day when free). */
  readonly metered: boolean;
  /** The last analysis of this hash, or `unknown` when VirusTotal has never seen the file. */
  lookup(sha256: string): Promise<VtReport | 'unknown'>;
  /** Sends the file for analysis; the result is the analysis id to `analysis()` later. */
  upload(file: Uint8Array, filename: string): Promise<string>;
  /** `null` while the analysis is queued or running. */
  analysis(id: string): Promise<VtReport | null>;
}

const API = 'https://www.virustotal.com/api/v3';

interface Stats {
  malicious?: number;
  suspicious?: number;
  undetected?: number;
  harmless?: number;
}

function report(stats: Stats | undefined, label: string | null): VtReport {
  const s = stats ?? {};
  const malicious = s.malicious ?? 0;
  const suspicious = s.suspicious ?? 0;
  return {
    malicious,
    suspicious,
    engines: malicious + suspicious + (s.undetected ?? 0) + (s.harmless ?? 0),
    label,
  };
}

export class HttpVirusTotal implements VirusTotal {
  readonly name = 'virustotal';
  readonly metered = true;
  constructor(
    private apiKey: string,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-apikey', this.apiKey);
    headers.set('accept', 'application/json');
    const res = await this.fetcher(`${API}${path}`, { ...init, headers });
    if (res.status === 429) throw new VtError('rate', 'VirusTotal quota exceeded');
    if (res.status === 401 || res.status === 403)
      throw new VtError('auth', `VirusTotal refused the key (HTTP ${res.status})`);
    return res;
  }

  async lookup(sha256: string): Promise<VtReport | 'unknown'> {
    const res = await this.call(`/files/${sha256}`);
    if (res.status === 404) return 'unknown';
    if (!res.ok) throw new VtError('http', `VirusTotal lookup HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: {
        attributes?: {
          last_analysis_stats?: Stats;
          popular_threat_classification?: { suggested_threat_label?: string };
        };
      };
    };
    const a = body.data?.attributes;
    return report(
      a?.last_analysis_stats,
      a?.popular_threat_classification?.suggested_threat_label ?? null,
    );
  }

  async upload(file: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([file], { type: 'application/octet-stream' }), filename);
    const res = await this.call('/files', { method: 'POST', body: form });
    if (!res.ok) throw new VtError('http', `VirusTotal upload HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: string } };
    if (!body.data?.id) throw new VtError('http', 'VirusTotal upload: no analysis id');
    return body.data.id;
  }

  async analysis(id: string): Promise<VtReport | null> {
    const res = await this.call(`/analyses/${encodeURIComponent(id)}`);
    if (!res.ok) throw new VtError('http', `VirusTotal analysis HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { attributes?: { status?: string; stats?: Stats } };
    };
    const a = body.data?.attributes;
    if (a?.status !== 'completed') return null;
    return report(a.stats, null);
  }
}

/** The EICAR test file's SHA-256: every engine knows it. */
export const EICAR_SHA256 = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f';
/** Files containing this are "malicious" once uploaded to the mock (tests, dev). */
export const MOCK_VT_MARKER = 'ZEIKO-VIRUSTOTAL-MOCK-MALWARE';

/**
 * Dev and tests: hashes in `known` (EICAR by default) are malicious, every other hash is unknown,
 * and an upload is malicious when the file contains MOCK_VT_MARKER. The analysis is ready at once.
 */
export class MockVirusTotal implements VirusTotal {
  readonly name = 'mock';
  readonly metered = false;
  readonly uploads: string[] = [];
  constructor(private known = new Set([EICAR_SHA256])) {}

  lookup(sha256: string): Promise<VtReport | 'unknown'> {
    return Promise.resolve(
      this.known.has(sha256)
        ? { malicious: 60, suspicious: 0, engines: 70, label: 'mock.malware' }
        : 'unknown',
    );
  }

  upload(file: Uint8Array, filename: string): Promise<string> {
    this.uploads.push(filename);
    const text = new TextDecoder('latin1').decode(file);
    return Promise.resolve(`mock:${text.includes(MOCK_VT_MARKER) ? 'bad' : 'ok'}`);
  }

  analysis(id: string): Promise<VtReport | null> {
    return Promise.resolve(
      id === 'mock:bad'
        ? { malicious: 40, suspicious: 0, engines: 70, label: 'mock.uploaded' }
        : { malicious: 0, suspicious: 0, engines: 70, label: null },
    );
  }
}
