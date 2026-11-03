# Roadmap Zeiko Drive & Zeiko S3

Dibuat 2026-10-26 dari pemeriksaan kode `main` (`d213155`), dipangkas 2026-11-03. Prompt hanya ada untuk item
yang belum selesai. Item yang sudah selesai diringkas di bagian "Yang sudah selesai".

**Cara pakai.** Buka sesi baru di repo ini, lalu ketik misalnya `Kerjakan S6 dari docs/ROADMAP.md`. Satu ID
= satu fitur = satu ADR, dengan satu atau beberapa commit. Prompt di tiap bagian juga bisa disalin utuh ke sesi
lain. Setelah selesai, sesi itu mengisi kolom Status di tabel.

> **Prioritas pertama: fase R (ADR-064, pemilik 2026-10-26).** Drive pindah dari D1 ke satu index per user (dan per
> keluarga) di R2; akun, paket, dan pembayaran ke relay; D1 tinggal untuk Zeiko S3. Fitur Drive (D…) dan bagian API yang
> menyimpan data Drive menunggu fase R yang dibutuhkannya (kolom "Butuh dulu"). Fitur S3 (S…) tidak terpengaruh.

## Aturan umum (berlaku untuk setiap prompt)

1. Baca `CLAUDE.md`, `docs/SPEC.md`, ADR yang terkait di `DECISIONS.md`, dan bagian item ini sebelum mulai.
2. Mengirim prompt berarti pemilik setuju fitur itu dibangun. Sebelum menulis kode, tulis ADR baru (nomor
   berikutnya, tanggal hari itu): apa yang dibangun, apa yang tidak, dan keputusan teknisnya. Kalau prompt
   bilang "tanya pemilik dulu", tanyakan dan tunggu jawabannya.
3. **Drive tidak boleh menambah tabel atau kolom D1** (ADR-064): data Drive masuk index R2 user/keluarga atau
   tempat lain sesuai tabel di ADR-064. Migrasi D1 (`migrations/`, append-only) hanya untuk Zeiko S3 dan untuk
   memindahkan/menghapus tabel lama Drive selama fase R. D1 khusus akses (R5/R6) hanya berisi sesi, token, OAuth,
   dan share. Index S3 per akun: tambah langkah di `MIGRATIONS`
   (`src/worker/services/s3-index.ts`).
4. Teks UI di `strings.id.ts` + `strings.en.ts`. Angka bisnis di `config-defaults.ts` lewat `services/config.ts`.
   Fitur yang butuh secret, binding, atau DNS dari pemilik didaftarkan di `services/readiness.ts` dan
   disembunyikan sampai siap.
5. Izin node selalu lewat `services/access.ts`. Setiap endpoint baru masuk suite IDOR
   (`tests/integration/idor.test.ts`).
6. Isi file tidak dikirim ke layanan luar. OCR, ekstrak teks, EXIF, dan thumbnail dikerjakan di browser atau
   di Worker sendiri.
7. Data baru tentang file atau user ikut ekspor data dan hapus akun (`services/account.ts`).
8. Production masih Workers Free (`deploy/production.json`). Cron, queue, dan endpoint baru harus hemat
   request dan CPU, dan bekerja bertahap dengan cursor.
9. Selesai bila: test unit/integrasi hijau; UI dicoba di Chrome dev (HP 360 px dan desktop, terang/gelap,
   Indonesia/Inggris); `npm run check` hijau; `PROGRESS.md` dan `peta-file.md` diperbarui; kolom Status di
   bawah diisi `selesai (ADR-xxx)`; commit Conventional Commits; `git pull --rebase origin main`; push `main`.
   Deploy, migrasi remote, dan apa pun yang membuat fitur live: tanya pemilik dulu.

## Daftar

Jenis: **Wajib** = celah besar dibanding layanan sejenis · **Diminta** = permintaan pemilik · **Sisa** = sudah
tercatat di `PROGRESS.md` · **Niche** = berguna untuk sebagian orang. Ukuran: S kecil, M sedang, L besar
(beberapa commit).

### Zeiko S3

| ID  | Fitur                                                              | Jenis       | Ukuran | Butuh dulu | Status            |
| --- | ------------------------------------------------------------------ | ----------- | ------ | ---------- | ----------------- |
| S1  | Key dengan izin terbatas (bucket, prefix, baca/tulis, kedaluwarsa) | Wajib       | M      | –          | selesai (ADR-071) |
| S2  | Tulis bersyarat `If-None-Match` / `If-Match` (sekarang diabaikan)  | Wajib (bug) | S      | –          | selesai (ADR-068) |
| S3  | Lifecycle: hapus otomatis, batalkan multipart menggantung          | Wajib       | M      | –          | selesai (ADR-072) |
| S4  | Upload multipart dari halaman `/s3`                                | Sisa        | S      | –          | selesai (ADR-075) |
| S5  | Versioning + Object Lock                                           | Niche       | L      | S3         | selesai (ADR-092) |
| S6  | Kelas Infrequent Access                                            | Niche       | M      | S3         | belum             |
| S7  | Website statis di domain sendiri                                   | Niche       | M      | –          | batal (ADR-070)   |
| S8  | Tagging, GetObject `partNumber`, checksum, PostObject              | Niche       | M      | –          | selesai (ADR-076) |
| S9  | Statistik per bucket dan log akses                                 | Niche       | M      | –          | selesai (ADR-060) |

### Fase R — Drive tanpa D1 (ADR-064)

| ID  | Langkah                                                                                                                                | Ukuran | Butuh dulu | Status                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------------------------------------- |
| R0  | Pemilik menjawab pertanyaan terbuka (lihat bagian R di bawah)                                                                          | –      | –          | dijawab                                                     |
| R1  | Format index + pustaka baca/tulis (tulis bersyarat etag + ulang), benchmark                                                            | M      | R0         | selesai (ADR-064)                                           |
| R2  | Baca dari index: explorer, detail, breadcrumb, cari, bintang, Sampah; klien tarik index dulu                                           | L      | R1         | selesai (ADR-077)                                           |
| R3  | Tulis ke index: upload + kuota, hasil pindai, ganti nama/pindah/salin/Sampah/hapus, dekorasi; gabung tulis (R2: 1 tulis/detik per key) | L      | R2         | selesai (ADR-074)                                           |
| R4  | Index keluarga `f/{familyId}/index.txt` (kepemilikan, anggota, izin)                                                                   | M      | R3         | selesai (ADR-078)                                           |
| R5  | Link share dan unduhan publik ke D1 khusus akses                                                                                       | M      | R3         | selesai (ADR-079)                                           |
| R6  | Sesi, token API, OAuth, idempotency ke D1 khusus akses                                                                                 | M      | R0         | sebagian (ADR-080): token, OAuth, idempotency; sesi ikut R7 |
| R7  | Akun, paket, pembayaran, katalog, data operator ke relay (repo Relay + ops API dibalik)                                                | L      | R0         | belum                                                       |
| R8  | Pindahkan data production, hapus tabel Drive dari D1 (D1 utama tinggal untuk S3)                                                       | M      | R2–R7      | belum                                                       |

### Zeiko Drive

Fitur di bawah dibangun di atas index R2 (fase R), bukan D1.

| ID  | Fitur                                            | Jenis   | Ukuran | Butuh dulu | Status                                   |
| --- | ------------------------------------------------ | ------- | ------ | ---------- | ---------------------------------------- |
| D1  | Riwayat versi file                               | Wajib   | L      | R3         | selesai (ADR-084)                        |
| D2  | Share ke akun tertentu + "Dibagikan dengan saya" | Wajib   | L      | R4, R5     | selesai (ADR-085)                        |
| D3  | Link minta file (orang lain hanya upload)        | Wajib   | M      | R3, R5     | selesai (ADR-086)                        |
| D4  | Panel Aktivitas (SPEC §8.1, belum dibuat)        | Wajib   | M      | R3         | selesai (ADR-083)                        |
| D5  | Dekorasi folder: warna, ikon, gambar             | Diminta | M      | –          | selesai (ADR-058); pindah ke index di R3 |
| D6  | Pencarian lanjutan + cari isi file               | Diminta | L      | R2         | selesai (ADR-090)                        |
| D7  | OCR PDF dan foto dokumen                         | Diminta | M      | D6, R3     | belum                                    |
| D8  | Galeri foto/video, bisa dicari                   | Diminta | L      | R3, (D6)   | selesai (ADR-091)                        |
| D9  | WebDAV (backup galeri HP, mount di PC)           | Wajib   | L      | R3, R6     | selesai (ADR-089)                        |
| D10 | Album di Galeri                                  | Niche   | M      | D8         | selesai (ADR-093)                        |
| D11 | Cari file kembar                                 | Niche   | S      | R2         | selesai (ADR-081)                        |
| D12 | Tanggal hapus otomatis                           | Niche   | S      | R3         | selesai (ADR-082)                        |
| D13 | Subtitle di pratinjau video                      | Niche   | S      | –          | selesai (ADR-073)                        |
| D14 | Email dua bahasa                                 | Sisa    | S      | (R7)       | selesai (ADR-069)                        |
| D15 | Logo di tengah QR                                | Sisa    | S      | –          | selesai (ADR-059)                        |
| D16 | Brankas end-to-end: analisis saja                | Niche   | S      | –          | selesai: usulan ADR-087, tunggu pemilik  |

### API & SDK

| ID  | Fitur                                               | Jenis             | Ukuran | Butuh dulu | Status                                    |
| --- | --------------------------------------------------- | ----------------- | ------ | ---------- | ----------------------------------------- |
| A1  | Token akses + auth Bearer                           | Diminta (fondasi) | M      | –          | selesai (ADR-061); simpanan pindah di R6  |
| A2  | API publik v1 + OpenAPI (Drive + kelola S3)         | Diminta           | L      | A1         | selesai (ADR-062); route Drive ikut R2/R3 |
| A3  | Login aplikasi (OAuth 2.0 + PKCE) untuk APK/desktop | Diminta           | M      | A1, A2     | selesai (ADR-063); simpanan pindah di R6  |
| A4  | SDK TypeScript (Drive + S3)                         | Diminta           | M      | A2 (A3)    | belum                                     |
| A5  | SDK untuk APK (Kotlin/Flutter)                      | Diminta, nanti    | M      | A2, A3     | belum                                     |
| A6  | Webhook Drive + S3                                  | Niche             | M      | R6, D4     | selesai (ADR-094)                         |

---

## Fase R — Drive tanpa D1 (ADR-064)

Keputusan pemilik (2026-10-26) ada di ADR-064: satu user = satu folder R2 dengan satu index (nama file, struktur
folder); keluarga satu folder satu index (plus kepemilikan); tulis bersyarat etag; index ditarik paling awal oleh semua
klien, jadi harus super ringan; Drive tidak memakai D1, akun/paket/pembayaran di relay; S3 tetap.

### R0 — Pertanyaan untuk pemilik (dijawab 2026-10-26, rinci di ADR-064)

1. **Link share, token API (A1–A3), dan sesi login** → **D1 khusus** terpisah dari D1 S3 (usul nama `zeiko-access`).
2. **Data operator** (laporan & takedown, legal hold, blocklist hash, audit, iklan) → **relay**.
3. **Notifikasi, preferensi email, daftar berhenti berlangganan** → **relay** (selesai, ADR-065).
   `telegram_links` dan `contacts` dibuang (migrasi `0017`).
4. **Batas kuota dan paket** → relay sumber kebenarannya, menulis salinan kecil ke `u/{userId}/` setiap kali berubah.
5. **Index** → `index.txt`, JSON tabel ringkas (format v1 di ADR-064: satu baris per entri, tanpa gzip di R2).
6. **Fitur Drive baru dibekukan** sampai R3 selesai. Fitur S3 boleh jalan.
7. **Batas R2 1 tulis/detik per key** → R3 menggabungkan tulis (upload per gelombang, pindai/thumbnail per batch),
   tanpa layanan Cloudflare tambahan.

### R1–R8

Setiap langkah: ADR kecil kalau ada keputusan baru, test (termasuk dua penulis bersamaan dan IDOR), `npm run check`,
uji Chrome dev, commit, push. Langkah yang menyentuh relay dikerjakan juga di repo `Relay` (cek `cargo fmt`, `clippy`,
test). Deploy dan memindahkan data production (R8) hanya dengan izin pemilik.

```text
Kerjakan R<n> dari docs/ROADMAP.md (ikuti "Aturan umum" dan ADR-064). Baca bagian fase R dan jawaban pemilik untuk R0
di ADR-064 dulu. Jangan menambah tabel atau kolom D1 untuk Drive.
```

---

## Yang sudah selesai (ringkasan)

Prompt untuk item yang sudah selesai dihapus pada 2026-11-03. Ringkasan di bawah menjelaskan apa yang sudah ada, di mana
letaknya, dan keputusan yang masih berlaku. Rinciannya ada di ADR (`DECISIONS.md`), sedangkan status production ada di
`PROGRESS.md`. Item yang masih menunggu pemilik ditandai **Belum**.

### Fase R

- **R1 (ADR-064).** Format index v1 di `shared/drive-index.ts`: header ditambah satu baris JSON per entri, disimpan polos
  di R2. Pustakanya `services/drive-index.ts` (`IndexDoc`, `readIndex`, `changeIndex` dengan syarat etag lalu ulang).
  Benchmark: `npm run bench:index`.
- **R2 (ADR-077).** Drive pribadi dibaca dari index lewat `shared/drive-tree.ts` (dipakai Worker dan app) dan
  `services/drive-read.ts`. `GET /api/drive/index` (+ v1, ETag/304) ditarik app paling awal. Yang masih dari D1: upload
  berjalan, Terbaru, dan bintang keluarga.
- **R3 (ADR-074).** Setiap perubahan pohon pribadi ditulis ke `u/{userId}/index.txt` sebagai proyeksi D1 (kolom `x` =
  id D1). Tulisnya digabung lewat `manifest_dirty` (satu gelombang = satu tulis), dengan cron `drive_index_flush`
  sebagai cadangan. Kode yang mengubah `nodes` wajib menandai user-nya (lihat `CLAUDE.md`).
- **R4 (ADR-078).** Index keluarga `f/{familyId}/index.txt` (anggota di header, pemilik per entri) bisa ditulis oleh
  flush anggota mana pun. Ruang keluarga dibaca dari index ini.
- **R5 (ADR-079).** Link share pindah ke D1 khusus akses `ACCESS_DB` (`zeiko-access`, `migrations-access/`). Database
  ini tidak pernah di-join dengan D1 utama.
- **R6, sebagian (ADR-080).** Token API, OAuth, dan Idempotency-Key sudah di D1 akses. **Belum:** sesi Better Auth
  masih di D1 utama bersama `users`, dan baru pindah bersama R7.

### Zeiko S3

- **S1 key terbatas (ADR-071).** Key bisa dibatasi ke bucket tertentu (plus prefix), ke izin baca+tulis, baca saja,
  atau tulis saja, dan ke tanggal kedaluwarsa. Key lama tetap akses penuh, dan hanya key tanpa batas yang boleh
  mengelola bucket. ListBuckets difilter, presigned URL ikut aturan yang sama, dan link di `/s3` memakai key yang
  boleh membaca.
- **S2 tulis bersyarat (ADR-068).** `If-None-Match: *` dan `If-Match` di PutObject, CopyObject (tujuan), dan
  CompleteMultipartUpload dicek di batch D1 yang sama dengan commit index, jadi dari dua penulis tepat satu yang
  menang. Bentrok di tengah complete → 409 `ConditionalRequestConflict`; syarat lain di operasi tulis → 501.
- **S3 lifecycle (ADR-072).** Put/Get/DeleteBucketLifecycleConfiguration: Expiration (Days/Date) dan
  AbortIncompleteMultipartUpload, dengan filter prefix dan ukuran (Tag/And sejak S8, versi lama sejak S5). Dijalankan
  cron jam-an bertahap dengan cursor. Editornya "Hapus otomatis" di `/s3`. Transition menunggu S6.
- **S4 upload multipart dari `/s3` (ADR-075).** File di atas 32 MiB naik per part lewat
  `/api/s3/buckets/:name/uploads/*`: paralel, coba ulang per part, jeda/lanjut, dan batal. Maksimal 50 GiB per file.
- **S5 versioning + Object Lock (ADR-092).** `s3_versions` ada di index per akun (v7), versi terbaru tetap di
  `s3_objects`. Sudah ada ListObjectVersions, `versionId`, delete marker, dan pemulihan. Object Lock memakai
  GOVERNANCE/COMPLIANCE dan legal hold. Pemilik: versi lama dihitung ke kuota dan tagihan, dan objek berkunci ikut
  terhapus di tahap hapus dunning. Yang masih kurang untuk Veeam dicatat di ADR.
- **S8 kompatibilitas tambahan (ADR-076).** Object tagging, `partNumber` di GetObject/HeadObject, checksum
  CRC32/CRC32C/CRC64NVME/SHA-1/SHA-256 (CRC dihitung hanya sampai `s3_checksum_crc_max_bytes` karena batas CPU Workers
  Free), GetObjectAttributes, dan PostObject (form HTML + policy SigV4).
- **S9 statistik + log akses (ADR-060).** Per bucket di `/s3`: jumlah objek, ukuran, serta request, error, dan unduhan
  30 hari. Log PutBucketLogging berformat Amazon dikirim per jam ke bucket milik akun sendiri, dengan IP di-hash.

### Zeiko Drive

- **D1 riwayat versi (ADR-084).** Versi adalah baris `nodes` `kind='version'` di bawah file-nya (tanpa tabel baru),
  dengan kolom index `vs`. Mengganti isi menukar `blob_id` di node yang sama. Versi dihitung penuh ke kuota (`USED_SQL`).
  Jumlah versi diatur per ruang di header index (`keepVersions`). Umurnya maksimal `version_keep_days` (30), lalu
  dibuang cron `purge_versions`.
- **D2 share ke akun (ADR-085).** Izin disimpan di `node_grants` (D1 akses), dan izin folder diwariskan lewat
  `nodeAccess`. Item baru di ruang pribadi milik pemilik ruangnya. Ada halaman "Dibagikan dengan saya" (`/untuk-saya`),
  tab Orang di dialog Bagikan, dan undangan ke email yang belum terdaftar.
- **D3 link minta file (ADR-086).** Tabel `file_requests` ada di D1 akses. Halaman `/minta/{r64}/{s32}` bisa dipakai
  tanpa akun dan tanpa iklan. Upload memakai protokol multipart yang sama atas nama pemilik, ke subfolder per
  pengirim, dengan Turnstile dan password opsional. Notifikasinya digabung per jam.
- **D4 Aktivitas (ADR-083).** Log disimpan per ruang per bulan di R2 (`u|f/…/log/YYYY-MM.txt`), tampil di panel Detail
  dan halaman Terbaru, dengan retensi `activity_keep_days`.
- **D5 dekorasi folder (ADR-058).** Pilihannya 12 warna, ikon (24 pilihan atau satu emoji), dan gambar sampul dari ruang
  yang sama. Tampil di explorer, breadcrumb, dialog Pindahkan, hasil cari, dan banner folder. Share publik tidak
  memakai sampul. Sejak R3 dekorasi ikut ditulis ke index.
- **D6 pencarian lanjutan (ADR-090).** Parser bersama `shared/search-query.ts` mengerti ID/EN: frasa, `-`, ATAU/OR,
  jenis, ext, tanggal, ukuran, folder, ruang, bintang, dan dibagikan. Ada juga panel Filter dan sorot kata. Untuk cari
  isi file, teks diambil di browser (teks, PDF, .docx, .xlsx) dan disimpan ke objek `u|f/…/text.txt` di R2. Saklarnya
  per orang, **default mati**. **Belum:** kalimat Kebijakan Privasi (usulannya di ADR-090, teksnya milik pemilik).
- **D8 Galeri (ADR-091).** Kolom index `md` (tanggal diambil, lebar, tinggi, durasi) dibaca di Worker setelah scan
  (`lib/media-meta.ts`, tanpa GPS). File lama diisi cron `media_backfill`. Galeri ada di halaman `/galeri` dan
  `GET /api/gallery` (+ v1), dengan sintaks D6.
- **D9 WebDAV (ADR-089).** Host sendiri `DAV_ORIGIN`, login Basic dengan email dan token ber-scope `webdav`, semua
  metode termasuk LOCK, PUT maksimal 95 MiB. **Belum:** `davOrigin` di `deploy/production.json` lalu deploy (izin
  pemilik), dan uji manual FolderSync, Windows, dan Finder oleh pemilik.
- **D10 Album (ADR-093).** Disimpan di `u|f/…/albums.json` di R2, berisi referensi ke file tanpa memakan kuota. Izinnya
  mengikuti file. Ada tab Album di `/galeri`, dan album bisa dibagikan lewat link bundle.
- **D11 file kembar (ADR-081).** Halaman `/kembar` membaca index pribadi dan keluarga, dengan hash dari `blobs.sha256`,
  dan hanya membandingkan di dalam pool sendiri.
- **D12 tanggal hapus otomatis (ADR-082).** Kolom index `ex` (kolom pertama yang hanya ada di index). Cron malam
  memindahkan item ke Sampah, dengan pengingat H-1.
- **D13 subtitle (ADR-073).** `.srt`/`.vtt` dengan nama dasar yang sama dipasang otomatis, atau dipilih sendiri. SRT
  diubah ke WebVTT di browser, dan ukuran teksnya bisa diatur.
- **D14 email dua bahasa (ADR-069).** Teks email dan lonceng ada di `strings.*.ts`, bagian `mail`. Email memakai
  `users.locale` penerima, sedangkan email share dan undangan memakai bahasa pengirim.
- **D15 logo di QR (ADR-059).** Logo Zeiko di tengah QR share dan QR undangan keluarga.
- **D16 Brankas end-to-end (ADR-087, diusulkan).** Analisis saja, tanpa kode: dampaknya ke scan, takedown, pemulihan,
  dan share, dengan pilihan A passkey PRF, B kata sandi + Argon2id, atau C gabungan keduanya. **Belum:** jawaban pemilik
  atas 4 pertanyaan di ADR.

### API & SDK

- **A1 token akses (ADR-061).** `api_tokens` menyimpan hash SHA-256, prefix publik, scope, kedaluwarsa, dan status
  cabut. Bearer hanya diterima di `/api/v1` dan host WebDAV, dengan `RL_API` per token. Dikelola di Pengaturan → Token
  & aplikasi. Sejak R6 disimpan di D1 akses.
- **A2 API v1 + OpenAPI (ADR-062).** `/api/v1` mencakup akun, Drive, upload multipart, share, dan kelola S3, dengan
  scope per operasi, Idempotency-Key, dan 300 request/menit per token. `/api/v1/openapi.json` dibuat dari skema zod
  router, dan dokumentasinya di halaman `/developer`.
- **A3 OAuth 2.0 + PKCE (ADR-063).** Untuk klien pihak pertama (Android, desktop, CLI): `/oauth/authorize`, token dengan
  rotasi refresh dan deteksi pemakaian ulang, revoke, dan Pengaturan → Aplikasi tersambung. **Belum:** App Links
  (`androidPackage` + `androidCertSha256` di `deploy/production.json`), device flow, dan aplikasi pihak ketiga.
- **A6 webhook (ADR-094).** Endpoint disimpan di D1 akses. Event Drive datang dari aktivitas dan hasil scan, event S3
  dari `PutBucketNotificationConfiguration`. Pengiriman lewat antrean `notify`, ditandatangani HMAC-SHA256 dengan
  timestamp, dicoba ulang, dan mati otomatis setelah 5 kali gagal berturut-turut. SSRF dicek setiap kirim. Log 7 hari
  tampil di Pengaturan dan `/s3`.

---

## Zeiko S3

### S6 — Kelas Infrequent Access

```text
Kerjakan S6 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): kelas penyimpanan Infrequent Access di
Zeiko S3, memakai R2 Infrequent Access.

Tanya pemilik dulu: harga per GB per bulan, biaya ambil per GB, dan biaya hapus dini. R2 IA punya minimal lama
simpan dan biaya ambil; cek angka terbarunya di docs Cloudflare, lalu tunjukkan ke pemilik bersama hitungan
marginnya. Semua angka masuk config.

Lalu:
- x-amz-storage-class STANDARD dan STANDARD_IA di PutObject, CreateMultipartUpload, dan CopyObject; simpan
  di index; ListObjects dan HeadObject melaporkan StorageClass yang benar; kelas lain → InvalidStorageClass.
- Tulis ke R2 dengan storageClass yang sesuai (cek dukungan di binding dan di shim dev), termasuk replika.
- Lifecycle Transition (setelah S3): pindah ke IA setelah N hari.
- Billing (services/s3-billing.ts): pemakaian per kelas, biaya ambil dari egress IA, ditagih saat
  perpanjangan seperti egress sekarang. Halaman /s3 dan katalog publik menampilkan harganya.

Test: kelas tersimpan dan dilaporkan, transisi oleh cron, hitungan tagihan dengan jam palsu.
```

### S7 — Website statis di domain sendiri

> **Dibatalkan (ADR-070, pemilik 2026-10-28):** S3 tidak boleh jadi website (ToS). Website dijual sebagai Zeiko Hosting
> (situs statis, repo Relay).

```text
Kerjakan S7 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): website statis dari bucket Zeiko S3,
hanya di domain milik pelanggan (ADR-048).

Tanya pemilik dulu: termasuk paket S3 atau add-on berbayar, dan berapa harganya.

Keamanan, tulis di ADR: objek sekarang sengaja dilayani dengan Content-Security-Policy: sandbox
(src/worker/routes/s3-api.ts) supaya HTML orang tidak jalan di domain Zeiko. Website hanya boleh di alamat
domain sendiri (s3_urls jenis custom), tidak pernah di s3.zeiko.biz.id atau s3.<nama>.zeiko.biz.id, supaya
situs phishing tidak menempel di zona zeiko.biz.id. Laporan penyalahgunaan dan takedown
(docs/runbook/takedown.md) harus bisa mematikan situsnya.

Buat:
- Put/Get/DeleteBucketWebsite (IndexDocument, ErrorDocument, RedirectAllRequestsTo opsional); hapus 'website'
  dari UNSUPPORTED_SUB.
- Domain sendiri yang tersambung ke bucket ber-website: GET/HEAD tanpa tanda tangan; "/" → index.html;
  folder → folder/index.html; tidak ketemu → ErrorDocument dengan status 404; Content-Type dari objek; header
  dasar (nosniff, HSTS); tanpa listing. Hanya objek yang sudah lolos scan.
- Di /s3: pilihan menyambungkan domain sendiri ke bucket sebagai website.

Test: routing index/error, objek yang belum discan tidak dilayani, host lain tetap sandbox, takedown
mematikan situs.
```

---

## Zeiko Drive

### D7 — OCR PDF dan foto dokumen

```text
Kerjakan D7 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): OCR untuk PDF hasil scan dan foto dokumen
(permintaan pemilik). Sebaiknya dikerjakan setelah D6, supaya teks hasil OCR bisa dicari.

- Semuanya di browser (aturan ADR-050: isi file tidak dikirim ke mana pun). Pakai tesseract.js dengan bahasa
  ind dan eng. Data bahasa dan core wasm dibundel dan dilayani dari origin sendiri (mis. /tesseract-<versi>/,
  disalin plugin di vite.config.ts seperti pdfjsAssets), bukan dari CDN. CSP app
  (src/worker/middleware/base.ts) sudah punya 'wasm-unsafe-eval' sejak ADR-067; jangan melonggarkan CSP lebih jauh.
- PDF: render tiap halaman dengan pdf.js (src/web/editors/pdf/pdfjs.ts) di resolusi cukup (sekitar 300 dpi),
  lewati halaman yang sudah punya teks, OCR satu halaman demi satu di worker (hemat memori HP), lalu tulis
  lapisan teks tak terlihat di atas halaman asli dengan pdf-lib (TextRenderingMode Invisible, posisi dari
  bbox kata). Font standar pdf-lib hanya bisa menulis huruf WinAnsi; embed font Unicode (pdf-lib + fontkit)
  atau tulis keputusanmu di ADR.
- Foto atau gambar dokumen: hasilnya teks (.txt) atau PDF yang bisa dicari.
- Bisa dibuka dari PDF editor (tab Alat), menu ⋮ "Jadikan bisa dicari (OCR)", pratinjau PDF/gambar, dan kartu
  di /alat. Pilih bahasa, progres per halaman, bisa dibatalkan. Simpan sebagai file baru atau ganti asli
  (setelah D1, isi lama menjadi versi). Teks hasil OCR masuk indeks isi D6
  (objek teks per ruang di R2, hanya kalau saklar cari isi file orang itu menyala, ADR-090).
- Batas halaman di config (mis. ocr_max_pages), ukuran memakai editor_pdf_max_bytes yang sudah ada. Teks UI
  tidak menjanjikan berlebihan: hasil untuk tulisan tangan dan foto miring kurang bagus.

Test: unit konversi bbox → koordinat PDF (halaman diputar, ukuran halaman berbeda); fixture PDF scan kecil di
tests/fixtures yang teksnya bisa diambil pdf.js setelah OCR. Uji di Chrome dev dengan build production (CSP).
```

---

## API & SDK

### A4 — SDK TypeScript

```text
Kerjakan A4 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): SDK TypeScript untuk Drive dan Zeiko S3
(permintaan pemilik). Butuh A2 (dan A3 untuk login aplikasi).

- Folder sdk/js di repo ini dengan package.json sendiri. Nama usulan @zeiko/sdk; nama dan publikasi ke npm
  hanya setelah pemilik setuju, jadi jangan publish. ESM + .d.ts, tanpa node:*, jalan di Node 18+, browser,
  dan React Native.
- Tipe dibuat dari /api/v1/openapi.json (mis. openapi-typescript sebagai devDependency) dan dicek di CI supaya
  tidak basi.
- DriveClient: auth dengan token (A1) atau helper OAuth PKCE (A3); list, cari, detail; upload multipart yang
  bisa dilanjutkan (part, paralel, coba ulang, progres; pelajari src/web/upload/manager.ts); unduh dengan
  Range; share; error bertipe.
- S3: zeikoS3Client({ accessKeyId, secretAccessKey }) yang mengembalikan S3Client AWS SDK v3 dengan endpoint,
  region (S3_REGION), dan forcePathStyle yang benar (AWS SDK jadi peerDependency); helper presign untuk upload
  dan unduh; S3Admin untuk API kelola v1 (key, bucket, pemakaian, CORS, lifecycle).
- README dua bahasa dengan contoh: Node (upload folder), browser (upload langsung ke bucket dengan presigned URL
  + CORS), React Native. Peringatan yang jelas: jangan menaruh key S3 akses penuh di APK; pakai key terbatas
  (S1) atau presigned URL dari server sendiri.
- npm run check di root ikut membangun dan mengetes SDK (atau skrip terpisah yang juga dijalankan CI).

Test: unit dengan fetch tiruan; integrasi terhadap runtime test yang ada (tests/helpers) untuk upload multipart
yang dilanjutkan setelah putus dan untuk presign S3.
```

### A5 — SDK untuk APK

```text
Kerjakan A5 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): SDK untuk APK (permintaan pemilik, "nanti").
Butuh A2 dan A3.

Tanya pemilik dulu APK-nya dibuat dengan apa: Kotlin native, Flutter, atau React Native (kalau React Native,
SDK A4 sudah cukup). Lalu buat: client dari OpenAPI (openapi-generator untuk Kotlin/Dart) ditambah lapisan
tulisan tangan untuk login OAuth PKCE lewat App Links/Custom Tabs, upload multipart yang bisa lanjut di
background (WorkManager di Android), dan unduh dengan Range. Letaknya di sdk/<bahasa> atau repo terpisah,
sesuai keputusan pemilik. Sertakan contoh aplikasi kecil: login, daftar folder, upload foto dari galeri.
```
