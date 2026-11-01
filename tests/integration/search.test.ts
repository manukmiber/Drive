// D6 (ADR-090): search with the box's syntax, a page at a time, and — when the person turns it on —
// inside files, from text their browser took and stored next to their index.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { FakeClock } from '../../src/worker/adapters/clock';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { createFolder, grantPlan, rootOf, uploadText, type NodeJson } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const T0 = Date.UTC(2025, 0, 10, 3); // 10 Jan 2025, 10:00 WIB

interface Found {
  items: Array<{ id: string; name: string }>;
  nextCursor: string | null;
  snippets: Record<string, { text: string; ranges: Array<[number, number]> }>;
  warnings: string[];
  contentSearch: boolean;
}

async function find(s: Session, q: string, extra = ''): Promise<Found> {
  const res = await s.req('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Found;
}
const names = (f: Found) => f.items.map((i) => i.name).sort();

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

const texts = (s: Session, items: Array<{ id: string; text: string }>) =>
  s.req('POST', '/api/drive/texts', undefined, {
    body: items.map((i) => JSON.stringify(i)).join('\n'),
    headers: { 'content-type': 'application/x-ndjson' },
  });

async function setup() {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, 'cari@example.com');
  await grantPlan(rt, s.userId);
  return { rt, s, clock, root: await rootOf(s) };
}

describe('search syntax (D6 part 1)', () => {
  it('reads phrases, exclusions, OR, types, extensions, sizes, dates, folders, stars and shares', async () => {
    const { rt, s, clock, root } = await setup();
    const keu = await createFolder(s, root, 'Keuangan');
    const tahun = await createFolder(s, keu.id, '2024');
    await uploadText(s, tahun.id, 'laporan akhir tahun.txt', 'x'.repeat(2000));
    clock.set(Date.UTC(2025, 2, 5, 3));
    await uploadText(s, root, 'akhir laporan.txt', 'kecil');
    const nota = await uploadText(s, root, 'nota belanja.pdf', 'pdf');
    const kuit = await uploadText(s, keu.id, 'kuitansi listrik.pdf', 'pdf');
    await uploadText(s, root, 'laporan draf.docx', 'draf');
    await rt.settle();

    expect(names(await find(s, '"laporan akhir"'))).toEqual(['laporan akhir tahun.txt']);
    expect(names(await find(s, 'laporan -draf'))).toEqual([
      'akhir laporan.txt',
      'laporan akhir tahun.txt',
    ]);
    expect(names(await find(s, 'nota ATAU kuitansi'))).toEqual([
      'kuitansi listrik.pdf',
      'nota belanja.pdf',
    ]);
    expect(names(await find(s, 'ext:pdf'))).toEqual(['kuitansi listrik.pdf', 'nota belanja.pdf']);
    expect(names(await find(s, 'jenis:folder'))).toEqual(['2024', 'Keuangan']);
    expect(names(await find(s, 'type:folder in:keuangan'))).toEqual(['2024']);
    expect(names(await find(s, 'ukuran:>1kb'))).toEqual(['laporan akhir tahun.txt']);
    expect(names(await find(s, 'size:<10b laporan'))).toEqual([
      'akhir laporan.txt',
      'laporan draf.docx',
    ]);
    expect(names(await find(s, 'di:"Keuangan"'))).toEqual([
      '2024',
      'kuitansi listrik.pdf',
      'laporan akhir tahun.txt',
    ]);
    expect(names(await find(s, 'laporan tanggal:dibuat sebelum:2025-02'))).toEqual([
      'laporan akhir tahun.txt',
    ]);
    expect(names(await find(s, 'laporan date:created after:2025-03-05'))).toEqual([
      'akhir laporan.txt',
      'laporan draf.docx',
    ]);
    expect(names(await find(s, 'lap cocok:kata'))).toEqual([]);
    expect(names(await find(s, 'laporan cocok:kata -draf'))).toHaveLength(2);

    expect((await s.req('PUT', `/api/nodes/${nota.id}/star`)).status).toBe(204);
    expect(names(await find(s, 'berbintang'))).toEqual(['nota belanja.pdf']);
    expect((await s.req('POST', '/api/shares', { nodeIds: [kuit.id] })).status).toBe(201);
    expect(names(await find(s, 'dibagikan'))).toEqual(['kuitansi listrik.pdf']);

    // sort:date puts the newest first.
    const byDate = await find(s, 'laporan urut:tanggal');
    expect(byDate.items.at(-1)!.name).toBe('laporan akhir tahun.txt');

    const odd = await find(s, 'jenis:roket setelah:kemarin nota');
    expect(odd.warnings).toEqual(['jenis:roket', 'setelah:kemarin']);
    expect(names(odd)).toEqual(['nota belanja.pdf']);
    // The old parameters still work.
    expect(names(await find(s, 'keu', '&type=folder'))).toEqual(['Keuangan']);
  });

  it('pages with a cursor that only its own query accepts', async () => {
    const { rt, s, root } = await setup();
    for (let i = 0; i < 60; i++)
      await uploadText(s, root, `foto ${String(i).padStart(2, '0')}.txt`, 'x');
    await rt.settle();
    const first = await find(s, 'foto');
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await find(s, 'foto', `&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(60);
    const other = await s.req('GET', `/api/search?q=lain&cursor=${first.nextCursor}`);
    expect(other.status).toBe(400);

    // Relevance: a whole word beats a prefix, and the whole name beats both, whatever is newer.
    await uploadText(s, root, 'kontrak sewa.txt', 'x');
    await uploadText(s, root, 'kontraktor.txt', 'x');
    await uploadText(s, root, 'kontrak.pdf', 'x');
    await uploadText(s, root, 'subkontraktor kontrakan.txt', 'x');
    await rt.settle();
    const ranked = (await find(s, 'kontrak')).items.map((i) => i.name);
    expect(ranked.slice(0, 2)).toEqual(['kontrak.pdf', 'kontrak sewa.txt']);
    expect(ranked.slice(2).sort()).toEqual(['kontraktor.txt', 'subkontraktor kontrakan.txt']);
  });
});

describe('search file contents (D6 part 2)', () => {
  it('is off until the person turns it on, then finds words inside files with a snippet', async () => {
    const { rt, s, root } = await setup();
    const kontrak = await uploadText(s, root, 'kontrak.txt', 'isi');
    const lain = await uploadText(s, root, 'catatan.txt', 'isi');
    await rt.settle();

    const settings = (await (await s.req('GET', '/api/drive/settings')).json()) as {
      contentSearch: boolean;
    };
    expect(settings.contentSearch).toBe(false);
    expect(
      (await texts(s, [{ id: kontrak.id, text: 'Pihak pertama menyewakan rumah' }])).status,
    ).toBe(409);

    const on = await s.req('PUT', '/api/drive/settings', { contentSearch: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { contentSearch: boolean }).contentSearch).toBe(true);
    const missing = (await (await s.req('GET', '/api/drive/texts/missing')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(missing.items.map((i) => i.id).sort()).toEqual([kontrak.id, lain.id].sort());

    const put = await texts(s, [
      {
        id: kontrak.id,
        text: 'Perjanjian sewa. Pihak pertama menyewakan rumah di Jalan Melati kepada pihak kedua.',
      },
      { id: 'tidak-ada', text: 'x' },
    ]);
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toEqual({ stored: 1, skipped: 1 });

    const found = await find(s, 'melati');
    expect(found.contentSearch).toBe(true);
    expect(names(found)).toEqual(['kontrak.txt']);
    const snip = found.snippets[kontrak.id]!;
    expect(snip.text).toContain('Melati');
    expect(snip.ranges.map(([a, b]) => snip.text.slice(a, b))).toEqual(['Melati']);
    expect(names(await find(s, '"pihak kedua"'))).toEqual(['kontrak.txt']);
    expect(names(await find(s, 'melati -sewa'))).toEqual([]);
    expect(names(await find(s, 'melati jenis:gambar'))).toEqual([]);
    const missingAfter = (await (await s.req('GET', '/api/drive/texts/missing')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(missingAfter.items.map((i) => i.id)).toEqual([lain.id]);

    // Turned off: contents are not searched (the text stays until the file goes).
    await s.req('PUT', '/api/drive/settings', { contentSearch: false });
    expect(names(await find(s, 'melati'))).toEqual([]);
    await s.req('PUT', '/api/drive/settings', { contentSearch: true });

    // New content: the old text no longer describes the file.
    const replaced = await s.req(
      'PUT',
      `/api/uploads/simple?${new URLSearchParams({ parentId: root, name: 'kontrak.txt', size: '4', onConflict: 'replace' })}`,
      undefined,
      {
        body: 'baru',
        headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
      },
    );
    expect(replaced.status).toBe(201);
    await rt.settle();
    expect(names(await find(s, 'melati'))).toEqual([]);

    // Data export carries the text; deleting for good takes it away.
    await texts(s, [{ id: lain.id, text: 'resep rendang padang' }]);
    const exported = (await (await s.req('GET', '/api/me/export')).json()) as {
      searchText: Array<[string, string]>;
    };
    expect(exported.searchText).toEqual([[lain.id, 'resep rendang padang']]);
    expect((await s.req('POST', '/api/nodes/trash', { ids: [lain.id] })).status).toBe(200);
    expect((await s.req('POST', '/api/nodes/delete', { ids: [lain.id] })).status).toBeLessThan(300);
    await rt.idle();
    const obj = await rt.r2.get(`u/${s.userId}/text.txt`);
    expect(obj && 'text' in obj ? await obj.text() : '').not.toContain('rendang');
  });

  it('only takes text from those who may edit the file, and never shows it to anyone else', async () => {
    const { rt, s, root } = await setup();
    const rahasia = await uploadText(s, root, 'surat.txt', 'isi');
    await rt.settle();
    await s.req('PUT', '/api/drive/settings', { contentSearch: true });
    await texts(s, [{ id: rahasia.id, text: 'nomor rekening rahasia sekali' }]);

    const other = await signIn(rt, 'tetangga@example.com');
    await grantPlan(rt, other.userId);
    await other.req('PUT', '/api/drive/settings', { contentSearch: true });
    expect(names(await find(other, 'rekening'))).toEqual([]);
    const poisoned = await texts(other, [{ id: rahasia.id, text: 'kata palsu' }]);
    expect(await poisoned.json()).toEqual({ stored: 0, skipped: 1 });
    expect(names(await find(s, 'palsu'))).toEqual([]);
    expect(await rt.r2.get(`u/${other.userId}/text.txt`)).toBeNull();
  });

  it('refuses text past the space cap, and wants NDJSON', async () => {
    const { rt, s, root } = await setup();
    const a = await uploadText(s, root, 'a.txt', 'a');
    const b = await uploadText(s, root, 'b.txt', 'b');
    await rt.settle();
    await s.req('PUT', '/api/drive/settings', { contentSearch: true });
    setConfig(rt, 'content_index_max_bytes', 64 * 1024);
    setConfig(rt, 'content_text_max_chars', 50_000);
    expect((await texts(s, [{ id: a.id, text: 'x'.repeat(40_000) }])).status).toBe(200);
    const over = await texts(s, [{ id: b.id, text: 'z'.repeat(40_000) }]);
    expect(over.status).toBe(409);
    expect(JSON.stringify(await over.json())).toContain('CONTENT_INDEX_FULL');
    const json = await s.req('POST', '/api/drive/texts', { id: a.id, text: 'x' });
    expect(json.status).toBe(400);
  });
});

export type { NodeJson };
