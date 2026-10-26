# Audit keamanan (SPEC §14)

Tanggal: 2026-10-22 · Cakupan: kode di repo ini (Worker, web, container). Infrastruktur Cloudflare
(zona, WAF, CSAM Scanning Tool) dicek ulang saat staging dibuat.

Status: ✅ terpenuhi & teruji · 🟡 terpenuhi sebagian / butuh tindakan pemilik · ⬜ di luar kode.

## 14.1 Akses & isolasi

| Item                                                           | Status | Bukti                                                                                                                               |
| -------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| R2 privat, semua akses lewat Worker + cek izin per node        | ✅     | `services/access.ts` (`requireNode`), tidak ada presigned URL/kredensial S3 (container media/archiver juga tanpa kunci S3, ADR-033) |
| Key objek opaque, ID tidak bisa ditebak                        | ✅     | `u/{userId}/{ulid}`, share `r64` acak + `s32` HMAC diverifikasi sebelum query D1                                                    |
| Test IDOR untuk setiap endpoint                                | ✅     | `tests/integration/idor.test.ts`: 39 endpoint dicoba memakai ID milik akun lain → semua 4xx, data korban tidak berubah              |
| Isi file anggota keluarga tidak terlihat oleh pemilik keluarga | ✅     | `tests/integration/family.test.ts`                                                                                                  |

## 14.2 Pemindai

| Item                                                                                                 | Status | Bukti                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Isi file keluar hanya ke VirusTotal, hanya executable/dokumen ber-macro yang belum dikenal (ADR-046) | ✅     | `services/virustotal.ts` (`vtKind`, `UPLOADED_KINDS`), nama file diganti `file.<ext>`, `tests/integration/virustotal.test.ts` |
| SHA-256 + CRC32 semua file, blocklist hash                                                           | ✅     | `containers/scanner`, `services/scan.ts`, `tests/integration/scan.test.ts`                                                    |
| ClamAV ≤ `scan_max_bytes`, retry 3× lalu alert                                                       | 🟡     | container scanner + `scan_max_attempts`. Production masih pemindai dasar (butuh Containers/Workers Paid); app menulis "Dicek dasar", bukan "Aman", sampai ClamAV jalan, dan tab Features relay menyebutnya (ADR-056) |
| File `pending` hanya untuk pemilik, tidak bisa di-share                                              | ✅     | `assertDownloadable`, `createShare` mewajibkan `ready`                                                                        |
| Hasil kompres mewarisi status `clean`                                                                | ✅     | ADR-031 (dibuat transcoder kita sendiri dari file yang sudah dipindai)                                                        |

## 14.3 Anti-CSAM

| Item                                                                                     | Status | Bukti                                                                                 |
| ---------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| Laporan CSAM → link mati, karantina + legal hold, prioritas mendesak; pembekuan akun oleh operator | ✅     | `services/reports.ts`, `tests/integration/takedown.test.ts`. Otomatis hanya dari pelapor yang login atau lolos Turnstile; menolak laporan memulihkan yang dimatikannya (ADR-056) |
| Hash takedown masuk blocklist                                                            | ✅     | aksi `blocklist`                                                                      |
| Timer SLA 4 jam / 24 jam                                                                 | ✅     | relay → Zeiko Drive → Reports (ops API, ADR-057)                                      |
| Adapter `CsamDetector`                                                                   | 🟡     | mock; butuh perjanjian vendor (LAUNCH-CHECKLIST)                                      |
| Cloudflare CSAM Scanning Tool                                                            | 🟡     | aktifkan di zona saat staging; verifikasi cakupan respons Worker (catat di DECISIONS) |
| Prosedur                                                                                 | ✅     | `docs/runbook/takedown.md`                                                            |

## 14.4 Keamanan web

| Item                                                                      | Status | Bukti                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie `__Host-`, HttpOnly, Secure, SameSite=Lax                          | ✅     | `auth.ts` (`__Host-zk`)                                                                                                                                                                                                                                                                       |
| Origin wajib = `APP_ORIGIN` + token CSRF untuk request yang mengubah data | ✅     | `originCheck` + `csrfCheck` (double-submit bila ada sesi; tanpa sesi cukup Origin, ADR-028)                                                                                                                                                                                                   |
| Endpoint di luar `/api`                                                   | ✅     | webhook (tanda tangan sendiri), `/ad/i` & `/ad/c` (tanpa sesi, token HMAC, rate limit per IP), form password share (tanpa sesi)                                                                                                                                                               |
| CSP ketat app                                                             | ✅     | `appCsp`: `script-src 'self'` (+ Turnstile), `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`                                                                                                                                                                                 |
| Trusted Types                                                             | 🟡     | belum: `require-trusted-types-for` perlu diuji dengan semua dependency. Kandidat setelah staging                                                                                                                                                                                              |
| HSTS                                                                      | ✅     | `Strict-Transport-Security: max-age=31536000` di luar dev (tanpa `includeSubDomains`, karena subdomain lain di zeiko.biz.id bukan milik app ini)                                                                                                                                              |
| Respons file: attachment, `nosniff`, `CSP: sandbox`                       | ✅     | `lib/serve.ts`; inline hanya dari `USERCONTENT_ORIGIN` dengan token pendek; CORS uc hanya `APP_ORIGIN`                                                                                                                                                                                        |
| Nama file disanitasi                                                      | ✅     | `lib/names.ts` + unit test                                                                                                                                                                                                                                                                    |
| Zod di setiap input + batas body JSON                                     | ✅     | `validate(...)`, `bodyLimit` untuk JSON; endpoint biner mewajibkan `Content-Length` yang cocok                                                                                                                                                                                                |
| Rate limit                                                                | ✅     | login/OTP, init upload, buat share, kirim share, unduh per IP per link, booking iklan, laporan; beacon/klik iklan per IP                                                                                                                                                                      |
| Turnstile: login, email share, daftar pengiklan, laporan anonim           | ✅     | backend memeriksa saat `TURNSTILE_SECRET_KEY` diisi; widget di form web (`components/Turnstile.tsx`). **Temuan audit:** sebelumnya widget belum ada di web, sehingga login akan gagal begitu secret dipasang. Sudah diperbaiki                                                                |
| Secret hanya via `wrangler secret` + prosedur rotasi                      | ✅     | `docs/runbook/rotasi-secret.md`, `.dev.vars` di-ignore                                                                                                                                                                                                                                        |
| Dependency audit di CI                                                    | ✅     | `npm audit --omit=dev --audit-level=high` (0 high/critical. Ada 4 moderate: GHSA-67mh-4wv8-2f99 di dev server esbuild lama, yang terbawa `better-auth` → `drizzle-kit`. Tidak ikut bundle Worker maupun SPA dan hanya berdampak saat dev server esbuild dijalankan. Pantau rilis better-auth) |

## 14.5 Privasi (UU PDP)

| Item                                            | Status | Bukti                                                                                                                           |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Tanpa tracker pihak ketiga; iklan tanpa ID user | ✅     | ADR-032                                                                                                                         |
| IP disimpan sebagai hash bersalt harian         | ✅     | `hashIp`                                                                                                                        |
| Halaman kebijakan bertanda DRAF                 | ✅     | `/kebijakan/*`                                                                                                                  |
| Ekspor data + hapus akun (7 hari)               | ✅     | `tests/integration/account.test.ts`                                                                                             |
| Runbook kebocoran data (3×24 jam)               | ✅     | `docs/runbook/kebocoran-data.md`. **Temuan audit:** sebelumnya belum ada                                                        |
| Retensi log `log_retention_days`                | ✅     | cron `purge_old_logs`. **Temuan audit:** sebelumnya config ada tapi tidak dipakai. Audit log admin tidak ikut dihapus (ADR-034) |

## Audit OWASP Top 10:2025 (2026-10-26, ADR-056)

Audit statis seluruh repo. Yang ditemukan dan diperbaiki:

- **Faktor kedua staf** hanya dicek "sudah dipasang", tidak pernah diminta; **akun staf yang dibekukan** masih bisa
  membuka rute admin; **moderator** bisa membekukan admin. Ketiganya selesai dengan menghapus panel admin Drive sama
  sekali (ADR-057): kerja operator pindah ke relay lewat ops API (bearer 32+ karakter, 404 tanpa itu), dan Drive tidak
  punya role staf, passkey, atau TOTP lagi.
- **Laporan CSAM** langsung membekukan akun pengunggah, dari siapa pun. Sekarang laporan hanya mematikan link
  dan mengarantina isi (dan hanya dari pelapor yang login atau lolos Turnstile); akun dibekukan oleh operator.
- **Redirect `/dashboard`** bisa diarahkan ke situs lain. Sekarang hanya ke halaman app sendiri.
- **Undangan keluarga** yang diterima bersamaan bisa melewati batas anggota. Sekarang dicek ulang di dalam batch
  (`lib/batch-guard.ts`).
- **Label "Aman"** tampil walau production belum memakai ClamAV. Sekarang "Dicek dasar" sampai antivirus jalan.

Yang dicek tanpa temuan: injeksi SQL (semua query ber-parameter), XSS (React + DOMPurify, HTML server di-escape),
IDOR (`requireNode`), token bertanda tangan, SigV4 S3, webhook pembayaran. Catatan kecil yang belum diubah: token
`ZEIKO_OPS_TOKEN` dipakai sebagai bearer ops sekaligus kunci tanda tangan callback pembayaran; password link
share minimal 4 karakter.

## Zeiko S3 (ADR-044)

- Host sendiri (`S3_ORIGIN`); app, API Drive, dan cookie tidak pernah dilayani di sana. Tanpa `S3_KEYS_ENC_KEY`
  host itu menjawab `ServiceUnavailable`.
- SigV4 (header + presigned, maks 7 hari, selisih jam 15 menit), `host` wajib ditandatangani, perbandingan
  tanda tangan constant-time, payload hex SHA-256 dicek sambil streaming, chunk `aws-chunked` bertanda tangan dicek
  per chunk sebelum diteruskan. Secret key disimpan AES-GCM (`S3_KEYS_ENC_KEY`), ditampilkan sekali.
- Setiap query index di-scope `user_id`; bucket milik orang lain → `AccessDenied`, nama bucket global. Endpoint
  `/api/s3/*` ada di suite IDOR.
- Anonim hanya GET/HEAD objek di bucket publik yang tidak diblokir Zeiko, akunnya aktif, dan objeknya sudah lolos
  pemindaian; tanpa listing; `RL_DOWNLOAD` per IP.
- Semua objek: `nosniff` + `CSP: sandbox; default-src 'none'` (host S3 satu site dengan pintu Akun Zeiko, jadi
  HTML pengguna tidak boleh berjalan sebagai halaman). Key R2 tidak pernah keluar; byte di `s3/{userId}/{blobId}`.
- Batasan: checksum trailer (`x-amz-checksum-*`) dan tanda tangan trailer tidak dicek (isi chunk tetap dicek);
  pencabutan key berlaku paling lama 15 detik per isolate (status akun dibaca ulang tiap request).
- Paket tidak diperpanjang (ADR-047): `readonly` menolak PUT/POST (kecuali DeleteObjects) dan menutup bucket
  publik; `locked` menolak semua request ber-key. Harga paket selalu dihitung server (`quoteS3Plan`), sama dengan
  yang dipotong; ukuran dan jumlah salinan dicek ulang di server.
- Alamat sendiri (ADR-048): host itu hanya melayani akun pemiliknya (key lain `AccessDenied`, bucket lain
  `NoSuchBucket`); app dan API Drive tidak pernah dilayani di sana. Nama layanan Zeiko dan nama yang memuat `zeiko`
  ditolak; domain di zone Zeiko tidak bisa didaftarkan sebagai domain sendiri; custom domain yang sudah ada tidak
  diambil alih. Token Cloudflare hanya di secret Worker, dan izinnya sebatas route, sertifikat, DNS, dan script.
- 3 salinan: bucket replika juga privat (dibuat `cf-setup` tanpa akses publik), key-nya sama
  (`s3/{userId}/{blobId}`), dan penghapusan selalu dikirim ke ketiga bucket.

## Kesiapan fitur (ADR-049)

- `GET /api/ops/readiness` (bearer ops) hanya menyebut nama kebutuhan dan apakah terisi, tidak pernah nilainya.
  `capabilities` publik hanya berisi boolean per fitur.

## VirusTotal (ADR-046)

- Key gratis milik pemilik. **Ketentuan VirusTotal melarang Public API dipakai di produk/layanan komersial**;
  dipakai "untuk sekarang" atas keputusan pemilik. Kalau VirusTotal memblokir key, pemindaian jalan terus tanpa
  VirusTotal dan operator mendapat email.
- Hash dicek hanya untuk tipe berisiko (program, skrip Windows, dokumen Office/PDF, arsip). Isi file dikirim
  hanya untuk program dan dokumen ber-macro yang belum dikenal, ≤ 32 MB. File yang dikirim lewat Public API bisa
  dilihat pelanggan VirusTotal; Kebijakan Privasi §4 menyebut ini. Skrip teks (`.bat`, `.ps1`, `.js`, `.sh`, …)
  tidak pernah dikirim karena sering berisi kredensial.

## Temuan lain yang diperbaiki saat audit

- Pemesanan iklan belum memakai binding `RL_AD_BOOK`. Sudah dipasang.
- Beacon impresi dan klik iklan tanpa batas per IP, sehingga statistik pengiklan bisa digelembungkan. Sudah diberi rate limit.

## Hasil cek staging (2026-10-22, Workers Free)

- **CSP** dari Worker sampai utuh ke browser.
- **HSTS:** setelan HSTS zona `zeiko.biz.id` (`max-age=15552000`, 6 bulan) menimpa header Worker yang 1 tahun.
  Tidak berbahaya. Kalau ingin 1 tahun, ubah di SSL/TLS → Edge Certificates (keputusan pemilik, karena
  setelan itu berlaku untuk seluruh zona).
- **JavaScript Detections** (Bot Fight Mode zona) menyuntikkan `<script>` inline ke setiap HTML, dan CSP
  `script-src 'self'` memblokirnya. Akibatnya ada error console, Lighthouse Best Practices turun ke 92, dan
  Cloudflare kehilangan satu sinyal deteksi bot. App tetap berjalan normal. CSP **sengaja tidak** dilonggarkan
  dengan `'unsafe-inline'`. Pilihan pemilik: biarkan, atau matikan JS Detections/Bot Fight Mode di zona.
- **Bot pemindai** (l9scan dan sejenisnya) langsung datang begitu domain staging punya sertifikat. Tanpa OTP,
  mereka tidak bisa masuk: email staging masih mock, sehingga OTP hanya tersimpan di KV.
- Masih perlu dicek: CSAM Scanning Tool dan cakupan respons Worker, Lighthouse ≥ 90 di CI, serta k6 (setelah
  Workers Paid, lihat PROGRESS).
