// Drive index bench (ADR-064): size on the wire and CPU per operation for synthetic trees.
// Run: npm run bench:index. Numbers depend on the machine; the Worker runs on faster CPUs.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import {
  newIndexHead,
  parseIndex,
  serializeIndex,
  type IndexEntry,
} from '../src/shared/drive-index';
import { IndexDoc } from '../src/worker/services/drive-index';

const WORDS =
  'Laporan Keuangan Foto Liburan Bali Tugas Kuliah Skripsi Revisi final Invoice Kontrak Rapat Notulen Desain Logo Video Nikahan Proposal Data'.split(
    ' ',
  );
const TYPES: Array<[string, string, number]> = [
  ['jpg', 'image/jpeg', 0.45],
  ['png', 'image/png', 0.1],
  ['mp4', 'video/mp4', 0.08],
  ['pdf', 'application/pdf', 0.15],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 0.08],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 0.05],
  ['zip', 'application/zip', 0.04],
  ['txt', 'text/plain', 0.05],
];

function tree(n: number): IndexEntry[] {
  let seed = n;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const word = () => WORDS[Math.floor(rnd() * WORDS.length)]!;
  const folders = [0];
  const out: IndexEntry[] = [];
  let t = Date.parse('2025-02-20T00:00:00Z');
  for (let id = 1; id <= n; id++) {
    t += Math.floor(rnd() * 600_000);
    const parent = folders[Math.floor(rnd() * folders.length)]!;
    const base = {
      id,
      parent,
      legacy: '',
      status: 'ready',
      created: t,
      updated: rnd() < 0.9 ? t : t + 100_000,
      trashedAt: null,
      trashRoot: 0,
      decor: null,
      owner: 0,
      canEdit: false,
      trashedBy: 0,
      starred: rnd() < 0.03,
    } as const;
    if (rnd() < 0.05) {
      folders.push(id);
      out.push({
        ...base,
        kind: 'folder',
        name: `${word()} ${2020 + Math.floor(rnd() * 7)}`,
        size: 0,
        mime: '',
        blob: 0,
        clientModified: null,
        thumb: false,
      });
      continue;
    }
    let x = rnd();
    const [ext, mime] = TYPES.find(([, , w]) => (x -= w) <= 0) ?? TYPES[0]!;
    const name =
      ext === 'jpg' && rnd() < 0.7
        ? `IMG_2026${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}_${String(Math.floor(rnd() * 240000)).padStart(6, '0')}.jpg`
        : `${word()} ${word()} ${Math.floor(rnd() * 100)}.${ext}`;
    out.push({
      ...base,
      kind: 'file',
      name,
      size: Math.floor(rnd() ** 3 * 50_000_000) + 1000,
      mime,
      blob: id,
      clientModified: t - Math.floor(rnd() * 1e9),
      thumb: mime.startsWith('image/') || mime.startsWith('video/'),
    });
  }
  return out;
}

function ms(fn: () => unknown, reps: number): string {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return ((performance.now() - t0) / reps).toFixed(2);
}
const kb = (b: number) => `${Math.round(b / 1024)} KB`;

for (const n of [1_000, 10_000, 50_000, 100_000]) {
  const entries = tree(n);
  const text = serializeIndex({ ...newIndexHead(), next: n + 1 }, entries);
  const bytes = Buffer.from(text);
  const reps = n >= 50_000 ? 5 : 20;
  const mid = Math.floor(n / 2);
  const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  console.log(
    `\n${n} entries: ${kb(bytes.length)} stored, ${kb(gzipSync(bytes).length)} gzip, ${kb(br.length)} brotli on the wire`,
  );
  console.log(`  client, parse all            ${ms(() => parseIndex(text), reps)} ms`);
  console.log(
    `  worker, open + rename one    ${ms(() => {
      const d = IndexDoc.parse(text);
      const e = d.get(mid)!;
      d.set({ ...e, name: 'baru.jpg' });
      return d.toText();
    }, reps)} ms`,
  );
  console.log(
    `  worker, open + add one       ${ms(() => {
      const d = IndexDoc.parse(text);
      d.set({ ...entries[mid]!, id: d.allocate() });
      return d.toText();
    }, reps)} ms`,
  );
  console.log(
    `  worker, tree shape (parents) ${ms(() => IndexDoc.parse(text).parents(), reps)} ms`,
  );
  console.log(
    `  worker, move 100 entries     ${ms(() => {
      const d = IndexDoc.parse(text);
      for (let i = 1; i <= 100; i++) d.set({ ...entries[i * Math.floor(n / 101)]!, parent: 0 });
      return d.toText();
    }, reps)} ms`,
  );
}
