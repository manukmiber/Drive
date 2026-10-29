# PROGRESS — Zeiko Cloud Storage

Centang item yang sudah selesai (kode + test hijau + commit). Lihat `PLAN.md` untuk detail tiap fase.

## Arah baru: Drive tanpa D1 (ADR-064, pemilik 2026-10-26)
Diagram pemilik meminta satu index per user di R2; sejak ADR-002 Drive memakai D1, dan cadangan `u/{userId}/index.json`
dari SPEC **tidak pernah dibuat** (hanya penanda `manifest_dirty` yang ditulis). Pemilik memutuskan: satu user = satu
folder R2 + satu index (nama file, struktur folder); keluarga satu folder + satu index (plus kepemilikan); tulis bersyarat
etag; format super ringan karena ditarik paling awal; Drive tidak memakai D1 (akun/paket/pembayaran di relay); S3 tetap.
Semua yang di bawah ini yang menyimpan data Drive di D1 (pohon file, share, sesi, token A1–A3, dekorasi D5, dll.) pindah
lewat fase R di `docs/ROADMAP.md`.
- [x] Keputusan dan peta pindah ditulis: ADR-064, SPEC §2–§4, `CLAUDE.md`, ROADMAP (fase R), `PLAN.md`, `peta-file.md`.
- [x] R0: pemilik menjawab (2026-10-26): share/token/sesi ke D1 khusus akses; data operator ke relay; salinan kuota
  dari relay; `index.txt` JSON ringkas; fitur Drive baru dibekukan sampai R3; no. 3 notifikasi ke relay;
  R3 menggabungkan tulis index (batas R2 1 tulis/detik per key).
- [x] Notifikasi, saklar email, berhenti berlangganan disimpan relay (ADR-065): `adapters/notices.ts`, antrean `notify`
  20 kali ulang, cron `move_notices_to_relay` dan `prune_notices`, migrasi `0017` buang `telegram_links` + `contacts`;
  relay `ab49789` (`/apps/v1/notices*`). **Relay live perlu di-update pemilik** (dashboard → update, atau
  `bash install.sh`); sampai itu notifikasi menunggu di antrean.
- [x] Di production (pemilik, 2026-10-28, "Langsung push deploy"): migrasi `0018` dan `0019` di D1 production
  (bookmark Time Travel sebelum migrasi `00000183-00000000-00005112-83fbe4c06ee77d5a73636743018833b7`), Worker
  `zeiko-production` versi `1e16925d-a6fc-40e3-b120-f93c02453b22` (ToS ADR-070, S1 ADR-071, S3 lifecycle ADR-072;
  container tidak di-roll). Dicek dari luar: app, health, katalog 200; host S3 menjawab XML S3.
- [x] Di production (pemilik, 2026-10-28, "Deploy semua"): Worker `zeiko-production` versi
  `99df3a56-c548-4829-92cd-2b5716a825d1` (ADR-066, ADR-067 editor/kompres lokal/kolase/JXL, S2 ADR-068 `649fa9a`;
  tanpa migrasi baru, container tidak di-roll). Dicek dari luar: app, health, katalog, `/alat`,
  `/api/v1/openapi.json` 200; CSP memuat `'wasm-unsafe-eval'`; host S3 menjawab XML S3.
- [x] Di production (pemilik, 2026-10-27): Worker `zeiko-production` versi `83a1f11b-6071-4356-a485-42448c7e7d91`
  (harga S3 3 salinan Rp1.250/GB, `e311d43`; tanpa migrasi baru, container tidak di-roll). Dicek dari luar:
  `/api/public/catalog` memberi `s3_price_idr_per_gb_month_3x` 1250.
- [x] Di production (izin pemilik, 2026-10-26): migrasi `0013`–`0017` di D1 production (sebelumnya `telegram_links` 0
  baris, `contacts` 0, `notifications` 1; bookmark Time Travel sebelum migrasi
  `000000d4-00000000-00005110-76c5c1b9cb4d02ae717bb50e53cb4625`), Worker `zeiko-production` versi
  `1c5bdd7a-d2db-4d97-b9ee-d4534fc36009` (D15, S9, A1–A3, R1, ADR-065). Dicek dari luar: app, health,
  `/api/v1/openapi.json`, `/developer` 200; `/api/notifications` dan `/api/v1/me` tanpa sesi 401; `/api/admin/*` 404;
  `assetlinks.json` 404 (paket Android belum diisi).
- [x] R1 format + pustaka index (2026-10-26): `shared/drive-index.ts` (format v1: header + satu baris JSON per entri,
  polos di R2), `services/drive-index.ts` (`IndexDoc`, `readIndex`, `changeIndex` bersyarat etag + ulang + tunggu 429),
  shim R2 (put atomik per key, `limitWritesPerKey`), `npm run bench:index`, 17 test. Angka di ADR-064.
- [x] R3 tulis ke index (ADR-074, 2026-10-29): setiap perubahan pohon pribadi ditulis ke `u/{userId}/index.txt` sebagai
  proyeksi D1 (kolom `x` = id D1, `st = 2` diblokir), digabung lewat klaim `manifest_dirty` (satu gelombang = satu
  tulis), cron jam-an `drive_index_flush` sebagai cadangan, migrasi data `0020` menandai user lama. App masih membaca D1.
- [ ] Pemilik: migrasi `0020` di D1 remote + deploy, supaya index user production mulai ditulis.
- [ ] R2 baca dari index · R4 index keluarga · R5 share tanpa D1 ·
  R6 sesi/token/OAuth tanpa D1 · R7 akun/paket/pembayaran/data operator di relay · R8 pindah data production, hapus
  tabel Drive dari D1.

## Fase 0 — Fondasi
- [x] Dokumen: `docs/SPEC.md`, `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `CLAUDE.md`
- [x] Tooling: TypeScript strict, ESLint, Prettier, Vitest
- [x] `wrangler.jsonc` (staging/production) + semua binding + cron
- [x] Skema Drizzle + migrasi awal (§4) + FTS5
- [x] Seed katalog Lampiran A/B + seed demo dev
- [x] Shim binding lokal (D1, R2, KV, Queues, RL, AE, Images, Media, Email)
- [x] Adapter interface + mock (Email, Payment, Scanner, CSAM, Clock)
- [x] Config loader (`app_config` + cache KV)
- [x] Kerangka Worker (fetch/queue/scheduled, error handler, host USERCONTENT)
- [x] Kerangka SPA (React + Router + Query + Tailwind, string UI terpusat)
- [x] `npm run dev` jalan lokal dengan semua adapter mock
- [x] CI GitHub Actions

## Fase 1 — Auth & akun
- [x] Better Auth: email OTP (magic link tidak dipakai; OTP cukup)
- [x] Google OAuth (aktif otomatis kalau `GOOGLE_CLIENT_ID/SECRET` diisi — belum dites dengan kredensial asli)
- [x] Passkey (daftar/hapus di Pengaturan, masuk dengan passkey — perlu dites manual di browser)
- [x] TOTP + admin wajib 2FA (level akun, ADR-019)
- [x] Cookie `__Host-`, cek Origin + CSRF
- [x] Storage pool pribadi saat daftar
- [x] Halaman Masuk, Profil, Pengaturan

## Fase 2 — Upload & download inti
- [x] Reservasi kuota atomik + test konkurensi
- [x] API multipart (init/part/status/complete/abort) + simple upload
- [x] Cron bersihkan upload kedaluwarsa
- [x] Download bertanda tangan (HEAD, Range, ETag, If-Range, Content-Disposition)
- [x] Explorer dasar: folder, CRUD, grid/list, Sampah
- [x] Panel upload klien (paralel, retry, resume IndexedDB, thumbnail) — **belum diuji di browser sungguhan**

### Sisa Fase 2 / catatan untuk sesi berikutnya
- Uji manual di Chrome desktop + Android: upload 5 GB, jeda/lanjut, refresh, putus jaringan, IDM/aria2c 8 koneksi (DoD §5.4).
- Thumbnail saat ini disajikan dari APP_ORIGIN (WebP tervalidasi + nosniff); pindahkan ke USERCONTENT_ORIGIN bertanda tangan di Fase 4.
- Cache edge (Cache API) untuk download belum dibuat (config default OFF, ADR-007).
- Satu warning lint `react-hooks/exhaustive-deps` di `Drive.tsx` (dependensi tipe saja).

## Fase 3 — Pipeline scan
- [x] Queue `scan` + adapter Scanner (mock + Container `scanner` Go/ClamAV — image belum di-build, butuh Docker di CI)
- [x] SHA-256 + CRC32 tersimpan, blocklist hash
- [x] Infected → hapus, kuota kembali, notifikasi (baris `notifications`; kirim email/Telegram di Fase 5)

## Fase 4 — Explorer lengkap
- [x] Pencarian FTS5
- [x] Pratinjau USERCONTENT_ORIGIN
- [x] Bintang, Terbaru, panel detail, shortcut, drag-drop
- [x] Virtualisasi 10.000 item (`content-visibility`, ADR-024 — belum diukur di HP kelas bawah)
- [x] PWA + Web Share Target

## Fase 5 — Share
- [x] Link r64/s32 + verifikasi tanpa D1
- [x] Bot preview OG, password, statistik
- [x] QR, deeplink WA/TG
- [x] Bot Telegram (webhook + tautkan akun + kirim file; butuh `TELEGRAM_BOT_TOKEN` saat deploy)
- [x] Email share via Queue `notify`

## Fase 6 — Download banyak file
- [x] ZIP store streaming + Range (folder share + `/z/` multi-pilih, ZIP64)
- [x] ZIP deflate stream (≤ zip_deflate_stream_max_bytes)
- [x] Job async + Container `archiver` (TAR.ZST level cepat/normal/maks, ZIP deflate besar, `/unduhan`, panel progres)

## Fase 7 — Billing
- [x] Saldo + ledger
- [x] PaymentProvider mock + webhook idempoten
- [x] Langganan, upgrade/downgrade, add-on
- [x] Invoice (nomor ZK-YYYYMM-000001, halaman cetak/PDF browser, email via notify)
- [x] Siklus tunggakan + dry-run hapus

## Fase 8 — Paket keluarga
- [x] Pool bersama + ruang Keluarga
- [x] Izin + matriks test
- [x] Undangan, keluar/dikeluarkan

## Fase 9 — Kompres media
- [x] Kredit + ledger (kuota paket dulu → pack paling cepat kedaluwarsa; refund sekali per job)
- [x] Images binding / Media binding / Container media (ffmpeg, `containers/media`)
- [x] Standalone (tmp/compress, 24 jam) + batch (notifikasi per batch), UI menu "Kompres" + `/kompres`

## Fase 10 — Iklan lokal
- [x] Area + alias CF (38 provinsi + 75 kota/kab, `0003_seed_ad_areas.sql`), inventori harian (cron 00:05 WIB)
- [x] Booking + hold 15 menit (anti-overbook lewat CHECK dalam satu transaksi) + bayar Saldo/QRIS
- [x] Moderasi (filter otomatis + admin), penayangan berjenjang kota → provinsi → nasional, impresi/klik
- [x] Dashboard pengiklan `/iklan`, kartu iklan sidebar/HP, slot halaman share, lokasi iklan di Pengaturan

## Fase 11 — Admin & moderasi
- [x] Dashboard biaya vs pendapatan (storage + kompres + fee gateway; komponen lain dari tagihan Cloudflare)
- [x] Pengguna (bekukan, saldo, bonus kuota, peran — wajib alasan), config editor, katalog, audit log
- [x] Laporan & takedown + SLA (CSAM otomatis: link mati, karantina + legal hold, pengunggah dibekukan)

## Fase 12 — Hardening & rilis
- [x] E2E Playwright (desktop + Pixel 7: login OTP → upload → share → unduh → sampah; semua halaman tanpa error console)
- [x] Audit keamanan §14 → `docs/SECURITY.md` + suite IDOR (39 endpoint), runbook di `docs/runbook/`
- [~] k6 `tests/load/download.js`: skrip siap, **belum dijalankan**. Di Workers Free, kuota 100 ribu request/hari
  dipakai bersama semua Worker di akun, sehingga uji beban bisa mematikan Worker lain milik pemilik. Jalankan
  setelah pindah ke Workers Paid.
- [~] Lighthouse mobile: landing di HP dev 81–88, di staging 82–83 (dari HP yang sama, benchmarkIndex 1493).
  A11y/SEO 100. Best Practices di staging 92 karena script inline JavaScript Detections Cloudflare diblokir
  CSP (lihat SECURITY.md). Target ≥ 90 diukur ulang di CI.
- [x] Kebijakan (/kebijakan/*; label DRAF dihapus 2026-10-26) + docs/LAUNCH-CHECKLIST.md + ekspor data & hapus akun (UU PDP)
- [x] Deploy staging (2026-10-22, **Workers Free**, ADR-035): https://staging.zeiko.biz.id dan
  https://uc-staging.zeiko.biz.id. D1/KV/R2/6 Queue, 1 cron gabungan, 8 secret acak, email relay (fallback
  mock sampai `MAIL_RELAY_TOKEN` dipasang). Smoke test lolos: login OTP → upload 10 KB, 0,5 MB, 1 MB, 5 MB, dan
  20 MB (multipart) → scan `ready` → unduh (sha256 cocok) → link share 200 → ZIP.
- [ ] Production: menunggu persetujuan pemilik. Apex `zeiko.biz.id` sudah dipakai layanan lain, dan Workers Paid
  dibutuhkan untuk container serta Email Sending.

## Zeiko Drive di Akun Zeiko (ADR-036, 2026-10-22)
- [x] Login lewat Akun Zeiko: tiket sekali pakai dari pintu (`/v1/ticket`) → `/api/auth/zeiko/exchange`; OTP email
  dan Google dihapus, passkey/TOTP tinggal sebagai faktor kedua staf. Pintu tiruan di dev (`/__dev/door`).
- [x] Pembayaran rupiah lewat relay (adapter `zeiko`: QRIS + crypto, callback HMAC, cron rekonsiliasi per jam).
- [x] Ops API (`/api/ops/*`) untuk layar Zeiko Drive di dashboard relay: profit, paket, angka bisnis, orang, audit.
- [x] App pindah ke `/dashboard` (Vite base, router basepath, PWA, link email/share lewat `appUrl`).
- [x] Sidebar "Produk Zeiko": AI Decision (`/dashboard/ai`), Zeiko Chat, Akun Zeiko. Landing pindah ke website.
- [x] Dua bahasa EN/ID di semua UI (`strings.en.ts`, cookie `zk_lang`, `users.locale`), halaman share bilingual.
- [ ] Email bilingual menurut `users.locale` (template email masih Bahasa Indonesia).
- [ ] Staging dengan SSO sungguhan: menunggu relay live diperbarui pemilik, secret `ZEIKO_APP_TOKEN`/`ZEIKO_OPS_TOKEN`,
  dan `https://staging.zeiko.biz.id` di `site.auth.origins`.

## Zeiko S3 + ToS/Kebijakan Privasi (ADR-044–048, 2026-10-24/25)
- [x] API S3 di host `S3_ORIGIN` (SigV4 header + presigned, aws-chunked, objek, listing v1/v2, multipart + copy,
  bucket publik, `NotImplemented` untuk sisanya), diuji dengan AWS SDK v3 asli.
- [x] Akun S3 = user Drive + `s3_accounts` (migrasi 0007); ops API untuk tombol relay; batas penyimpanan atomik;
  cron multipart kedaluwarsa + rekonsiliasi; pemindaian lewat Queue `scan`; hapus akun dan ekspor data ikut S3.
- [x] Index per akun di D1 sendiri (`S3_DB_*`, `deploy/{env}.json` → `s3Indexes`), default D1 utama.
- [x] Halaman `/s3` (key, bucket, endpoint, contoh aws-cli/rclone), dua bahasa.
- [x] ToS dan Kebijakan Privasi pemilik (ID kata per kata + EN), Kebijakan Iklan EN, Kebijakan Konten → ToS §3.
- [x] Paket dibayar di awal (ADR-047): minimal 3 GB, 1 salinan Rp500/GB atau 3 salinan Rp1.500/GB per bulan, beli
  sendiri di `/s3` lewat QRIS/kredit, naik paket pro-rata, turun mulai periode berikutnya, pengingat H-3/H-1,
  kredit memperpanjang sendiri, tidak diperpanjang → baca saja → kunci → hapus (ikut `dunning_delete_mode`).
- [x] Egress per GET, gratis 500 GB per periode, kelebihan Rp5.000 per 500 GB ditambahkan ke perpanjangan.
- [x] 3 salinan sungguhan: dua bucket R2 replika (`weur`, `wnam`), salin setelah scan, backfill/hapus saat paket
  berubah, baca dari salinan lain kalau yang pertama hilang, sapuan malam.
- [x] Alamat sendiri (ADR-048): `s3.<nama>.zeiko.biz.id` Rp3.000 atau domain sendiri Rp5.000, sekali bayar,
  hanya untuk akun pemiliknya, cek DNS per jam, dilepas setelah paket tidak dibayar 30 hari.
- [x] Fitur yang belum siap disembunyikan (ADR-049): `readiness.ts`, `capabilities` di katalog, `GET /api/ops/readiness`
  untuk tab Features di relay.
- [x] VirusTotal (ADR-046): cek hash tipe berisiko, kirim program/dokumen ber-macro yang belum dikenal, anggaran key
  per menit/hari/orang, tidak pernah menahan file lama. Drive dan Zeiko S3.
- [ ] Tombol relay "tambah user + binding ke worker" (diagram: "nanti"): buat D1, catat binding, panggil ops API.
- [ ] Deploy: `cf-setup` (secret `S3_KEYS_ENC_KEY`, bucket replika), `wrangler secret put VIRUSTOTAL_API_KEY`,
  migrasi 0007 + 0008, custom domain `s3.zeiko.biz.id` / `s3-staging.zeiko.biz.id`, `CF_HOSTNAMES_TOKEN` + `zoneId`,
  Cloudflare for SaaS + fallback origin `custom-s3.zeiko.biz.id`: menunggu izin pemilik.
- [ ] Pemilik: VirusTotal Premium dan Hive/Thorn (akan ditambahkan pemilik); alamat dukungan/privasi; retensi log;
  alur peringatan ToS §6–§7.

## Editor foto, video, PDF (ADR-050, 2026-10-25)
- [x] Semua di browser (tidak ada layanan luar, Container, atau kredit). Buka dari menu ⋮ / pratinjau (file Drive) atau
  `/alat` (file perangkat). Simpan sebagai file baru, ganti asli (yang lama ke Sampah), atau unduh.
- [x] Foto: potong (bebas/rasio), putar, balik, cahaya/warna, 7 filter, skala, JPEG/PNG/WebP, tanpa EXIF.
- [x] Video: potong awal/akhir, pisah, hapus/urutkan bagian, tambah klip, gabung. Cepat (salin paket, menempel ke
  keyframe) atau Tepat (encode ulang WebCodecs), satu file atau per bagian.
- [x] PDF: lihat (pdf.js, juga di pratinjau), putar/hapus/urutkan/ambil/pisah halaman, tambah PDF/gambar,
  tanda tangan (gambar/ketik/foto, ingat di perangkat), teks, tanggal, kompres seimbang/paling kecil, gambar → PDF.
- [x] Dites di Chrome (dev): semua alur di atas, hasil diperiksa (ukuran foto, durasi video, isi PDF dirender ulang).
- [ ] Uji di HP Android/iPhone sungguhan (memori untuk video besar, WebCodecs di Safari, HEIC).

## Editor teks/kode, dokumen, spreadsheet, ZIP (ADR-051, 2026-10-25)
- [x] Teks & kode: CodeMirror 6, bahasa dari nama file, cari & ganti, bungkus baris, pratinjau Markdown (dibersihkan
  DOMPurify), UTF-8 saja dengan BOM/CRLF dipertahankan. Baru → File teks dan "Buat file kosong" di `/alat`; simpan
  berikutnya langsung menawarkan "ganti" file yang sama. Dites di Chrome (dev), terang/gelap, Indonesia/Inggris.
- [x] Dokumen: TipTap (judul, tebal/miring/garis bawah/coret, stabilo, perataan, daftar, daftar centang, kutipan,
  tautan, gambar, tabel dengan baris/kolom/gabung sel). Buka `.docx` lewat mammoth (catatan bahwa huruf, warna,
  perataan, tata letak tidak ikut), simpan `.docx` (docx/html), Markdown, atau HTML. Baru → Dokumen. Pratinjau `.docx`
  pakai docx-preview, dibersihkan DOMPurify, halaman dikecilkan agar muat di HP. Dites di Chrome (dev): buka, ubah,
  ganti asli, simpan Markdown, dokumen baru, terang/gelap, HP/desktop.
- [x] Spreadsheet: FortuneSheet (rumus, format angka, gabung sel, bekukan, urut, filter, beberapa lembar), menu dan
  toolbar dalam bahasa Indonesia. Buka `.xlsx` (FortuneExcel, angka dikembalikan jadi angka), `.csv`/`.tsv` (pemisah
  dikenali, `0812…` tetap teks); simpan `.xlsx` atau lembar yang dibuka sebagai CSV. Baru → Spreadsheet, kartu di
  `/alat`, dan "Buka di editor" dari pratinjau. Dites di build production dengan CSP app: sisip baris (tanpa
  `new Function`), rumus ikut bergeser, gabung sel, ganti asli lalu dibuka lagi, CSV `;` disimpan ulang byte per
  byte; HP/desktop.
- [x] ZIP: lihat isi per folder, unduh satu file, bongkar semua atau yang dipilih ke folder baru di sebelah ZIP-nya
  (folder di dalamnya ikut). File bersandi ditandai, CRC dicek, `..`/path absolut dibersihkan, `__MACOSX` dibuang.
  Dari menu ⋮ ("Lihat isi ZIP"), pratinjau, dan kartu di `/alat`. Dites di build production dengan CSP app (inflate
  di worker fflate), HP/desktop, terang/gelap.

## Editor foto ala Snapseed (ADR-052, 2026-10-26)
- [x] Tab Looks (15 gaya + kekuatan) dan Alat (13 alat, ✕/✓ per alat, urungkan/ulangi per langkah, tahan mata untuk
  lihat asli): atur gambar + otomatis, detail, kurva per kanal dengan histogram, white balance + otomatis, potong,
  putar + luruskan, perbaiki noda, blur lensa, vinyet, efek (glow, butiran, pudar), teks, bingkai, ukuran piksel pas.
- [x] Dites di Chrome (dev), HP 360/390 px, terang/gelap, Indonesia/Inggris: semua alat, batal/terapkan, Looks,
  simpan resolusi penuh.
- [x] PDF: duplikat halaman, halaman kosong, centang/silang, stabilo, tutup putih, gambar, tinta merah, isi formulir
  (kunci isian), tanda air, nomor halaman, jadikan gambar, ambil teks. Dites di Chrome (dev), HP 360 px, gelap,
  Indonesia: hasil disimpan lalu diperiksa (isian "Budi Santoso" tersimpan, tanda air dan nomor 1–3 di tiap halaman,
  centang tertanam), 5 halaman → 5 JPG, teks .txt.

## Transfer, share, dan S3 lebih lengkap (ADR-053–055, 2026-10-26)
- [x] Batas upload/unduh sendiri per perangkat (maks 20 file tiap arah, bagian per file maks 8), preset + saran
  koneksi, di Pengaturan dan panel transfer. Antrean upload: batas baru langsung berlaku, menunggu jaringan, lanjut
  otomatis saat online, jeda/lanjut/batal semua.
- [x] Unduh file terpisah (antrean unduhan: Range, coba ulang, offline, link baru), ke folder Unduhan atau folder
  pilihan dengan struktur foldernya; panel transfer dengan tab Upload/Unduh dan total.
- [x] Share: daftar file untuk link folder/bundle (unduh satu-satu atau ZIP), hapus password, judul, QR PNG/SVG/salin/
  layar penuh, Dibagikan dengan cari/atur/QR.
- [x] Zeiko S3: CORS (Put/Get/DeleteBucketCors + preflight), isi bucket di `/s3` (daftar, upload ≤ 95 MiB, folder
  baru, unduh, link sementara, hapus), editor CORS.
- [x] Di production (izin pemilik, 2026-10-26): migrasi `0009` dan `0010` di D1 production, Worker `zeiko-production`
  versi `b51ffa80-e5e8-4317-8c94-37a94628b299`. Dicek dari luar: app, health, katalog (batas 20), link share palsu 404,
  preflight S3 tanpa CORS 403.
- [x] Logo di tengah QR share dan QR undangan keluarga (ADR-059).
- [ ] Belum: upload multipart dari halaman `/s3`.

## Audit OWASP Top 10:2025 (ADR-056, 2026-10-26)
- [x] Faktor kedua staf, staf yang dibekukan, moderator vs admin: selesai dengan menghapus panel admin (ADR-057).
- [x] Laporan CSAM: isi dimatikan otomatis hanya dari pelapor login/Turnstile, akun dibekukan operator; tolak
  laporan memulihkan.
- [x] Redirect `/dashboard//…` hanya ke app sendiri; undangan keluarga tidak bisa direbut/melewati batas (guard batch).
- [x] Label "Dicek dasar" tanpa ClamAV; kesiapan `antivirus` dan `captcha` di tab Features relay.
- [ ] Pemilik: Turnstile (site key di `deploy/production.json` → `turnstileSiteKey`, secret `TURNSTILE_SECRET_KEY`).

## Admin pindah ke relay (ADR-057, 2026-10-26)
- [x] Ops API: laporan (daftar, detail, aksi, pratinjau 5 menit), pemindai (statistik, ulang), iklan (antrean cek,
  pengiklan, materi + gambar base64, kampanye, kirim ulang QRIS, batal, takedown), wilayah iklan.
- [x] Dihapus: `/api/admin`, halaman `/admin`, role staf, passkey/TOTP (plugin, paket, UI), `staff_second_factor_hours`.
- [x] `legal_holds.created_by` tanpa FK (`relay-operator`/`auto`); token review membawa ID laporan.
- [ ] Relay: tab Reports, Ads, Scanner, Audit di layar Zeiko Drive (repo `Relay`) dan batas body forwarder ≥ 1 MiB
  untuk gambar iklan. Drive ini sudah live (lihat di bawah), jadi sampai tab Reports ada, takedown hanya bisa lewat
  `curl` ke ops API. Setelah itu pemilik update relay (`bash install.sh` atau tombol update).

## Subtitle di pratinjau video (D13, ADR-073, 2026-10-29)
- [x] `.srt`/`.vtt` di folder yang sama dipasang otomatis (nama dasar sama), bisa dipilih, dimatikan, atau diambil dari
  perangkat; SRT → WebVTT di browser (BOM, UTF-16, Windows-1252); ukuran teks kecil/sedang/besar.
- [x] Dicek di Chrome dev: desktop gelap (EN) dan 360 px terang (ID); ganti ke track `en` dan matikan.

## Lifecycle bucket S3 (S3, ADR-072, 2026-10-28)
- [x] `Put/Get/DeleteBucketLifecycleConfiguration`: Expiration (Days/Date) dan AbortIncompleteMultipartUpload, filter
  prefix + ukuran; Tag/Transition/versi → 501. Cron jam-an bertahap dengan cursor; editor "Hapus otomatis" di `/s3`.
- [x] Di production 2026-10-28 (migrasi `0019`, Worker `1e16925d`).

## Key S3 dengan izin terbatas (S1, ADR-071, 2026-10-28)
- [x] Bucket tertentu, prefix, baca/tulis/baca saja/tulis saja, kedaluwarsa; key lama tetap akses penuh. Kelola bucket
  hanya dengan key tanpa batas; ListBuckets terfilter; presigned URL ikut aturan; link `/s3` pakai key yang boleh baca.
- [x] Di production 2026-10-28 (migrasi `0018`, Worker `1e16925d`).

## Tulis bersyarat S3 (S2, ADR-068, 2026-10-28)
- [x] `If-None-Match: *` dan `If-Match` di PutObject, CopyObject (tujuan), CompleteMultipartUpload; dicek di batch D1
  yang sama dengan commit index (dua penulis: tepat satu menang). Multipart yang kalah di tengah complete → 409
  `ConditionalRequestConflict`. Syarat tanggal sumber copy sekarang dihitung; syarat lain di operasi tulis → 501.
- [x] Di production 2026-10-28 (Worker `99df3a56`).

## Login aplikasi OAuth 2.0 + PKCE (A3, ADR-063, 2026-10-26)
- [x] Klien pihak pertama (Android, desktop, CLI), halaman persetujuan `/oauth/authorize`, code + PKCE S256,
  `/api/v1/oauth/token` (code, refresh dengan rotasi + deteksi pemakaian ulang), `/api/v1/oauth/revoke`.
- [x] Pengaturan → Aplikasi tersambung (putuskan); `/.well-known/assetlinks.json`.
- [ ] Pemilik: migrasi `0016` di D1 remote, deploy; untuk App Links: `androidPackage` + `androidCertSha256` di
  `deploy/production.json`.
- [ ] Belum: device flow (RFC 8628), aplikasi pihak ketiga.

## API publik v1 + OpenAPI (A2, ADR-062, 2026-10-26)
- [x] `/api/v1`: akun, Drive (list cursor, detail, cari, unduh, Sampah, folder, ganti nama, pindah, salin), upload
  multipart, share, Zeiko S3 (key, bucket, publik, CORS); scope per operasi; Idempotency-Key; 300/menit per token.
- [x] `/api/v1/openapi.json` (OpenAPI 3.1 dari skema zod yang sama dengan router) dan halaman `/developer`.
- [ ] Pemilik: migrasi `0015` di D1 remote, deploy.

## Token akses (A1, ADR-061, 2026-10-26)
- [x] `api_tokens` (hash SHA-256, prefix publik, scope, kedaluwarsa, cabut), Bearer hanya di `/api/v1`, `RL_API` per token.
- [x] Pengaturan → Token & aplikasi: buat (nama, scope, kedaluwarsa), rahasia sekali tampil, daftar, cabut.
- [ ] Pemilik: migrasi `0014` di D1 remote, deploy (binding rate limit `RL_API` ikut `wrangler.jsonc`).

## Statistik bucket dan log akses S3 (S9, ADR-060, 2026-10-26)
- [x] Per bucket di `/s3`: objek, ukuran, request/error/diunduh 30 hari (grafik per hari WIB + tabel).
- [x] `PutBucketLogging`/`GetBucketLogging` dan dari `/s3`; log format Amazon dikirim per jam ke bucket sendiri, IP di-hash.
- [ ] Pemilik: migrasi `0013` di D1 remote, deploy.

## Dekorasi folder (D5, ADR-058, 2026-10-26)
- [x] Warna (12), ikon (24 atau satu emoji), gambar sampul dari space yang sama; banyak folder sekaligus; hapus.
- [x] Tampil di explorer, breadcrumb, Pindahkan, cari, banner folder, share publik (tanpa sampul).
- [x] Dicek di Chrome dev: 360 px terang (EN) dan desktop gelap (ID).
- [x] Di production (izin pemilik, 2026-10-26): migrasi `0011` dan `0012` di D1 production (saat itu 0 legal hold,
  0 laporan terbuka, 0 staf), Worker `zeiko-production` versi `b0e53643-c224-4fef-b42d-4adeea162a16` (ADR-057 + ADR-058).
  Dicek dari luar: app, health, katalog 200; `/api/admin/*` 404; ops tanpa token 404; `/api/nodes/decor` tanpa sesi
  401; link share palsu 404.

