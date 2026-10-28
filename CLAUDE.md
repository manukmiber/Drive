# CLAUDE.md — aturan proyek Zeiko Drive (dulu Zeiko Cloud Storage)

Baca dulu: `docs/SPEC.md` (sumber kebenaran), `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`.

## Arah arsitektur: Drive tanpa D1 (ADR-064, pemilik 2026-10-26). Baca sebelum menyentuh Drive.
- **Satu user = satu folder R2** (`u/{userId}/`) dengan **satu index** (`u/{userId}/index.txt`): nama file dan struktur
  folder. Paket keluarga: satu folder, satu index (`f/{familyId}/index.txt`) dengan nama file, struktur folder, dan
  kepemilikan. Index = sumber kebenaran pohon file dan hal pertama yang ditarik web, aplikasi, dan software, jadi
  formatnya harus seringan mungkin. Format v1 (R1, ADR-064): header JSON + satu baris JSON per entri, disimpan polos
  (Cloudflare mengompres saat dikirim), diedit per baris lewat `IndexDoc` (`services/drive-index.ts`). Ditulis dengan
  syarat etag R2 lewat `changeIndex`: bentrok → baca ulang, ulangi. R2 hanya menerima **1 tulis/detik per key**: gabung
  perubahan massal jadi satu tulis.
- **Drive tidak memakai D1.** Akun, paket, pembayaran, dan data operator di relay. D1 hanya untuk Zeiko S3 (tidak
  berubah: 1 user, 1 D1 pengganti index.txt, ADR-044), plus satu **D1 khusus akses** terpisah untuk sesi login, token
  API/OAuth, dan link share (jawaban R0, ADR-064). Pohon file dan nama file tidak pernah masuk D1. Notifikasi,
  saklar email, dan berhenti berlangganan disimpan relay (ADR-065, `adapters/notices.ts`).
- **Kode sekarang belum begitu:** Drive masih memakai D1 (`nodes`, `blobs`, `shares`, sesi, token, dll.). Pindahnya
  bertahap lewat **fase R di `docs/ROADMAP.md`**, R0 sudah dijawab semua (ADR-064).
  Sampai pindah selesai: **jangan menambah tabel atau kolom D1 untuk Drive**, dan fitur Drive baru di roadmap dibekukan sampai R3
  selesai (keputusan pemilik; fitur S3 boleh jalan).

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
kota di Akun Zeiko; iklan dipesan dan dibayar lewat email: operator memasukkan kampanyenya di relay (Zeiko Drive → Ads),
cek manual, dan begitu disetujui QRIS-nya dikirim ke email pengiklan (/iklan hanya statistik); tanpa batas slot,
rotasi 15 detik (ADR-041, ADR-043). **Tidak ada panel admin di Drive** (ADR-057): laporan/takedown, iklan,
pemindai, audit, akun, dan angka bisnis dikerjakan operator dari relay lewat ops API (`routes/ops.ts`); tidak ada
role staf, passkey, atau TOTP. Login lewat Akun Zeiko:
di dev, "Masuk dengan Akun Zeiko" membuka pintu tiruan `/__dev/door/account/signin` untuk memilih akun
demo `demo@zeiko.local` (Plus), `max@zeiko.local` (Max), atau `baru@zeiko.local` (tanpa paket).

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
(ADR-047, `services/s3-billing.ts`): minimal 3 GB, 1 salinan Rp500/GB atau 3 salinan Rp1.250/GB per bulan, egress
lebih ditagih saat perpanjangan. 3 salinan = salinan sungguhan di `S3_REPLICA_A/B` (`services/s3-replicas.ts`);
jangan pernah menjual atau menyebut jumlah salinan yang tidak benar-benar disimpan. **Alamat sendiri** (ADR-048,
`services/s3-urls.ts`, adapter `hostnames`): `s3.<nama>.zeiko.biz.id` Rp3.000 atau domain sendiri Rp5.000, sekali bayar,
hanya melayani akun pemiliknya, dilepas kalau paket tidak dibayar 30 hari. Di dev: `s3.<nama>.localhost:8790`.

**Fitur yang belum siap disembunyikan** (ADR-049): `services/readiness.ts` memutuskan fitur mana yang jalan (dan apa
yang masih kurang, untuk tab Features di relay); aplikasi membaca `capabilities` dari `/api/public/catalog`. Fitur baru
yang butuh secret/binding/DNS pemilik didaftarkan di sana dan disembunyikan sampai siap, tidak ditampilkan mati.

**Editor foto, video, PDF** (ADR-050, `src/web/editors/`, halaman `/alat`): semuanya jalan di browser, isi file tidak
dikirim ke mana pun. Bytes dari URL pratinjau, hasil lewat antrean upload biasa. Library dibundel dan dimuat saat editor
dibuka: `mediabunny`, `pdfjs-dist` (build **legacy**; aset `/pdfjs-<versi>/` disalin plugin di `vite.config.ts`),
`pdf-lib`. Batas ukuran: `editor_*_max_bytes` di config. Editor foto ala Snapseed (ADR-052): tab Looks/Alat, alat dibuka dengan ✕/✓, efek piksel sendiri di `editors/photo/effects.ts`. **Editor teks/kode, dokumen, spreadsheet, ZIP** (ADR-051): aturan
yang sama; teks pakai CodeMirror 6 (`editors/text/`), dokumen TipTap + mammoth/docx (`editors/doc/`), spreadsheet
FortuneSheet + FortuneExcel (`editors/sheet/`; plugin `fortuneSheetFixes` di `vite.config.ts` membuang `new Function`
karena CSP, jadi cek spreadsheet di build production, bukan dev), ZIP dibaca sendiri + fflate (`editors/zip/`, CRC
dicek, path dibersihkan), HTML dari file orang selalu lewat `editors/sanitize.ts`. Baru → Dokumen / Spreadsheet / File teks membuka editor dengan file kosong (`EditRequest.blank`)
yang disimpan ke folder yang sedang dibuka. `EditorFrame` dirender ke `document.body` (portal).

**Kompres lokal, kolase, JPEG XL** (ADR-067): `editors/compress/` (gratis, di browser, beda dari Kompres server
ADR-031; file Drive di-stream per Range lewat `UrlSource`), `editors/collage/`, teks/stiker/bentuk bersama di
`editors/decor/`, roda warna + HSL di `photo/adjust.ts` + `editors/colour/`, codec di `editors/codecs/` (JXL/AVIF lewat
jSquash, MP3/AAC/FLAC lewat encoder WASM mediabunny; CSP punya `'wasm-unsafe-eval'`). Editor video lengkap belum.

**Transfer** (ADR-053): berapa upload/unduhan berjalan bersamaan dipilih per perangkat (`src/web/lib/transfer.ts`,
maks 20 file tiap arah, batas dari config `*_cap`); "Unduh → File terpisah" lewat antrean unduhan
(`src/web/download/`, `POST /api/files/download-plan`). **Share** (ADR-054): link folder/bundle bisa "tampilkan daftar
file dulu" (`shares.show_listing`; per file `/{r64}/{s32}/f/{nodeId}/…`, lewat gerbang yang sama). **S3** (ADR-055):
CORS per bucket (`services/s3-cors.ts`) dan isi bucket di `/s3` (`services/s3-browse.ts`, link = presigned URL Zeiko S3
dengan key terbaru akun, upload lewat app ≤ `s3_web_upload_max_bytes`).

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
