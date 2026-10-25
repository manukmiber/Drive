import { describe, expect, it } from 'vitest';
import { HttpVirusTotal, VtError } from '../../src/worker/adapters/virustotal';
import { vtKind } from '../../src/worker/services/virustotal';

/** A fetch that answers from a table and remembers what it was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      key: new Headers(init?.headers).get('x-apikey'),
      body: init?.body,
    });
    const route = routes[`${method} ${url.replace('https://www.virustotal.com/api/v3', '')}`];
    return route ? route() : new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpVirusTotal (API v3)', () => {
  it('reads a file report, and says unknown for a hash it has never seen', async () => {
    const { fetcher, calls } = fakeFetch({
      'GET /files/aaa': () =>
        json({
          data: {
            attributes: {
              last_analysis_stats: { malicious: 5, suspicious: 1, undetected: 60, harmless: 0 },
              popular_threat_classification: { suggested_threat_label: 'trojan.agent' },
            },
          },
        }),
      'GET /files/bbb': () => json({ error: { code: 'NotFoundError' } }, 404),
    });
    const vt = new HttpVirusTotal('k3y', fetcher);
    expect(await vt.lookup('aaa')).toEqual({
      malicious: 5,
      suspicious: 1,
      engines: 66,
      label: 'trojan.agent',
    });
    expect(await vt.lookup('bbb')).toBe('unknown');
    expect(calls.every((c) => c.key === 'k3y')).toBe(true);
  });

  it('uploads as multipart form data and reads the analysis once it is completed', async () => {
    let status = 'queued';
    const { fetcher, calls } = fakeFetch({
      'POST /files': () => json({ data: { type: 'analysis', id: 'an-1' } }),
      'GET /analyses/an-1': () =>
        json({ data: { attributes: { status, stats: { malicious: 0, undetected: 70 } } } }),
    });
    const vt = new HttpVirusTotal('k3y', fetcher);
    expect(await vt.upload(new TextEncoder().encode('MZ'), 'file.exe')).toBe('an-1');
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('file') as File;
    expect(file.name).toBe('file.exe');
    expect(await file.text()).toBe('MZ');
    expect(await vt.analysis('an-1')).toBeNull();
    status = 'completed';
    expect(await vt.analysis('an-1')).toEqual({
      malicious: 0,
      suspicious: 0,
      engines: 70,
      label: null,
    });
  });

  it('turns quota and key refusals into typed errors', async () => {
    const { fetcher } = fakeFetch({
      'GET /files/rate': () => json({ error: { code: 'QuotaExceededError' } }, 429),
      'GET /files/key': () => json({ error: { code: 'WrongCredentialsError' } }, 401),
    });
    const vt = new HttpVirusTotal('k3y', fetcher);
    await expect(vt.lookup('rate')).rejects.toMatchObject({ kind: 'rate' });
    await expect(vt.lookup('key')).rejects.toBeInstanceOf(VtError);
    await expect(vt.lookup('key')).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('vtKind', () => {
  it.each<[string, string | null, string | null]>([
    ['Setup.EXE', null, 'executable'],
    ['game/app-release.apk', null, 'executable'],
    ['surat.docm', null, 'macro'],
    ['deploy.ps1', null, 'script'],
    ['backup.zip', null, 'archive'],
    ['rapor.pdf', null, 'document'],
    ['no-extension', 'application/x-msdownload', 'executable'],
    ['scan', 'application/pdf', 'document'],
    ['foto.jpg', 'image/jpeg', null],
    ['main.js', null, null],
    ['.exe', null, null],
  ])('%s (%s) → %s', (name, mime, kind) => {
    expect(vtKind(name, mime)).toBe(kind);
  });
});
