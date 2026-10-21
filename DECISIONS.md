# DECISIONS — Zeiko Cloud Storage

Format ADR singkat: **Konteks → Keputusan → Konsekuensi**. Nomor tidak pernah dipakai ulang.
Sumber kebenaran fitur tetap `docs/SPEC.md`; file ini mencatat penyimpangan dan pilihan teknis.

Docs Cloudflare dicek 2026-10-21 lewat MCP dokumentasi Cloudflare.

---

## ADR-001 — Runtime lokal tanpa workerd (shim binding di Node)
- **Konteks:** Mesin pengembangan saat ini adalah HP Android (PRoot, aarch64). `workerd` gagal start
  (tcmalloc butuh 48-bit virtual address space), sehingga `wrangler dev`, Miniflare,
  `@cloudflare/vite-plugin` (mode dev) dan `@cloudflare/vitest-pool-workers` tidak bisa jalan di sini.
- **Keputusan:** Kode Worker ditulis murni Web API (tanpa API Node) dan dijalankan lokal di Node lewat
  shim binding buatan sendiri di `dev/`: D1 (di atas `node:sqlite`, FTS5 tersedia), R2 (filesystem,
  termasuk multipart + Range), KV, Queues (in-process, dengan retry), Rate Limiting, Analytics Engine,
  Images/Media/Email (mock). Test Vitest memakai shim yang sama. `npm run dev` = API Node (port 8790)
  + Vite (port 5173, proxy ke API).
- **Konsekuensi:** Perilaku shim bisa berbeda tipis dari produksi. Mitigasi: shim mengikuti kontrak
  docs (mis. `meta.changes`, part multipart seragam, auto-abort), CI menjalankan
  `wrangler deploy --dry-run` untuk memastikan bundle valid di workerd, dan job CI terpisah untuk
  `vitest-pool-workers` bisa ditambahkan nanti di runner x64. Port 8787 sengaja dihindari (dipakai
  layanan lain di mesin ini).

## ADR-002 — Index D1 sebagai sumber kebenaran (bukan index.txt)
- **Konteks:** Diagram meminta index.txt per folder user di R2. Rawan race condition dan lambat.
- **Keputusan:** Index = tabel `nodes` + `blobs` di D1. Manifest `u/{userId}/index.json` dibuat ulang
  otomatis (debounce ≤ 1×/jam per user yang berubah) dan saat ekspor data. (Sesuai Bagian 3 spec.)
- **Konsekuensi:** Rename/move/pindah ruang cukup update D1. Penghapusan objek R2 selalu lewat
  refcount blob.

## ADR-003 — Images binding: input maksimal 20 MB
- **Konteks:** Docs Images: "maximum input size for `.input()` is 20 MB". Spec tidak menyebut batas ini.
- **Keputusan:** Kompres gambar > 20 MB (atau format yang tidak didukung) dialihkan ke Container `media`
  (libvips/ffmpeg). Batas disimpan di config `images_binding_max_input_bytes` (default 20 MB).
- **Konsekuensi:** Biaya Container untuk gambar besar dicatat terpisah, sama seperti video panjang.

## ADR-004 — Rate Limiting binding hanya untuk burst; kuota harian di D1
- **Konteks:** Rate Limiting binding: `period` hanya 10 atau 60 detik, hitungan per lokasi Cloudflare dan
  bersifat perkiraan.
- **Keputusan:** Binding dipakai untuk limit burst (login/OTP, init upload, buat/kirim share, download per
  IP per link, booking iklan, laporan). Limit berjangka panjang (mis. 20 email share/hari/user,
  pindah keluarga 1×/12 bulan) dihitung di D1 (tabel `usage_counters`).
- **Konsekuensi:** Satu tabel tambahan di luar draf Bagian 4.

## ADR-005 — Tidak ada zstd di CompressionStream Workers
- **Konteks:** `@cloudflare/workers-types` 5.20261021: `CompressionStream(format: "gzip" | "deflate" | "deflate-raw")`.
- **Keputusan:** TAR.ZST selalu job async di Container `archiver` (sesuai spec). ZIP deflate ≤ 2 GB
  di-stream dengan `CompressionStream('deflate-raw')`.

## ADR-006 — Batas body request & ukuran part
- **Konteks:** Body request Workers: Free/Pro 100 MB, Business 200 MB, Enterprise ≤ 5 GB. R2 multipart:
  part 5 MiB–5 GiB, semua part kecuali terakhir sama besar, maks 10.000 part, auto-abort 7 hari.
- **Keputusan:** Rumus spec dipertahankan: `partSize = clamp(ceilToMiB(size/10000), 16 MiB, 64 MiB)`
  (aman di bawah 100 MB). Upload `simple` ≤ 16 MiB. Baris `uploads.expires_at` = +6 hari.

## ADR-007 — Cache edge download dibatasi
- **Konteks:** Batas cache CDN 512 MB (Free/Pro/Business), 5 GB Enterprise.
- **Keputusan:** Cache API untuk blob hanya kalau ukuran ≤ config `download_edge_cache_max_bytes`
  (default 256 MiB) dan fitur `download_edge_cache` aktif (default OFF sampai diukur).

## ADR-008 — Waktu = integer milidetik epoch UTC
- **Keputusan:** Semua kolom `*_at`/`expires_at` bertipe INTEGER (ms sejak epoch, UTC), cocok dengan
  Drizzle `timestamp_ms` dan Better Auth. Konversi WIB hanya di lapisan tampilan/tagihan/cron
  (`src/shared/time.ts`).

## ADR-009 — Format ID
- **Keputusan:** ID internal = ULID (implementasi sendiri, CSPRNG, 26 karakter Crockford base32).
  ID share = 64 karakter base62 CSPRNG (r64), tanda tangan s32 = base62(HMAC-SHA256) dipotong 32.
  Nomor invoice `ZK-YYYYMM-000001` dari counter D1.

## ADR-010 — TypeScript 6.0, bukan 7
- **Konteks:** TypeScript 7.0 (native) sudah rilis, tetapi `typescript-eslint` 8.72 mensyaratkan
  `typescript < 6.1`.
- **Keputusan:** Pakai TypeScript 6.0.x sampai typescript-eslint mendukung 7.

## ADR-011 — Skema Drizzle + migrasi SQL
- **Keputusan:** `src/worker/db/schema.ts` (Drizzle) adalah definisi tabel. Migrasi SQL di `migrations/`
  ditulis tangan agar FTS5, trigger, partial unique index dan CHECK terkontrol penuh, lalu test
  `tests/integration/schema.test.ts` memastikan kolom Drizzle == kolom hasil migrasi.
  Sebelum deploy remote pertama, migrasi awal boleh diubah; setelah itu **append-only**.

## ADR-012 — Pesan Queue hanya berisi ID
- **Konteks:** Batas body pesan Queue 128 KB.
- **Keputusan:** Pesan berisi `{ type, ids, attempt meta }` saja; data dibaca ulang dari D1 di consumer
  (idempotent).

## ADR-013 — Email Service memakai builder API
- **Konteks:** Binding `send_email` mendukung `env.EMAIL.send({ from, to, subject, html, text, replyTo })`
  dan mengembalikan `{ messageId }`. Kirim ke alamat sembarang butuh Workers Paid + domain onboarded.
- **Keputusan:** Adapter `EmailSender` (`cloudflare` | `mock`) memakai builder API, bukan MIME mentah.

## ADR-014 — Media Transformations hanya klip pendek
- **Konteks:** Input < 100 MB, durasi input ≤ 10 menit, output ≤ 1 menit. Binding `media` → `env.MEDIA.input(stream).transform().output({ mode: "video" })`.
- **Keputusan:** Video ≤ 60 detik **dan** < 100 MB → Media binding. Selain itu → Container `media`
  (ffmpeg). Durasi dibaca dulu (probe) sebelum memilih engine.

## ADR-015 — Ukuran instance Container
- **Konteks:** `standard-1` = 1/2 vCPU, 4 GiB RAM, 8 GB disk. Custom instance minimal 1 vCPU, ≥ 3 GiB/vCPU.
- **Keputusan:** `scanner` = `standard-1` (ClamAV butuh RAM ≥ 4 GiB). `media` dan `archiver` =
  `standard-2` (bisa dinaikkan via config deploy).

## ADR-016 — Worker-first untuk semua path
- **Konteks:** Link share `/{r64}/{s32}/{nama}` tidak bisa diekspresikan sebagai glob `run_worker_first`,
  dan host `USERCONTENT_ORIGIN` tidak boleh menyajikan apa pun selain pratinjau.
- **Keputusan:** `assets.run_worker_first = true`; Worker meneruskan path non-API ke `env.ASSETS`
  (SPA fallback) dan menambahkan CSP/header keamanan pada HTML.
- **Konsekuensi:** Setiap request aset dihitung sebagai request Worker (biaya kecil; aset ber-hash
  di-cache browser).

## ADR-017 — Batas Rate Limiting binding adalah konfigurasi deploy
- **Konteks:** Spec meminta semua limit bisa diubah dari admin, tetapi `limit`/`period` binding ditetapkan
  di `wrangler.jsonc`.
- **Keputusan:** Limit burst (binding) diubah lewat `wrangler.jsonc` + deploy. Limit jangka panjang yang
  bisa diatur admin ada di `app_config` dan dihitung di D1 (ADR-004).

## ADR-018 — Tarif komponen untuk dashboard biaya
- **Keputusan:** `component_tariffs_usd` di config berisi tarif awal (R2 Class A $4,50/juta, Class B
  $0,36/juta, Workers $0,30/juta request, CPU $0,02/juta ms, D1 baca $0,001/juta baris, tulis $1/juta
  baris, Containers per vCPU-detik/GiB-detik). Nilai D1 terverifikasi di docs 2026-10-21; sisanya
  wajib dicek ulang di docs sebelum dashboard Fase 11 dipakai untuk keputusan bisnis.
