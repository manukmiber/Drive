# PROGRESS — Zeiko Cloud Storage

Centang item yang sudah selesai (kode + test hijau + commit). Lihat `PLAN.md` untuk detail tiap fase.

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
- [ ] Belum: logo di tengah QR, upload multipart dari halaman `/s3`.

## Audit OWASP Top 10:2025 (ADR-056, 2026-10-26)
- [x] Faktor kedua staf, staf yang dibekukan, moderator vs admin: selesai dengan menghapus panel admin (ADR-057).
- [x] Laporan CSAM: isi dimatikan otomatis hanya dari pelapor login/Turnstile, akun dibekukan operator; tolak
  laporan memulihkan.
- [x] Redirect `/dashboard//…` hanya ke app sendiri; undangan keluarga tidak bisa direbut/melewati batas (guard batch).
- [x] Label "Dicek dasar" tanpa ClamAV; kesiapan `antivirus` dan `captcha` di tab Features relay.
- [ ] Pemilik: Turnstile (site key di `deploy/production.json` → `turnstileSiteKey`, secret `TURNSTILE_SECRET_KEY`),
  migrasi `0011` di D1 remote, deploy.

## Admin pindah ke relay (ADR-057, 2026-10-26)
- [x] Ops API: laporan (daftar, detail, aksi, pratinjau 5 menit), pemindai (statistik, ulang), iklan (antrean cek,
  pengiklan, materi + gambar base64, kampanye, kirim ulang QRIS, batal, takedown), wilayah iklan.
- [x] Dihapus: `/api/admin`, halaman `/admin`, role staf, passkey/TOTP (plugin, paket, UI), `staff_second_factor_hours`.
- [x] `legal_holds.created_by` tanpa FK (`relay-operator`/`auto`); token review membawa ID laporan.
- [ ] Relay: tab Reports, Ads, Scanner, Audit di layar Zeiko Drive (repo `Relay`) dan batas body forwarder ≥ 1 MiB
  untuk gambar iklan. **Jangan deploy Drive ini sebelum tab Reports ada di relay**: tanpa itu takedown hanya bisa lewat
  `curl` ke ops API.
- [ ] Pemilik: migrasi `0011` + deploy Drive, lalu update relay (`bash install.sh` atau tombol update).

## Dekorasi folder (D5, ADR-058, 2026-10-26)
- [x] Warna (12), ikon (24 atau satu emoji), gambar sampul dari space yang sama; banyak folder sekaligus; hapus.
- [x] Tampil di explorer, breadcrumb, Pindahkan, cari, banner folder, share publik (tanpa sampul).
- [x] Dicek di Chrome dev: 360 px terang (EN) dan desktop gelap (ID).
- [ ] Pemilik: migrasi `0011` + `0012` di D1 remote, deploy.

