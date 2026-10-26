# Roadmap Zeiko Drive & Zeiko S3

Dibuat 2026-10-26 dari pemeriksaan kode `main` (`d213155`). Isinya fitur yang **belum ada** di kode.

**Cara pakai.** Buka sesi baru di repo ini, lalu ketik misalnya `Kerjakan S1 dari docs/ROADMAP.md`. Satu ID
= satu fitur = satu ADR, dengan satu atau beberapa commit. Prompt di tiap bagian juga bisa disalin utuh ke sesi
lain. Setelah selesai, sesi itu mengisi kolom Status di tabel.

## Aturan umum (berlaku untuk setiap prompt)

1. Baca `CLAUDE.md`, `docs/SPEC.md`, ADR yang terkait di `DECISIONS.md`, dan bagian item ini sebelum mulai.
2. Mengirim prompt berarti pemilik setuju fitur itu dibangun. Sebelum menulis kode, tulis ADR baru (nomor
   berikutnya, tanggal hari itu): apa yang dibangun, apa yang tidak, dan keputusan teknisnya. Kalau prompt
   bilang "tanya pemilik dulu", tanyakan dan tunggu jawabannya.
3. Migrasi D1 utama: file baru berikutnya di `migrations/` (append-only). Index S3 per akun: tambah langkah di
   `MIGRATIONS` (`src/worker/services/s3-index.ts`).
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

| ID  | Fitur                                                              | Jenis       | Ukuran | Butuh dulu | Status |
| --- | ------------------------------------------------------------------ | ----------- | ------ | ---------- | ------ |
| S1  | Key dengan izin terbatas (bucket, prefix, baca/tulis, kedaluwarsa) | Wajib       | M      | –          | belum  |
| S2  | Tulis bersyarat `If-None-Match` / `If-Match` (sekarang diabaikan)  | Wajib (bug) | S      | –          | belum  |
| S3  | Lifecycle: hapus otomatis, batalkan multipart menggantung          | Wajib       | M      | –          | belum  |
| S4  | Upload multipart dari halaman `/s3`                                | Sisa        | S      | –          | belum  |
| S5  | Versioning + Object Lock                                           | Niche       | L      | S3         | belum  |
| S6  | Kelas Infrequent Access                                            | Niche       | M      | S3         | belum  |
| S7  | Website statis di domain sendiri                                   | Niche       | M      | –          | belum  |
| S8  | Tagging, GetObject `partNumber`, checksum, PostObject              | Niche       | M      | –          | belum  |
| S9  | Statistik per bucket dan log akses                                 | Niche       | M      | –          | belum  |

### Zeiko Drive

| ID  | Fitur                                            | Jenis   | Ukuran | Butuh dulu | Status |
| --- | ------------------------------------------------ | ------- | ------ | ---------- | ------ |
| D1  | Riwayat versi file                               | Wajib   | L      | –          | belum  |
| D2  | Share ke akun tertentu + "Dibagikan dengan saya" | Wajib   | L      | –          | belum  |
| D3  | Link minta file (orang lain hanya upload)        | Wajib   | M      | –          | belum  |
| D4  | Panel Aktivitas (SPEC §8.1, belum dibuat)        | Wajib   | M      | –          | belum  |
| D5  | Dekorasi folder: warna, ikon, gambar             | Diminta | M      | –          | selesai (ADR-058) |
| D6  | Pencarian lanjutan + cari isi file               | Diminta | L      | –          | belum  |
| D7  | OCR PDF dan foto dokumen                         | Diminta | M      | D6         | belum  |
| D8  | Galeri foto/video, bisa dicari                   | Diminta | L      | (D6)       | belum  |
| D9  | WebDAV (backup galeri HP, mount di PC)           | Wajib   | L      | A1         | belum  |
| D10 | Album di Galeri                                  | Niche   | M      | D8         | belum  |
| D11 | Cari file kembar                                 | Niche   | S      | –          | belum  |
| D12 | Tanggal hapus otomatis                           | Niche   | S      | –          | belum  |
| D13 | Subtitle di pratinjau video                      | Niche   | S      | –          | belum  |
| D14 | Email dua bahasa                                 | Sisa    | S      | –          | belum  |
| D15 | Logo di tengah QR                                | Sisa    | S      | –          | belum  |
| D16 | Brankas end-to-end: analisis saja                | Niche   | S      | –          | belum  |

### API & SDK

| ID  | Fitur                                               | Jenis             | Ukuran | Butuh dulu | Status |
| --- | --------------------------------------------------- | ----------------- | ------ | ---------- | ------ |
| A1  | Token akses + auth Bearer                           | Diminta (fondasi) | M      | –          | belum  |
| A2  | API publik v1 + OpenAPI (Drive + kelola S3)         | Diminta           | L      | A1         | belum  |
| A3  | Login aplikasi (OAuth 2.0 + PKCE) untuk APK/desktop | Diminta           | M      | A1, A2     | belum  |
| A4  | SDK TypeScript (Drive + S3)                         | Diminta           | M      | A2 (A3)    | belum  |
| A5  | SDK untuk APK (Kotlin/Flutter)                      | Diminta, nanti    | M      | A2, A3     | belum  |
| A6  | Webhook Drive + S3                                  | Niche             | M      | A1, D4     | belum  |

### Urutan yang disarankan

1. **Risiko dan cepat:** S2 → S1 → S3 → D5 → D4.
2. **Cari dan lihat:** D6 → D8 → D7 → D1.
3. **Platform:** A1 → A2 → A3 → A4 → D9.
4. **Kolaborasi:** D3 → D2 → S4.
5. Sisanya sesuai kebutuhan. A5 dikerjakan saat APK mulai dibuat.

---

## Zeiko S3

### S1 — Key dengan izin terbatas

```text
Kerjakan S1 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): key Zeiko S3 dengan izin terbatas.

Sekarang setiap baris s3_keys (migrations/0007_s3.sql) bisa melakukan apa saja di semua bucket akun,
termasuk DeleteBucket. Tambahkan pilihan saat membuat key:
- bucket: semua (default, sama dengan key lama) atau daftar bucket tertentu, plus satu prefix opsional;
- izin: baca+tulis, baca saja, atau tulis saja;
- kedaluwarsa: tanpa batas atau tanggal tertentu.

Aturan:
- Key lama tetap akses penuh (migrasi baru; kolom NULL = tanpa batas).
- Petakan setiap operasi di src/worker/routes/s3-api.ts ke baca, tulis, atau kelola. Key yang dibatasi
  bucket tidak boleh CreateBucket, DeleteBucket, PutBucketAcl, atau Put/DeleteBucketCors. ListBuckets hanya
  menampilkan bucket miliknya. Di luar izin → AccessDenied (403, XML S3). CopyObject butuh izin baca di
  sumber dan tulis di tujuan. Untuk key ber-prefix, ListObjects hanya boleh dengan prefix di dalam prefix key.
- Presigned URL dari key terbatas ikut aturan yang sama. Key kedaluwarsa ditolak; perhatikan cache di
  lookupKey/forgetKey (src/worker/services/s3.ts).
- services/s3-browse.ts menandatangani link dengan key terbaru akun. Ubah supaya memakai key akses penuh
  yang masih aktif, atau key internal khusus app yang tidak tampil di daftar. Link di /s3 tidak boleh rusak
  hanya karena key terbaru ternyata baca saja.
- Halaman /s3: form buat key dengan pilihan di atas; daftar key menampilkan cakupannya. Contoh aws-cli dan
  rclone tetap benar. Batas jumlah key tetap s3_max_keys_per_account.

Test: integrasi dengan @aws-sdk/client-s3 (sudah devDependency) untuk tiap kombinasi izin, presigned URL,
kedaluwarsa, ListBuckets terfilter, dan IDOR (key akun A ke bucket akun B tetap ditolak).
```

### S2 — Tulis bersyarat

```text
Kerjakan S2 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): tulis bersyarat di Zeiko S3.

Bug sekarang: writeObject di src/worker/routes/s3-api.ts tidak membaca If-None-Match / If-Match. PutObject
dengan "If-None-Match: *" tetap menimpa objek yang sudah ada dan menjawab 200. Klien yang memakainya untuk
mengunci (Terraform S3 backend use_lockfile, tool data lake) mengira kuncinya aman padahal tidak.

Buat:
- PutObject, CompleteMultipartUpload, dan CopyObject (tujuan): "If-None-Match: *" → 412 PreconditionFailed
  kalau key sudah ada; If-Match: "<etag>" → 412 kalau key tidak ada atau ETag-nya beda. Header bersyarat
  lain di operasi tulis → NotImplemented, jangan diabaikan.
- Kondisinya dicek saat commit index di D1 (INSERT/UPDATE bersyarat dalam satu statement atau batch), bukan
  baca lalu tulis, supaya dua penulis bersamaan tidak sama-sama lolos. Penulis yang kalah: blob barunya
  dihapus dari R2 dan reservasi byte dilepas (services/s3-objects.ts, reserve/release di services/s3.ts),
  sama seperti jalur gagal yang sudah ada. Kalau dua commit bentrok di saat yang sama: 409
  ConditionalRequestConflict.
- Replika (services/s3-replicas.ts) dan scan hanya jalan untuk penulis yang menang.

Test: dua PutObject paralel dengan If-None-Match:* → tepat satu 200 dan satu 412; If-Match benar dan salah;
multipart complete bersyarat; copy bersyarat; used_bytes akun tetap benar setelah penulis gagal. Pakai
parameter IfNoneMatch/IfMatch di @aws-sdk/client-s3.
```

### S3 — Lifecycle

```text
Kerjakan S3 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): lifecycle bucket Zeiko S3.

Sekarang ?lifecycle dijawab NotImplemented (UNSUPPORTED_SUB di src/worker/routes/s3-api.ts). Buat
Put/Get/DeleteBucketLifecycleConfiguration dengan bagian berikut:
- Rule: ID, Status (Enabled/Disabled), Filter berupa Prefix serta ObjectSizeGreaterThan/LessThan (Tag
  menyusul setelah S8);
- Expiration: Days atau Date;
- AbortIncompleteMultipartUpload: DaysAfterInitiation;
- NoncurrentVersionExpiration hanya kalau S5 sudah ada, Transition hanya kalau S6 sudah ada. Elemen lain →
  MalformedXML/NotImplemented yang jelas, jangan diam-diam diabaikan.
Batas jumlah rule per bucket di config (mis. s3_lifecycle_max_rules).

Simpan aturannya di s3_buckets (migrasi baru, kolom JSON seperti cors_json). Pelaksananya cron yang sudah ada
(src/worker/cron/tasks.ts): hitung hari seperti AWS (dari waktu objek dibuat, dibulatkan ke tengah malam UTC
berikutnya) dan hapus lewat jalur hapus yang sudah ada (deleteObjects di services/s3-objects.ts) supaya
used_bytes, replika, dan index tetap benar. Kerjakan bertahap dengan cursor per bucket dan anggaran per
invocation, karena production masih Workers Free.

Halaman /s3: editor lifecycle sederhana per bucket ("hapus objek di prefix X setelah N hari", "batalkan upload
yang menggantung setelah N hari"), dua bahasa, mirip editor CORS (ADR-055).

Test: parse/serialize XML (termasuk yang dikirim aws-cli put-bucket-lifecycle-configuration); cron dengan jam
palsu menghapus tepat objek yang kedaluwarsa; multipart menggantung dibatalkan; akun dengan billing_state
readonly/locked diproses sesuai aturan dunning yang ada.
```

### S4 — Upload multipart dari `/s3`

```text
Kerjakan S4 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): upload file besar dari halaman /s3.

Sekarang upload lewat app dibatasi s3_web_upload_max_bytes (95 MiB, karena body request di Cloudflare
maksimal 100 MB). Buat upload multipart di src/web/pages/S3Browser.tsx. Cara paling sederhana: setiap part
dikirim ke API app (src/worker/routes/s3.ts), satu request per part ≤ s3_web_upload_max_bytes, memakai
createUpload/uploadPart/completeUpload/abortUpload dari services/s3-objects.ts, jadi tidak bergantung pada
CORS bucket. Bagian berjalan paralel, coba ulang per part, jeda/lanjut, batal (abort), dan progres tampil di
panel transfer yang sudah ada (src/web/lib/transfer.ts, batas per perangkat ADR-053). Ukuran part dan batas
total di config.

Test: integrasi endpoint part (izin, urutan, abort, kuota); uji di Chrome dev dengan file > 200 MB, jeda/lanjut,
dan jaringan putus.
```

### S5 — Versioning + Object Lock

```text
Kerjakan S5 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): versioning dan Object Lock di Zeiko S3.
Ini besar: versioning dulu, Object Lock di commit sesudahnya.

Tanya pemilik dulu, lalu tulis jawabannya di ADR:
1. Versi lama dihitung ke kuota dan tagihan? (Usul: ya, seperti AWS.)
2. Kalau paket tidak dibayar dan sampai tahap hapus (s3_dunning), objek berkunci COMPLIANCE ikut dihapus?
   (Usul: ya; kunci tidak berlaku melewati masa paket yang dibayar. Ini perlu kalimat di ToS, dan teks ToS
   hanya boleh diubah pemilik.)

Versioning:
- Index per akun (services/s3-index.ts, langkah baru di MIGRATIONS): tabel versi (bucket, key, version_id,
  blob_id, size, etag, delete_marker, modified_at, …); s3_objects tetap menunjuk versi terbaru supaya listing
  biasa tetap cepat.
- Put/GetBucketVersioning (Enabled/Suspended), ListObjectVersions, versionId di GetObject, HeadObject,
  DeleteObject, dan CopyObject (sumber), delete marker, header x-amz-version-id. Hapus 'versions' dari
  UNSUPPORTED_SUB.
- Kuota, egress, replika (s3-replicas.ts), scan, ekspor data, dan hapus akun mencakup semua versi.
  Lifecycle (S3) mendapat NoncurrentVersionExpiration.

Object Lock:
- CreateBucket dengan x-amz-bucket-object-lock-enabled, Put/GetObjectLockConfiguration (default GOVERNANCE
  atau COMPLIANCE, Days/Years), Put/GetObjectRetention, Put/GetObjectLegalHold, dan
  x-amz-bypass-governance-retention (hanya untuk key akses penuh, lihat S1). Versi yang terkunci tidak bisa
  dihapus sampai tanggalnya lewat.
- Halaman /s3: nyalakan versioning, lihat dan pulihkan versi objek, status kunci.

Test: alur versi lengkap dengan AWS SDK v3, delete marker, pemulihan, kuota per versi, kunci menolak hapus,
governance bypass, lifecycle untuk versi lama. Catat di ADR apa saja yang masih kurang untuk Veeam dan tool
backup lain.
```

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

### S8 — Kompatibilitas tambahan

```text
Kerjakan S8 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): kompatibilitas S3 tambahan. Satu commit
per bagian, dengan urutan:

1. Object tagging: Put/Get/DeleteObjectTagging, header x-amz-tagging di PutObject dan CreateMultipartUpload,
   x-amz-tagging-directive di CopyObject, dengan batas seperti AWS (10 tag, panjang key/value). Simpan di
   index (langkah baru di MIGRATIONS). Lifecycle (S3) mendapat filter Tag dan And.
2. GetObject/HeadObject dengan partNumber (sekarang NotImplemented): simpan ukuran tiap part saat
   CompleteMultipartUpload; kembalikan x-amz-mp-parts-count dan Content-Range untuk part itu.
3. Checksum: trailer x-amz-checksum-* sekarang diterima tapi tidak dicek (src/worker/lib/aws-chunked.ts).
   Verifikasi CRC32, CRC32C, SHA-1, dan SHA-256 yang dikirim klien (CRC64NVME kalau sanggup), simpan, dan
   kembalikan saat x-amz-checksum-mode: ENABLED; tambahkan GetObjectAttributes.
4. PostObject: upload dari form HTML dengan policy SigV4 (POST ke bucket), termasuk kondisi
   content-length-range dan starts-with, success_action_status/redirect, dan batas body 100 MB.

Hapus sub-resource yang sudah didukung dari UNSUPPORTED_SUB. Test tiap bagian dengan @aws-sdk/client-s3
(untuk PostObject, tambahkan @aws-sdk/s3-presigned-post sebagai devDependency kalau perlu).
```

### S9 — Statistik per bucket dan log akses

```text
Kerjakan S9 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): statistik per bucket dan log akses Zeiko S3.

- Di /s3, per bucket: jumlah objek dan byte (dari index), serta request dan egress per hari selama 30 hari
  terakhir. Request dan egress dicatat per bucket per hari (lihat track di src/worker/lib/analytics.ts dan
  meterS3Egress di services/s3-billing.ts). Pilih Analytics Engine atau tabel harian D1, dan tulis alasannya
  di ADR (biaya tulis D1 per request vs batas Analytics Engine di Workers Free).
- Log akses opsional per bucket (PutBucketLogging): baris log berformat server access log S3 ditulis berkala
  sebagai objek ke bucket tujuan milik akun yang sama. Cara menyimpan IP harus sesuai Kebijakan Privasi; kalau
  kebijakan tidak mengizinkan IP mentah, simpan hash-nya atau tanya pemilik. Hapus 'logging' dari
  UNSUPPORTED_SUB.

Test: angka statistik cocok dengan request uji; log terkirim ke bucket tujuan dan tidak bisa diarahkan ke
bucket akun lain.
```

---

## Zeiko Drive

### D1 — Riwayat versi file

```text
Kerjakan D1 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): riwayat versi file di Drive.

SPEC §17 menaruh fitur ini di luar cakupan; prompt ini persetujuan pemilik untuk membangunnya. Sebelum mulai,
tanya pemilik lalu tulis di ADR: apakah versi lama dihitung ke kuota (usul: ya), dan berapa banyak/berapa lama
versi disimpan (usul config: 30 hari dan maksimal 25 versi, kecuali yang ditandai "simpan").

Sekarang "ganti asli" di editor dan upload dengan on_conflict replace memindahkan file lama ke Sampah. Ganti
dengan versi:
- Tabel node_versions (migrasi baru): node_id, blob_id, size, nomor versi (nodes.version sudah ada), dibuat
  oleh, waktu, pinned, catatan. Blob dipakai bersama lewat refcount, tanpa menyalin di R2.
- Setiap kali isi file diganti (upload replace, "ganti asli" di editor, kompres "ganti asli"), isi lama
  menjadi versi, bukan masuk Sampah.
- Panel Detail: daftar versi, unduh, pulihkan (isi sekarang ikut jadi versi), hapus versi, tandai simpan.
  Izin dari services/access.ts: lihat = view, pulihkan = edit, hapus versi = remove.
- Cron membuang versi yang lewat batas. Kuota dan refcount tetap benar. Ekspor data dan hapus akun
  (services/account.ts) mencakup versi. Link share selalu memberi versi terbaru.

Test: matriks izin (pribadi/keluarga), kuota sebelum dan sesudah hapus versi, pulihkan, cron dengan jam palsu,
IDOR untuk endpoint versi.
```

### D2 — Share ke akun tertentu

```text
Kerjakan D2 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): berbagi file/folder ke akun Zeiko tertentu,
plus halaman "Dibagikan dengan saya".

Sekarang hanya ada link (tabel shares) dan Drive Keluarga. Buat izin per orang:
- Tabel izin (migrasi baru): node, penerima (user_id, atau email kalau orangnya belum pernah masuk Drive —
  diklaim saat login pertama dengan email Akun Zeiko yang sama), peran lihat atau ubah, pemberi, waktu,
  kedaluwarsa opsional. Izin di folder berlaku untuk seluruh isinya; cari leluhur dengan CTE rekursif dan ukur
  performanya untuk folder yang dalam.
- nodeAccess di services/access.ts memperhitungkan izin ini. Peran ubah = edit + add; hapus tetap hanya
  pemilik/pembuat. File yang diunggah penerima ke folder orang lain memakai kuota pool pemilik folder.
- Yang boleh membagikan: pemilik item (pribadi) atau yang punya izin share di Drive Keluarga. Aturan privasi
  keluarga tetap berlaku: kepala keluarga tidak melihat file pribadi anggota kecuali dibagikan langsung.
- Dialog Share mendapat tab "Orang" (tambah email, ubah peran, cabut). Halaman "Dibagikan dengan saya" ada di
  sidebar dan HP. Pencarian dan Terbaru (klausa VISIBLE di services/browse.ts) ikut menampilkan item yang
  dibagikan.
- Notifikasi email + lonceng untuk penerima (services/notify.ts, dua bahasa). Rate limit undangan.
- Kalau pool pemilik readonly/suspended, penerima ikut tidak bisa menulis/membuka, sama seperti pemiliknya.

Test: matriks izin lengkap, warisan izin folder, cabut, email yang belum terdaftar, suite IDOR untuk semua
endpoint baru, dan pencarian tidak membocorkan item yang tidak dibagikan.
```

### D3 — Link minta file

```text
Kerjakan D3 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): link minta file, yaitu link yang hanya bisa
dipakai untuk upload ke satu folder.

- Pemilik folder membuat link permintaan: judul, pesan, tenggat opsional, batas jumlah file dan ukuran per
  file, wajib isi nama atau tidak, password opsional. Dikelola dari menu folder dan halaman Dibagikan.
- Halaman publik (format link seperti share, lihat src/worker/routes/share-public.ts, dua bahasa): pengunggah
  tanpa akun memilih file, mengisi nama, lalu upload. Tanpa iklan (larangan iklan di jalur upload). Turnstile,
  rate limit per IP, dan batas per link.
- Upload memakai protokol multipart yang sama (services/uploads.ts) dengan token permintaan, bukan sesi. Kuota
  dipotong dari pool pemilik secara atomik. File masuk ke subfolder per pengunggah (nama dibersihkan) dan lewat
  scan biasa. Pengunggah tidak bisa melihat file lain di folder itu.
- Pemilik mendapat notifikasi ringkas (email + lonceng, digabung per jam, bukan per file). IP pengunggah
  disimpan sebagai hash untuk laporan penyalahgunaan.
- Link mati otomatis kalau tenggat lewat, kuota habis, pool readonly/suspended, atau dicabut.

Test: alur pengunggah lengkap, batas jumlah dan ukuran, kuota habis di tengah upload, tenggat lewat, token
tidak bisa dipakai untuk folder lain, file berbahaya tetap ditolak scan, IDOR.
```

### D4 — Panel Aktivitas

```text
Kerjakan D4 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): panel Aktivitas (SPEC §8.1).

SPEC meminta Aktivitas "dari audit_logs", tapi audit_logs sekarang hanya mencatat tindakan admin
(services/admin.ts); tindakan pada file tidak tercatat sama sekali. Buat log aktivitas file:
- Tabel node_events (migrasi baru): node, pool, pelaku, aksi (upload, ganti isi, ganti nama, pindah, salin, ke
  Sampah, pulihkan, buat/cabut share, ubah dekorasi kalau D5 sudah ada), meta kecil (nama lama/baru, folder
  asal/tujuan), waktu. Ditulis di services (nodes.ts, uploads.ts, shares.ts) dalam batch yang sama dengan
  perubahannya.
- Tab Aktivitas di panel Detail untuk file dan folder (folder: dirinya dan isi langsungnya), plus daftar
  "Aktivitas terbaru". Di Drive Keluarga semua anggota melihat aktivitas ruang keluarga; ruang pribadi hanya
  untuk pemiliknya.
- Retensi di config (mis. node_events_keep_days = 90), dibersihkan cron. Ikut ekspor data dan hapus akun.

Test: setiap aksi menulis event, izin baca event sama dengan izin node, retensi, IDOR.
```

### D5 — Dekorasi folder

```text
Kerjakan D5 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): dekorasi folder dengan warna, ikon, atau
gambar (permintaan pemilik).

- Warna: palet tetap sekitar 12 warna, masing-masing dengan varian terang dan gelap yang kontrasnya cukup.
  Bukan hex bebas.
- Ikon: daftar ikon pilihan dari lucide-react (sudah dependency) atau satu emoji.
- Gambar: pilih gambar dari Drive (harus ready dan bisa dilihat pemilih) atau upload gambar baru lewat antrean
  upload biasa ke folder itu. Yang dipakai adalah thumbnail-nya (GET /api/files/:id/thumbnail); kalau belum
  ada, buat di browser seperti src/web/upload/thumbs.ts.
- Simpan di nodes (migrasi baru: warna, ikon, node gambar sampul). Mengubah dekorasi butuh izin edit
  (services/access.ts). Bisa diterapkan ke beberapa folder sekaligus, dan bisa dihapus.
- Tampil di grid/list explorer, breadcrumb, dialog Pindahkan, hasil pencarian, dan sebagai banner tipis saat
  folder dibuka (HP dan desktop).
- Gambar sampul hanya tampil kalau penonton boleh melihat file gambarnya. Kalau tidak boleh, atau gambarnya di
  Sampah/terhapus, tampilan jatuh ke ikon dan warna. Halaman share publik hanya memakai warna dan ikon, tidak
  pernah gambar sampul.

Test: izin ubah (pribadi/keluarga); sampul dari file yang tidak boleh dilihat tidak bocor (thumbnail tetap
404); fallback saat gambar dihapus; IDOR.
```

### D6 — Pencarian lanjutan + cari isi file

```text
Kerjakan D6 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): pencarian lanjutan dan pencarian isi file
(permintaan pemilik). Dua commit: (1) sintaks, filter, dan sorot kata; (2) indeks isi.

Sekarang (src/worker/services/browse.ts) pencarian hanya mencocokkan awalan kata di nama (FTS5 nodes_fts),
dengan filter jenis, modifiedAfter, dan ruang.

1. Sintaks dan filter. Parser bersama di src/shared/ (dipakai web dan Worker, dites unit), dengan kata kunci
   Indonesia dan Inggris:
   - "frasa persis", -kecualikan, ATAU/OR;
   - jenis:/type: (gambar, video, audio, pdf, dokumen, arsip, folder), ext:pdf;
   - setelah:/after: dan sebelum:/before: (tanggal atau bulan), untuk tanggal diubah, dibuat, atau diambil
     (yang terakhir setelah D8);
   - ukuran:/size: >10mb <1gb; di:/in:"Nama folder" (termasuk subfolder); ruang:pribadi|keluarga;
     berbintang; dibagikan;
   - mode cocok: awalan (seperti sekarang) atau kata utuh.
   UI: tetap satu kotak cari, ditambah panel filter (sheet di HP) yang menulis sintaks yang sama, supaya orang
   yang tidak hafal sintaks tetap bisa memakainya. Kata yang cocok disorot di nama (dan di potongan isi,
   bagian 2). Urutan: relevansi (bm25) atau tanggal. Pagination cursor.
2. Indeks isi. Tabel teks per file + FTS5 (migrasi baru, tokenizer sama dengan nodes_fts). Teks diambil di
   browser setelah upload atau saat file pertama kali dibuka: teks/kode/Markdown, PDF yang punya lapisan teks
   (pdf.js, src/web/editors/pdf/pdfjs.ts), .docx (mammoth), .xlsx/.csv (isi sel). Isi file tidak dikirim ke
   layanan luar. Batas karakter per file dan per pool ada di config; cek batas ukuran D1 di docs Cloudflare
   terbaru dan tulis hitungannya di ADR. Ada tombol "Indeks ulang" untuk file lama. Hasil pencarian
   menampilkan potongan isi dengan kata yang disorot.
   Sebelum bagian 2, tanya pemilik: apakah Kebijakan Privasi (src/web/legal/, teks pemilik, jangan diubah
   sendiri) perlu menyebut bahwa teks dari isi file disimpan untuk pencarian, dan apakah ada sakelar "Cari isi
   file" di Pengaturan (usul: ada, default nyala).
   Teks ikut terhapus saat file dihapus permanen atau isinya diganti, ikut ekspor data dan hapus akun, dan
   hanya dicari di node yang boleh dilihat (klausa VISIBLE, privasi keluarga SPEC §9.4).

Test: parser (banyak contoh ID/EN; input aneh tidak bisa menyuntik sintaks FTS5), filter tanggal/ukuran/folder,
sorot kata, isi file ditemukan, privasi keluarga, IDOR.
```

### D7 — OCR PDF dan foto dokumen

```text
Kerjakan D7 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): OCR untuk PDF hasil scan dan foto dokumen
(permintaan pemilik). Sebaiknya dikerjakan setelah D6, supaya teks hasil OCR bisa dicari.

- Semuanya di browser (aturan ADR-050: isi file tidak dikirim ke mana pun). Pakai tesseract.js dengan bahasa
  ind dan eng. Data bahasa dan core wasm dibundel dan dilayani dari origin sendiri (mis. /tesseract-<versi>/,
  disalin plugin di vite.config.ts seperti pdfjsAssets), bukan dari CDN. CSP app
  (src/worker/middleware/base.ts) belum mengizinkan WebAssembly: tambahkan 'wasm-unsafe-eval' seminimal
  mungkin dan catat alasannya di ADR.
- PDF: render tiap halaman dengan pdf.js (src/web/editors/pdf/pdfjs.ts) di resolusi cukup (sekitar 300 dpi),
  lewati halaman yang sudah punya teks, OCR satu halaman demi satu di worker (hemat memori HP), lalu tulis
  lapisan teks tak terlihat di atas halaman asli dengan pdf-lib (TextRenderingMode Invisible, posisi dari
  bbox kata). Font standar pdf-lib hanya bisa menulis huruf WinAnsi; embed font Unicode (pdf-lib + fontkit)
  atau tulis keputusanmu di ADR.
- Foto atau gambar dokumen: hasilnya teks (.txt) atau PDF yang bisa dicari.
- Bisa dibuka dari PDF editor (tab Alat), menu ⋮ "Jadikan bisa dicari (OCR)", pratinjau PDF/gambar, dan kartu
  di /alat. Pilih bahasa, progres per halaman, bisa dibatalkan. Simpan sebagai file baru atau ganti asli
  (setelah D1, isi lama menjadi versi). Teks hasil OCR masuk indeks isi D6.
- Batas halaman di config (mis. ocr_max_pages), ukuran memakai editor_pdf_max_bytes yang sudah ada. Teks UI
  tidak menjanjikan berlebihan: hasil untuk tulisan tangan dan foto miring kurang bagus.

Test: unit konversi bbox → koordinat PDF (halaman diputar, ukuran halaman berbeda); fixture PDF scan kecil di
tests/fixtures yang teksnya bisa diambil pdf.js setelah OCR. Uji di Chrome dev dengan build production (CSP).
```

### D8 — Galeri

```text
Kerjakan D8 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): Galeri foto dan video (permintaan pemilik).
Gambar bisa dicari dari Galeri maupun dari explorer.

- Halaman /galeri (di sidebar; di HP masuk navigasi bawah atau tombol yang mudah dijangkau, sesuaikan dengan
  AppShell): semua gambar dan video yang boleh dilihat (Drive Saya + Drive Keluarga, bisa difilter),
  dikelompokkan per bulan/hari menurut tanggal diambil. Grid tervirtualisasi (@tanstack/react-virtual),
  pagination cursor (tanggal, id), pilih banyak (unduh, share, pindah, Sampah, bintang, memakai aksi di
  useNodeActions), dan buka di Preview dengan geser kiri/kanan mengikuti urutan galeri.
- Tanggal diambil, lebar, tinggi, durasi: kolom baru (migrasi baru). Diambil di Worker setelah scan
  (src/worker/services/scan.ts / queue): baca bagian awal objek dengan Range, parser EXIF kecil sendiri di
  src/worker/lib (JPEG, HEIC, WebP, PNG eXIf), video dari mvhd (src/worker/lib/mp4.ts). Dengan begitu semua
  jalur upload (web, bot Telegram, share target, editor, ZIP) tercakup. Jangan simpan GPS. File lama diisi
  lewat queue secara bertahap.
- Kalau tidak ada tanggal diambil: pakai client_modified_at, lalu created_at.
- Thumbnail yang belum ada (mis. upload dari Telegram): dibuat di browser saat tampil kalau penonton boleh
  edit (route thumbnail butuh edit); selain itu placeholder. Thumbnail tetap dari browser, bukan Cloudflare
  Images (lihat src/web/upload/thumbs.ts).
- Pencarian: kotak cari di Galeri memakai sintaks D6 kalau sudah ada (jenis gambar/video otomatis;
  setelah:/sebelum: memakai tanggal diambil; nama folder; nama file). Kalau D6 belum ada, buat filter
  sederhana yang nanti diganti D6. Di explorer: jenis:gambar, dan tombol "Tampilkan sebagai galeri" untuk
  folder dan hasil cari.

Test: parser EXIF dengan fixture (termasuk tanpa EXIF dan dengan orientasi), urutan dan pengelompokan, cursor,
privasi keluarga, IDOR. Uji di Chrome dev dengan sekitar 2.000 foto demo: scroll tetap mulus di HP 360 px.
```

### D9 — WebDAV

```text
Kerjakan D9 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): akses Drive lewat WebDAV, supaya Drive bisa
dipasang di FolderSync/PhotoSync (backup galeri HP otomatis), rclone, Windows, macOS, dan Files di iOS tanpa
aplikasi sendiri. Butuh A1 (token akses).

- Host terpisah seperti S3_ORIGIN (dev mis. http://dav.localhost:8790, production dav.zeiko.biz.id), supaya
  cookie, CSRF, dan cek Origin app tidak tercampur. DNS-nya didaftarkan di services/readiness.ts dan fitur
  disembunyikan sampai siap.
- Auth: HTTP Basic dengan email + token akses ber-scope webdav (A1). Cookie tidak pernah diterima di host ini.
  Rate limit per token.
- Metode: OPTIONS, PROPFIND (Depth 0 dan 1; infinity ditolak), GET/HEAD dengan Range, PUT, DELETE (ke Sampah),
  MKCOL, MOVE, COPY, PROPPATCH (waktu ubah dari klien → client_modified_at), LOCK/UNLOCK sederhana untuk
  Windows dan macOS, dan properti kuota (quota-used-bytes, quota-available-bytes).
- PUT memakai reservasi kuota, pembersihan nama file, dan scan yang sama dengan upload biasa. Body request di
  Cloudflare maksimal 100 MB: tolak yang lebih besar dengan pesan jelas, atau dukung chunking Nextcloud (dipakai
  rclone dengan vendor nextcloud). Tulis pilihanmu di ADR.
- Akar "/" berisi "Drive Saya" dan "Drive Keluarga" (kalau anggota). Izin selalu lewat services/access.ts.
- Pengaturan: cara pasang (alamat, email, buat token) untuk FolderSync, rclone, Windows, macOS, dan iOS, dua
  bahasa.

Test: integrasi semua metode (XML multistatus valid), Range, rename/move yang bentrok nama, kuota habis, token
dicabut, IDOR. Kalau rclone bisa dipasang di mesin ini, jalankan rclone lsf/copy/sync ke dev server. Tulis
daftar uji manual untuk pemilik (FolderSync di Android, Windows Explorer).
```

### D10 — Album

```text
Kerjakan D10 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): album di Galeri (setelah D8).

Album adalah daftar referensi ke file (bukan salinan, tidak menambah kuota). Bisa dibuat, diganti nama, diberi
sampul, ditambah dari Galeri/explorer, diurutkan, dan dikurangi isinya. Album pribadi atau keluarga mengikuti
izin file di dalamnya: anggota hanya melihat foto yang boleh dilihatnya. Album bisa dibagikan lewat link share
bundle yang ada (ADR-054, tampilkan daftar file dulu). Tabel baru lewat migrasi; ikut ekspor data dan hapus
akun.

Test: izin, file yang dihapus hilang dari album, IDOR.
```

### D11 — Cari file kembar

```text
Kerjakan D11 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): cari file kembar untuk menghemat kuota.

blobs.sha256 sudah disimpan dan diindeks (blobs_sha256_idx). Tampilkan kelompok file yang isinya sama, hanya di
dalam pool user sendiri. Sesuai larangan dedup lintas pool/user, jangan pernah memberi tanda bahwa user lain
punya file yang sama. Beberapa node yang memakai satu blob (hasil "Buat salinan") tidak dihitung sebagai
pemborosan. Tunjukkan berapa byte yang bisa dihemat; user memilih yang disimpan, sisanya ke Sampah. Halaman di
bagian penyimpanan/Pengaturan.

Test: kelompok benar, kelompok lintas pool tidak pernah tampil, IDOR.
```

### D12 — Tanggal hapus otomatis

```text
Kerjakan D12 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): tanggal hapus otomatis untuk file/folder.

Yang punya izin remove bisa memasang tanggal. Saat tanggalnya tiba, cron memindahkan item ke Sampah (bukan
langsung hapus permanen), dengan notifikasi H-1. Tampil sebagai ikon jam di explorer dan di panel Detail.
Kolom baru di nodes (migrasi).

Test: jam palsu, izin, item yang sudah dipindah atau diganti nama tetap kena.
```

### D13 — Subtitle di pratinjau video

```text
Kerjakan D13 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): subtitle di pratinjau video.

Kalau di folder yang sama ada .srt/.vtt dengan nama dasar yang sama (atau dipilih manual), pasang sebagai
<track> di Preview. .srt dikonversi ke WebVTT di browser. User bisa memilih/mematikan subtitle dan mengatur
ukuran teks. Cek CSP untuk track dari USERCONTENT_ORIGIN.

Test: unit konversi SRT → VTT (format waktu, encoding, BOM).
```

### D14 — Email dua bahasa

```text
Kerjakan D14 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): email mengikuti bahasa user (sisa di
PROGRESS.md).

src/worker/services/email-templates.ts masih Bahasa Indonesia saja. Pindahkan teksnya ke strings.id.ts dan
strings.en.ts, lalu pilih bahasa menurut users.locale. Untuk penerima tanpa akun (mis. email share), pakai
bahasa pengirim.

Test: setiap template dirender dalam dua bahasa tanpa kunci kosong; cek hasilnya di mailbox dev /__dev/mail.
```

### D15 — Logo di tengah QR

```text
Kerjakan D15 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): logo Zeiko di tengah QR share (sisa di
PROGRESS.md, ADR-054).

Pakai error correction H dan logo maksimal sekitar 20% luas QR, untuk PNG (src/worker/lib/qr-png.ts) dan SVG,
dan QR harus tetap bisa dipindai.

Test: decode QR hasilnya (tambah devDependency decoder kalau perlu) untuk beberapa panjang link.
```

### D16 — Brankas end-to-end (analisis saja)

```text
Kerjakan D16 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): analisis Brankas terenkripsi end-to-end.
JANGAN membangun apa pun dulu.

Tulis usulan ADR (status: diusulkan) yang menjawab: file di brankas tidak bisa dipindai ClamAV/VirusTotal/CSAM
dan tidak bisa diproses server (kompres, pratinjau, thumbnail); bagaimana kewajiban takedown (Permenkominfo
5/2020, ToS §3) dan laporan penyalahgunaan tetap dipenuhi; pemulihan kalau user lupa kunci; dampaknya ke share,
keluarga, dan ekspor data. Beri 2–3 pilihan desain (mis. passkey PRF, atau kata sandi + Argon2 di browser)
beserta untung-ruginya, lalu tanyakan ke pemilik.
```

---

## API & SDK

### A1 — Token akses

```text
Kerjakan A1 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): token akses untuk API, WebDAV, SDK, dan
aplikasi (permintaan pemilik; fondasi untuk A2–A6 dan D9).

Sekarang semua API memakai cookie sesi __Host- + cek Origin + CSRF (src/worker/middleware/auth.ts). Itu tidak
bisa dipakai APK, skrip, atau WebDAV.
- Tabel api_tokens (migrasi baru): pemilik, nama, awalan yang terlihat, hash SHA-256 dari rahasia (rahasia
  hanya ditampilkan sekali), scope, dibuat, terakhir dipakai, kedaluwarsa, dicabut. Rahasia berawalan jelas
  (mis. zkd_…) supaya mudah dikenali kalau bocor.
- Scope awal: drive.read, drive.write, share, webdav, s3.manage. Token tidak pernah bisa membuka ops (kerja
  operator hanya dari relay, ADR-057).
- Middleware Bearer hanya untuk /api/v1/* (A2) dan host WebDAV (D9). Route /api/* yang sekarang tetap
  cookie saja, supaya CSRF tidak tercampur. Rate limit per token. Akun dibekukan/dihapus → token ditolak;
  hapus akun mencabut semua token.
- Catat di ADR hubungannya dengan ADR-039 (Drive mengikuti sesi pintu): keluar dari Akun Zeiko tidak mencabut
  token. Tulis apakah itu yang diinginkan, atau tanya pemilik.
- Pengaturan → "Token & aplikasi": buat (nama, scope, kedaluwarsa), daftar, terakhir dipakai, cabut. Dua bahasa.

Test: hash dan perbandingan waktu-konstan, scope diterima/ditolak, token di route cookie ditolak, kedaluwarsa,
cabut, akun dibekukan, IDOR.
```

### A2 — API publik v1 + OpenAPI

```text
Kerjakan A2 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): API publik Drive dan Zeiko S3 versi 1
dengan OpenAPI (permintaan pemilik). Butuh A1.

- Prefix /api/v1, terpisah dari /api internal (yang boleh berubah kapan saja). Aturan versi di ADR: perubahan
  yang merusak klien → /api/v2; field baru boleh ditambah.
- Isi awal, memakai services yang sama (route tetap tipis):
  - akun: profil, kuota, paket;
  - Drive: list folder (cursor), detail node, buat folder, ganti nama, pindah, salin, Sampah/pulihkan, cari
    (D6 kalau sudah ada), URL unduh bertanda tangan, upload multipart (init/part/status/complete/abort dari
    services/uploads.ts), link share (buat/daftar/cabut);
  - Zeiko S3 (scope s3.manage): akun dan pemakaian, key (buat dengan izin terbatas setelah S1, cabut), bucket
    (buat, hapus, publik, CORS, dan lifecycle setelah S3).
- Error JSON konsisten (kode dari src/worker/lib/errors.ts), rate limit per token dengan header sisa kuota,
  dan Idempotency-Key untuk POST yang membuat sesuatu.
- OpenAPI 3.1 dibuat dari skema zod (zod 4 punya z.toJSONSchema), dilayani di /api/v1/openapi.json, ditambah
  halaman dokumentasi ringan di app (tanpa skrip dari CDN, karena CSP). Ada test yang gagal kalau sebuah route
  v1 tidak punya skema.

Test: kontrak (respons cocok dengan skema), scope per endpoint, pagination, idempotency, IDOR untuk semua
endpoint v1. Production masih Workers Free: tulis di ADR batas request per token yang masuk akal.
```

### A3 — Login aplikasi (OAuth 2.0 + PKCE)

```text
Kerjakan A3 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): login aplikasi (APK, desktop, CLI) lewat
Akun Zeiko dengan OAuth 2.0 + PKCE (permintaan pemilik). Butuh A1 dan A2.

Tujuannya: aplikasi tidak pernah meminta orang menyalin token secara manual.
- Drive menjadi authorization server, untuk aplikasi pihak pertama dulu. Tabel klien (aplikasi Zeiko sendiri:
  Android, desktop, CLI) dengan redirect URI yang terdaftar persis: App Links https://<APP_ORIGIN>/app/callback
  (butuh /.well-known/assetlinks.json dengan nama paket dan sidik jari sertifikat dari pemilik → daftarkan di
  readiness.ts), custom scheme (RFC 8252), dan loopback 127.0.0.1 untuk desktop/CLI.
- GET /oauth/authorize: halaman persetujuan di SPA ("<aplikasi> ingin: lihat file, upload, …") yang memakai
  sesi Drive biasa (login lewat pintu seperti sekarang; relay tidak perlu diubah). PKCE S256 dan state wajib.
- POST /api/v1/oauth/token: authorization_code dan refresh_token (rotasi; kalau refresh token lama dipakai
  ulang, cabut seluruh rantainya). Access token berumur pendek, refresh token lebih panjang (keduanya di
  config), disimpan sebagai hash memakai tabel/logika A1.
- POST /api/v1/oauth/revoke, dan daftar aplikasi tersambung di Pengaturan → "Token & aplikasi" dengan tombol
  putuskan.
- Device flow (RFC 8628) untuk CLI/TV: opsional; tulis di ADR kalau ditunda.
- Aplikasi pihak ketiga (developer lain) belum didukung karena butuh pendaftaran dan review; tulis sebagai
  langkah berikutnya.

Test: alur lengkap dengan PKCE, redirect URI salah, code dipakai dua kali, rotasi refresh dan deteksi pemakaian
ulang, scope yang disetujui membatasi API v1, cabut dari Pengaturan.
```

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

### A6 — Webhook Drive + S3

```text
Kerjakan A6 dari docs/ROADMAP.md (ikuti "Aturan umum" di file itu): webhook untuk Drive dan Zeiko S3. Butuh A1;
bagian Drive butuh D4 (node_events).

- User mendaftarkan URL https dan memilih event: Drive (file selesai diupload dan lolos scan, diganti,
  dihapus, share dibuat) dan S3 (ObjectCreated, ObjectRemoved per bucket, dengan filter prefix/suffix
  opsional; PutBucketNotificationConfiguration berformat S3, lalu hapus 'notification' dari UNSUPPORTED_SUB).
- Dikirim lewat Queue, ditandatangani HMAC-SHA256 dengan rahasia per endpoint + timestamp (anti replay), coba
  ulang dengan backoff, dimatikan otomatis kalau terus gagal, dan log pengiriman 7 hari terlihat di Pengaturan
  dan /s3. Payload hanya metadata (ID, nama, ukuran, waktu), tidak pernah isi file atau URL unduh berumur
  panjang.
- Cegah SSRF: tolak IP privat, loopback, link-local, dan host internal setelah resolve. Batas jumlah endpoint
  per akun di config.

Test: tanda tangan, retry, auto-disable, SSRF, event hanya untuk resource milik akun.
```
