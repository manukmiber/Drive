# CLAUDE.md — aturan proyek Zeiko Drive (dulu Zeiko Cloud Storage)

Baca dulu: `docs/SPEC.md` (sumber kebenaran), `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`.

## Mesin ini
- HP Android (PRoot, aarch64). **workerd tidak bisa jalan** → jangan pakai `wrangler dev`,
  Miniflare, atau `vitest-pool-workers` lokal (ADR-001).
- Pakai Node Linux: `export PATH=/opt/node22/bin:$PATH` sebelum `npm`. Node Termux (`/data/data/com.termux/...`)
  melaporkan platform `android` dan merusak paket native.
- Wrangler remote (deploy, d1 remote, secret): `cfwrangler ...` atau `npx wrangler ...` dengan PATH di atas.
- Port 8787 dipakai layanan lain di mesin ini — jangan dimatikan. Dev API memakai 8790, Vite 5173.

## Perintah
| Tujuan | Perintah |
|---|---|
| Dev lokal (API + web, semua adapter mock) | `npm run dev` |
| Reset data lokal (DB, R2, KV) | `npm run dev:reset` |
| Lint / typecheck / test | `npm run lint` · `npm run typecheck` · `npm test` |
| Semua cek | `npm run check` |
| Build SPA | `npm run build` |
| Bundle check (seperti CI) | `npm run deploy:dry` |
| Deploy staging | `npm run deploy:staging` (butuh izin pemilik untuk pertama kali) |
| Migrasi remote | `npm run db:migrate:staging` |

Buka app lewat **http://localhost:5173/** (bukan IP LAN): cookie `__Host-` butuh origin
aman, dan browser hanya menganggap `localhost` aman tanpa HTTPS. Di production app ada di root
**drive.zeiko.biz.id** (ADR-038; `/dashboard/…` hanya jalan pulang dari website); landing, harga, dan
deskripsi produk ada di website (`proxychat`, zeiko.biz.id/drive). Drive dibayar dengan **QRIS saja**, per
pembelian, tanpa Saldo dan tanpa perpanjangan otomatis; notifikasi lewat email + lonceng; lokasi iklan dari
kota di Akun Zeiko; iklan dipesan dan dibayar lewat email: operator memasukkan kampanyenya di Admin → Iklan,
cek manual, dan begitu disetujui QRIS-nya dikirim ke email pengiklan (/iklan hanya statistik); tanpa batas slot,
rotasi 15 detik (ADR-041, ADR-043). Login lewat Akun Zeiko:
di dev, "Masuk dengan Akun Zeiko" membuka pintu tiruan `/__dev/door/account/signin` untuk memilih akun
demo `demo@zeiko.local` (Plus), `admin@zeiko.local` (admin, Max), atau `baru@zeiko.local` (tanpa paket).

**Sesi pintu (`zk_auth`) yang menentukan** (ADR-039): Drive keluar kalau pintu bilang keluar, dan pindah
akun kalau pintu bilang orang lain (`src/web/lib/door-sync.ts`). Login dari Drive pulang langsung ke
`https://drive.zeiko.biz.id/masuk?next=…`.

**Zeiko S3** (ADR-044) ada di Worker yang sama, di host `S3_ORIGIN` (dev `http://s3.localhost:8790`,
production `https://s3.zeiko.biz.id`): API S3 asli (SigV4), `routes/s3-api.ts` + `services/s3*.ts`. Akun S3 =
user Drive + baris `s3_accounts`, dibuat saat membeli paket di `/s3` (ADR-047) atau dinyalakan operator lewat ops
API (`/api/ops/s3/*`); key dan bucket di halaman `/s3`. Index objek per akun di D1 sendiri (`S3_DB_*`, daftar di
`deploy/{env}.json` → `s3Indexes`), atau di D1 utama kalau belum ada; tabelnya dibuat `services/s3-index.ts`, bukan
`migrations/`. Coba lokal: `curl http://s3.localhost:8790/` atau `aws --endpoint-url http://s3.localhost:8790 s3 ls`
(key dari `/s3` setelah membeli paket). ToS dan Kebijakan Privasi pemilik ada di `src/web/legal/` (ADR-045): teks
Indonesia kata per kata, jangan diubah tanpa pemilik; kontak di `contacts.ts`. **Paket S3 dibayar di awal**
(ADR-047, `services/s3-billing.ts`): minimal 3 GB, 1 salinan Rp500/GB atau 3 salinan Rp1.500/GB per bulan, egress
lebih ditagih saat perpanjangan. 3 salinan = salinan sungguhan di `S3_REPLICA_A/B` (`services/s3-replicas.ts`);
jangan pernah menjual atau menyebut jumlah salinan yang tidak benar-benar disimpan. **Alamat sendiri** (ADR-048,
`services/s3-urls.ts`, adapter `hostnames`): `s3.<nama>.zeiko.biz.id` Rp3.000 atau domain sendiri Rp5.000, sekali bayar,
hanya melayani akun pemiliknya, dilepas kalau paket tidak dibayar 30 hari. Di dev: `s3.<nama>.localhost:8790`.

**Fitur yang belum siap disembunyikan** (ADR-049): `services/readiness.ts` memutuskan fitur mana yang jalan (dan apa
yang masih kurang, untuk tab Features di relay); aplikasi membaca `capabilities` dari `/api/public/catalog`. Fitur baru
yang butuh secret/binding/DNS pemilik didaftarkan di sana dan disembunyikan sampai siap, tidak ditampilkan mati.

Data dev ada di `.dev/` (di-ignore git). Mailbox mock: `GET http://localhost:8790/__dev/mail`.
Picu cron lokal: `POST http://localhost:8790/__dev/cron?cron=0%20*%20*%20*%20*`.

## Konvensi
- TypeScript strict. Tidak ada `any` tanpa komentar alasan.
- Kode/komentar English. **Semua UI dua bahasa** (ADR-036): string ada di `src/shared/strings.id.ts`
  (santai & sopan) dan `src/shared/strings.en.ts` (kunci sama, dicek oleh tipe). Jangan menulis teks UI
  langsung di komponen. Web memakai `t` dari `src/web/lib/i18n.ts` (bahasa dari cookie `zk_lang`), halaman
  Worker memakai `requestLang` + `strings()` dari `src/worker/lib/lang.ts`.
- Path halaman app selalu lewat `appPath`/`appUrl` (`src/worker/lib/paths.ts`), karena SPA ada di
  `APP_BASE_PATH`.
- Waktu = integer ms UTC (ADR-008). Uang = integer Rupiah. Ukuran = integer byte, GB = 2^30.
- Angka bisnis (harga, kuota, limit, masa tenggang) **tidak di-hardcode**: baca dari
  `app_config`/tabel katalog via `services/config.ts`. Default ada di `src/shared/config-defaults.ts`.
- Pihak ketiga selalu lewat `src/worker/adapters/*` dengan implementasi `mock`.
- Route tipis; logika di `services/` (bisa dites tanpa HTTP).
- Kode Worker hanya Web API — tidak boleh import `node:*` di `src/worker` atau `src/shared`.
- Setiap query data user di-scope `pool_id`/`owner_id`; cek izin node di service, bukan di route.
- Commit: Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`), per fase/sub-fase.
- Migrasi: sebelum deploy remote pertama boleh diubah; setelahnya **append-only** (file baru).
- Fitur di luar spec → catat dulu di `DECISIONS.md`.

## Larangan
- Jangan commit secret. Pakai `wrangler secret put` dan `.dev.vars` (di-ignore).
- Jangan kirim isi file user ke layanan luar mana pun. Satu-satunya pengecualian (pemilik, 2026-10-25, ADR-046):
  program dan dokumen ber-macro yang belum dikenal VirusTotal dikirim ke VirusTotal (`services/virustotal.ts`).
  Jangan menambah tipe atau layanan lain tanpa pemilik.
- Jangan beri klien kredensial S3 atau presigned URL **R2**. (Key Zeiko S3 milik Zeiko sendiri dan dicek Worker,
  ADR-044; itu boleh.)
- Jangan dedup blob lintas pool/user.
- Jangan pasang iklan di jalur upload/download.
- Jangan deploy production, hapus resource remote, atau kirim pesan ke nomor/email sungguhan tanpa
  persetujuan pemilik.
