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

## ADR-019 — 2FA staf di level akun (sementara)
- **Konteks:** Plugin `twoFactor` Better Auth hanya mencegat sign-in kredensial (email/username/phone),
  bukan email OTP atau passkey. Akun Zeiko tanpa password.
- **Keputusan:** Route admin mensyaratkan role staf **dan** akun punya TOTP aktif atau minimal satu
  passkey (`requireStaff`). TOTP dikelola tanpa password (`allowPasswordless`). Step-up per sesi
  (verifikasi TOTP/passkey ulang sebelum aksi sensitif) dibangun di Fase 11 bersama panel admin.

## ADR-020 — Akuntansi kuota per status node
- **Keputusan:** Byte sebuah file ada di `reserved_bytes` selama node `uploading`/`scanning`, pindah ke
  `used_bytes` saat scan `clean`/`skipped` (node `ready`), dan dilepas saat `rejected`. Semua perubahan
  pool dilakukan dengan UPDATE yang mensyaratkan status node di statement yang sama (dalam `db.batch`),
  sehingga scan yang selesai bersamaan dengan penghapusan tidak menghitung dua kali.
- File di Sampah selalu dihitung ke kuota (§16 #13); opsi config untuk tidak menghitung Sampah
  **tidak** disediakan karena butuh rekonsiliasi dua arah di setiap operasi.
- Batas D1 100 parameter per query → operasi massal bekerja per *trash root* dengan recursive CTE,
  bukan daftar ID panjang.

## ADR-021 — Nama file baru dipesan saat upload selesai
- **Konteks:** Upload besar bisa berjalan berjam-jam; mengunci nama sejak init membuat upload lain
  dengan nama sama gagal.
- **Keputusan:** Node `uploading` memakai `name_key` sementara (`\u0001up:{id}`) sehingga tidak ikut
  index keunikan. Saat `complete`, nama final dipasang: konflik → `replace` (file lama ke Sampah, kalau
  boleh) atau nama otomatis "nama (1).ext". Init tetap mengecek konflik agar UI bisa menampilkan dialog
  "Ganti / Simpan keduanya / Lewati".

## ADR-022 — Prioritas "GDrive dulu" (arahan pemilik, 2026-10-21)
**Konteks:** Pemilik: "user tinggal upload kek gdrive. Cuma perlu login dan browse file mereka, upload atau
download file. Urusan backend kita yang urusin."
**Keputusan:** Urutan kerja diubah: inti pengalaman Drive (login, jelajah, upload/download, cari, pratinjau,
bintang, terbaru, sampah, share link, unduh ZIP) dirapikan dan siap deploy lebih dulu. Fitur bisnis
lanjutan (iklan, kompres, keluarga, billing penuh) tetap dibangun sesuai spec tetapi di belakang feature
flag di `app_config.features` agar bisa dimatikan tanpa deploy. Deploy dilakukan setelah pemilik login
ke Cloudflare (`wrangler login`/API token); semua resource dibuat lewat skrip yang bisa diulang.

## ADR-023 — Tambahan kecil ala Google Drive di explorer
Di luar teks spec, ditambahkan karena lazim di Drive dan murah:
- Ctrl/⌘+C / Ctrl+X → Ctrl+V untuk salin/pindah antar folder; navigasi panah di list/grid; Backspace = Sampah.
- "Unduh sebagai ZIP" untuk multi-pilih/folder memakai link `/z/{id}.{exp}.{sig}` (HMAC, tanpa cookie,
  izin dicek ulang saat unduh). Isi tidak ditulis ulang ke R2; ZIP store mendukung Range.
- Pratinjau PDF di USERCONTENT_ORIGIN tanpa `CSP: sandbox` (viewer PDF Chrome menolak dokumen sandboxed).
  Aman karena origin itu tidak punya cookie atau kode aplikasi; SVG/HTML tetap disajikan sebagai teks.
- Alert admin (`notify` → `admin_alert`) dikirim ke Telegram jika `ADMIN_ALERT_TELEGRAM_CHAT_ID` diisi.

## ADR-024 — "Virtualisasi" daftar dengan `content-visibility`
**Konteks:** DoD §8 minta folder 10.000 item tetap lancar. Explorer memuat halaman 100 item (keyset
cursor) via infinite scroll; setelah digulir jauh DOM bisa berisi ribuan baris.
**Keputusan:** Baris list/grid memakai `content-visibility: auto` + `contain-intrinsic-size`, sehingga
browser melewati layout/paint baris di luar layar, tanpa library virtualisasi. Seleksi Shift, Ctrl+A,
dan navigasi panah tetap bekerja di semua item. Kalau pengukuran di HP kelas bawah kurang, ganti ke
`@tanstack/react-virtual` (perubahan terisolasi di `FileView.tsx`).

## ADR-025 — PWA: service worker minimal + Web Share Target
`/sw.js` hanya meng-cache shell (`/drive`) dan `/assets/*` (hash, immutable); `/api`, `/d`, `/z`, `/p`
tidak pernah di-cache. File yang dibagikan dari aplikasi lain ke Zeiko (Android "Bagikan ke…") disimpan
sementara di IndexedDB lalu di-upload ke Drive Saya. Tanpa SW, `POST /share-target` dialihkan ke `/drive`.

## ADR-026 — Detail billing yang tidak diatur spec
- **Hapus H+37 default `dry_run`** (`dunning_delete_mode`). Job hanya menulis audit + alert admin berisi
  jumlah file/byte; pemilik mengganti ke `live` dari admin setelah yakin. Mode live menghapus bertahap
  lewat queue `cleanup` (`purge_pool`), dan blob dengan legal hold tetap ada.
- **Biaya gateway ditanggung Zeiko** (`payment_fee_paid_by: zeiko`), dicatat di `payments.fee_idr` untuk
  dashboard biaya. Alasannya: spec menjadikan QRIS + minimal top-up sebagai cara menekan biaya, bukan
  membebankannya ke pengguna. Bisa diubah ke `user`.
- **"Bayar langsung" = top-up lalu beli otomatis dari Saldo** setelah webhook `paid`. Hanya ada satu jalur
  uang (ledger), dan kalau pembelian gagal uangnya tetap aman di Saldo.
- **Add-on dibeli di tengah periode dikenai pro-rata** sisa hari (sama dengan aturan upgrade), lalu ikut
  perpanjangan penuh.
- **Berhenti berlangganan** = tidak diperpanjang; di akhir periode akun masuk siklus tunggakan yang sama
  (sesuai §9.3 "tanpa paket → read-only … lalu siklus 12.5").
- **Downgrade di atas kuota**: tidak ada status khusus; reservasi kuota otomatis menolak upload sampai
  pemakaian di bawah batas (efeknya sama dengan "read-only untuk upload").
- **PDF invoice** = halaman invoice + `window.print()` (simpan sebagai PDF di browser). Render PDF di
  server (Browser Rendering) bisa ditambah nanti tanpa mengubah data.
- **Halaman bayar mock** `/dev/pay/{ref}` hanya ada bila `APP_ENV != production` dan adapter `mock`; di
  production, top-up dengan adapter mock ditolak (`PAYMENT_UNAVAILABLE`).

## ADR-027 — Setup & deploy Cloudflare lewat satu skrip, bisa tanpa Docker
**Konteks:** Pemilik akan login ke Cloudflare lalu meminta saya mengurus deploy. Mesin kerja (HP/PRoot)
tidak punya Docker, padahal wrangler butuh Docker untuk mem-build image Container `scanner`.
**Keputusan:** `scripts/cf-setup.mjs <env>` membuat D1/KV/R2/Queues secara idempoten, menulis ID ke
`deploy/<env>.json` (tanpa secret), meregenerasi `wrangler.jsonc`, menerapkan migrasi, deploy, lalu mengisi
secret yang belum ada dengan nilai acak (`wrangler secret bulk`, file sementara 0600, tidak pernah dicetak).
Kalau Docker tidak ada dan image scanner belum pernah di-push, env itu otomatis memakai scanner bawaan
(hash SHA-256/CRC32 + EICAR + blocklist + sniff MIME, tanpa ClamAV), supaya file tidak tertahan
"Sedang dipindai". ClamAV aktif setelah CI (punya Docker) mendeploy image, lalu
`cf-setup.mjs <env> --containers-ready`. `limits.cpu_ms` dinaikkan ke 300 000 agar hashing file
multi-GB di consumer `scan` muat.
**Prasyarat akun:** Workers Paid (Containers dan pengiriman email OTP ke alamat bebas butuh paket ini),
zona `zeiko.biz.id` di akun yang sama (custom domain app + `uc.`), Email Service dengan domain pengirim
terverifikasi.

## ADR-028 — Admin & moderasi: batas akses dan detail tindakan
- **Tidak ada akses isi file dari menu Pengguna.** Isi file hanya bisa dibuka dari laporan, lewat token
  pratinjau `a` (5 menit, khusus staf aktif) yang tiap pemakaiannya tercatat `report.content_view`.
- **Karantina** = `blobs.scan_status = 'quarantined'`: download, share, pratinjau, dan ZIP diblokir untuk
  semua orang termasuk pemilik, tapi kuota tetap terhitung. Staf masih bisa meninjau lewat token `a`.
- **Moderator**: laporan, pemindai, bekukan pengguna. **Admin**: plus saldo, bonus kuota, peran, config,
  katalog, audit. Keduanya wajib passkey/TOTP (ADR-019).
- **Bonus kuota** (`storage_pools.bonus_bytes`) ditambahkan di atas paket dan add-on, dan ikut dihitung
  ulang setiap ada perubahan paket.
- **CSRF hanya untuk request yang membawa sesi.** Form anonim (Lapor) cukup dilindungi cek `Origin`;
  request bersesi tetap wajib token double-submit.
- **Pengguna dibekukan** → semua sesi dihapus, link share-nya mati (`shareState` cek status pembuat).

## ADR-029 — Notifikasi: wajib vs bisa dimatikan
In-app selalu aktif. Email untuk `invoice`, `renewal_failed`, dan `dunning` tidak bisa dimatikan, karena
itu pemberitahuan tagihan/penghapusan data yang harus sampai. Jenis lain bisa dimatikan per kanal (email,
Telegram). Notifikasi kuota dikirim sekali per ambang (80/95/100 %) per batas kuota, jadi naik paket
membuka ambang baru.

## ADR-030 — Paket keluarga: detail implementasi
- **Pool bersama**: membuat keluarga atau bergabung memindahkan semua node, blob, dan `used_bytes` milik
  pengguna dari pool pribadi ke pool keluarga dalam satu `db.batch`. Ditolak selama masih ada
  upload/scan berjalan (supaya reservasi tidak tertinggal di pool lama).
- **Izin `add`**: semua anggota boleh menaruh item baru (upload, folder baru, pindah/salin ke dalam)
  di folder keluarga mana pun. `edit`/`remove` item tetap hanya untuk pembuat + pemilik keluarga
  (atau anggota lain bila `family_can_edit`).
- **Keluarga → Pribadi** hanya untuk subtree yang seluruhnya dibuat oleh pemindah, sehingga item orang lain
  tidak bisa "diambil". Share milik anggota lain atas item itu dicabut. **Pribadi → Keluarga** wajib
  `confirmSpaceChange`.
- **Keluar**: blob yang dipakai bersama file pribadi dan salinan di Drive Keluarga diduplikasi di R2,
  jadi tidak ada blob lintas pool (aturan §2). Pengguna tanpa paket mendapat langganan berstatus
  `readonly` (plan termurah, tanpa perpanjangan), lalu siklus §12.5 berjalan seperti biasa.
- **Batas per anggota** bersifat lunak: dicek dengan `SUM(size)` saat upload dimulai, hanya kalau
  `cap_bytes` diisi. Kolom counter `family_members.used/reserved_bytes` tidak dipakai.
- **Bubarkan keluarga** (tambahan): hanya bila tinggal pemilik. Drive Keluarga jadi folder biasa di
  Drive Saya, dan sisa masa paket dikonversi ke Saldo. Ini jalan keluar bagi pemilik yang ingin kembali ke
  paket pribadi.
- **Jeda pindah keluarga** dihitung dari audit `family.join`/`family.leave` terakhir.
- Paket `family` tetap **nonaktif** di seed sampai pemilik menetapkan harga (§16 #3), diaktifkan dari
  Admin → Katalog.

## ADR-031 — Kompres media: detail implementasi
- **Kredit dipotong saat job dibuat**, dikembalikan bila gagal, dilewati (hasil ≥ asli), atau kedaluwarsa.
  Urutan pakai: grant `plan` dulu, lalu `pack`/`refund` yang paling cepat kedaluwarsa. Tiap pemakaian
  dicatat `usage` dengan ref `job|grant`, sehingga refund mengembalikan ke grant asalnya (sekali per job).
  Kalau grant asalnya sudah kedaluwarsa, kreditnya kembali sebagai grant `refund` baru berlaku 7 hari.
- **Pemilihan mesin**: foto ≤ `images_binding_max_input_bytes` → Images binding; video MP4/MOV dengan
  durasi (dibaca dari box `mvhd`, tanpa decode) ≤ `media_binding_max_seconds` dan ukuran ≤
  `media_binding_max_input_bytes` → Media Transformations; sisanya → Container `media` (ffmpeg,
  `standard-2`). Video yang durasinya tidak terbaca (MKV/WebM) masuk container dan dihitung 1 kredit.
- **Tanpa container** (belum di-deploy/tanpa Docker) file yang butuh ffmpeg langsung ditolak
  `TOO_LARGE` tanpa memotong kredit.
- **Metadata**: hasil selalu tanpa GPS/EXIF. Images binding membuang semua metadata untuk WebP/AVIF
  (JPEG hanya menyisakan copyright), ffmpeg memakai `-map_metadata -1`. Opsi "pertahankan metadata"
  tidak disediakan.
- **Hasil** di Drive berupa blob baru di pool yang sama (tidak ada dedup lintas pool) dengan status scan
  `clean` / `derived:compress`, karena sumbernya sudah lolos scan dan diproses oleh transcoder kita sendiri.
  "Ganti asli" menukar blob node secara atomik (dijaga `blob_id` lama), `used_bytes` turun sebesar
  penghematan, dan blob lama dihapus lewat antrean cleanup bila tak dipakai lagi. Share link tetap jalan.
  Nama ikut ekstensi format baru.
- **Standalone** memakai multipart R2 (bagian 50 MiB) di `tmp/compress/{userId}/`, tidak memakai kuota,
  tidak di-scan (file hanya kembali ke pengunggahnya sendiri), dan dihapus cron per jam setelah 24 jam.
- **Notifikasi** `compress_done` dikirim sekali per batch setelah semua job selesai (penjaga KV `cn:`).

## ADR-032 — Iklan lokal: detail implementasi
- **Data wilayah**: seed awal 38 provinsi (kode Kepmendagri 2022, termasuk 6 provinsi Papua) dan 75 kota/kabupaten
  utama dengan alias nama Inggris dari Cloudflare. Sisa kabupaten bisa ditambah lewat migrasi/admin dari dataset
  publik (github.com/cahyadsn/wilayah). Kota yang tidak dikenal jatuh ke provinsi, lalu nasional. Pencocokan
  pakai normalisasi (buang "Kota"/"Kabupaten"/"Province"/"Special Region of", diakritik, tanda baca) dan
  mengutamakan "Kota …" bila nama kota dan kabupaten sama.
- **Penayangan**: urutan area pilihan user → `cf.city` → `cf.region` → nasional. Pengunjung luar negeri langsung
  nasional. Kandidat per (versi, tanggal, area, placement) di-cache di KV (TTL ≥ 60 dtk, minimum TTL KV).
  "Versi" naik saat ada pembayaran untuk hari ini atau takedown, jadi cache lama langsung diabaikan.
  Kalau tidak ada iklan berbayar, tampil iklan internal "Pasang iklan di Zeiko".
- **Tanpa ID user**: impresi lewat beacon `POST /ad/i` dengan token HMAC (booking + tanggal WIB), klik lewat
  `/ad/c/{bookingId}` → 302. Keduanya di luar `/api` (tanpa sesi/CSRF) dan hanya menaikkan counter booking +
  event Analytics Engine tanpa user. Counter ditulis langsung ke D1 (cukup untuk skala awal, bisa dipindah ke
  agregasi AE nanti).
- **Halaman share**: kartu statis dirender di server pada halaman minta password dan link mati. Di sana tidak
  ada JavaScript (CSP ketat), jadi impresi dihitung saat render dan tidak ada tombol "Sembunyikan" (link
  "Laporkan iklan" tetap ada). Bot pratinjau tidak melihat iklan. Unduhan langsung tidak pernah melewati
  halaman iklan. Halaman "Arsip siap" tidak ada karena arsip ZIP diunduh langsung.
- **`show_ads`**: di explorer mengikuti paket pengguna (paket keluarga mengikuti pool keluarga); di halaman
  share mengikuti paket pembuat share. Pengguna tanpa paket tetap melihat iklan (default §16 #6).
- **Anti-overbook**: semua tanggal satu pemesanan masuk satu `db.batch` (buat baris inventori bila belum ada →
  insert booking `held` → `booked_slots + 1`). CHECK `booked_slots <= total_slots` membatalkan seluruh
  transaksi bila satu tanggal penuh, dan respons `SOLD_OUT` menyebut tanggal yang penuh. Hold dilepas oleh cron
  per jam dan sebelum cek ketersediaan.
- **Pembayaran**: Saldo dipotong dalam satu batch bersama perubahan status booking. Ada penjaga yang sengaja
  melanggar CHECK saldo bila ada hold yang kedaluwarsa di tengah jalan, jadi uang tidak pernah terpotong untuk
  slot yang sudah lepas. QRIS/VA = top-up dengan `then: {kind:'ads'}` (pola ADR-026). Kalau pembayaran telat
  dan hold sudah habis, uangnya tetap masuk Saldo.
- **Moderasi**: filter otomatis (`src/shared/ad-policy.ts`: kata terlarang dengan pelipatan leetspeak, CTA wajib
  https, tanpa IP/punycode/port/link pendek, Shopee/Tokopedia harus domain resminya) langsung menolak. Yang lolos
  masuk antrean admin. Materi yang sedang dipakai booking aktif tidak bisa diubah. Takedown (`suspend`)
  menghentikan booking `paid`/`live`; sisa hari dikembalikan ke Saldo sesuai `ad_refund_on_suspend`.
- **Gambar**: dipotong persegi dan dikompres ke WebP di browser (turunkan kualitas/ukuran sampai ≤
  `ad_image_max_bytes`). Server memeriksa ulang header RIFF/WEBP (VP8/VP8L/VP8X), ukuran, dan rasio 1:1.
  Gambar publik hanya untuk materi `approved`, disajikan dengan `CSP: sandbox` + `nosniff`.
- **Diskon mahasiswa**: OTP 6 digit ke email `.ac.id` (hash di KV 10 menit, maks 5 percobaan).

## ADR-033 — Arsip async tanpa kredensial S3 di container
- Spesifikasi §7.2 menyarankan container `archiver` membaca/menulis R2 lewat S3 API dengan token R2. Kami pilih
  jalur yang **tidak butuh kredensial S3 sama sekali**: Worker (consumer Queue `archive`) menyusun stream TAR
  dari binding R2 (`lib/tar.ts`: ustar + PAX untuk nama panjang/UTF-8 dan ukuran ≥ 8 GiB), mengirimnya ke
  container, lalu container mengompres ke disk lokal (`zstd -T0`, atau tar→ZIP deflate dengan Go stdlib)
  dan mengembalikan hasilnya dengan `Content-Length` + `X-SHA256`. Worker menulis hasil ke
  `tmp/archives/{jobId}.tar.zst|.zip`: satu `put` sampai 4 GiB, di atas itu multipart dengan part seragam 64 MiB
  yang dibaca langsung dari stream (`lib/r2-put.ts`).
- Akibatnya ukuran input dibatasi disk container dan batas waktu consumer Queue: `archive_async_max_bytes`
  (default 8 GiB, instance `standard-2`). `archive_max_items` membatasi jumlah item; tetap maksimal 1 job
  berjalan per user (`archive_max_running_jobs_per_user`).
- Progres = porsi tar yang sudah dikirim ke container (ditulis tiap 5 %, maks 95 % sampai hasil tersimpan).
  Notifikasi `archive_ready` mengarah ke halaman `/unduhan`, yang membuat link `/z/` bertanda tangan baru tiap
  dibuka (tidak ada token di baris notifikasi). File hasil dilayani lewat `serveObject` (Range/resume).
- Arsip yang sudah jadi memakai izin user saat job berjalan. Untuk ZIP yang di-stream, izin tetap dicek ulang
  setiap kali diunduh. Cron per jam menghapus hasil yang lewat `archive_link_ttl_hours`. Lifecycle R2 untuk
  `tmp/` tetap disarankan sebagai cadangan (DEPLOY.md).
- Tanpa container (`ADAPTER_ARCHIVER=none`), TAR.ZST dan ZIP deflate di atas batas stream tidak tersedia.
  Katalog publik mengirim `capabilities.asyncArchives=false` sehingga dialog menonaktifkan opsi itu. ZIP cepat
  dan ZIP terkompres ≤ 2 GiB tetap jalan. Mock dev: TAR.ZST = tar tanpa kompresi (bisa dibaca tes), ZIP deflate
  dibuat di Worker.

## ADR-034 — Hardening (Fase 12)
- **E2E** memakai Playwright dengan Chromium sistem (`PW_CHROMIUM`, default `/usr/bin/chromium`), karena
  unduhan browser Playwright tidak jalan di HP pengembangan. Di CI browser dipasang lewat
  `playwright install`. Ada dua proyek, desktop dan Pixel 7, yang dijalankan terhadap `npm run dev`
  (adapter mock).
- **IDOR**: satu suite (`tests/integration/idor.test.ts`) memutar ulang semua endpoint ber-ID memakai ID milik
  akun lain, lalu membandingkan snapshot data korban sebelum dan sesudah. Endpoint ber-ID baru wajib
  ditambahkan ke sana.
- **Retensi**: `log_retention_days` menghapus `share_sends`, notifikasi yang sudah dibaca, `usage_counters`
  kedaluwarsa, sesi/verifikasi kedaluwarsa, dan baris job kompres/arsip yang sudah selesai. **`audit_logs`
  tidak dihapus otomatis**, karena dipakai sebagai bukti moderasi, legal hold, dan akuntabilitas staf. Batas
  retensinya diputuskan pemilik bersama review hukum (LAUNCH-CHECKLIST).
- **Turnstile** dipakai di login (header `x-captcha-response` untuk plugin captcha Better Auth), email share,
  pendaftaran pengiklan pertama kali, dan laporan anonim. Widget hanya muncul kalau server mengirim site key.
  CSP mengizinkan `https://challenges.cloudflare.com` untuk `script-src` dan `frame-src`.
- **Performa**: semua halaman kecuali landing dimuat on-demand (`lazyRouteComponent`), sehingga landing tidak
  ikut membawa klien auth, explorer, atau halaman admin. Lighthouse mobile di HP pengembangan: 72 → 81–88
  (Accessibility/Best Practices/SEO 100). Target ≥ 90 diukur ulang di CI (job `e2e`) dan di staging.
- **HSTS** `max-age=1 tahun` tanpa `includeSubDomains`/preload (domain induk dipakai produk lain).
- **Uji beban**: `tests/load/download.js` (k6) hanya untuk staging. Mencakup link share (tanpa halaman iklan)
  dan Range 4 koneksi.

## ADR-035 — Staging di Workers Free + email lewat relay HTTPS→SMTP
Pemilik memutuskan (2026-10-22) staging untuk persiapan dan uji coba jalan di **Workers Free** dulu.
Workers Paid ($5/bulan) ditunda. Konsekuensinya:
- **Container tidak tersedia.** Scanner memakai scanner bawaan (hash + EICAR + blocklist, ADR-027), opsi
  TAR.ZST disembunyikan (`ADAPTER_ARCHIVER=none`), dan kompres video panjang ditolak tanpa memotong kredit.
- **CPU dibatasi 10 ms per pemanggilan**, dan Free menolak `limits.cpu_ms`. Karena itu `limits` sekarang
  diatur per environment di `gen-wrangler`, dan dibuang saat `deploy/{env}.json` berisi `"plan": "free"`.
  Pekerjaan berat CPU (hash file besar, ZIP terkompres) bisa gagal di Free. Batas praktisnya diukur di
  staging dan dicatat di PROGRESS.
- **Email Sending tidak tersedia.** Adapter email baru `relay` mengirim lewat Worker `zeiko-mailer` milik
  pemilik (`https://mailer.zeiko.biz.id`, HTTPS → SMTP Private Email, satu penerima per request). URL-nya
  diisi lewat var `MAIL_RELAY_URL`, token lewat secret `MAIL_RELAY_TOKEN`, dan pemilik sendiri yang memasang
  token itu. Pengirimnya adalah alamat FROM relay, bukan `no-reply@`. Sebelum token dipasang, staging
  memakai `mock`: OTP disimpan di KV `dev:mail:*` dan tidak ada email yang terkirim ke alamat sungguhan.
- Skrip: `node scripts/cf-setup.mjs staging --plan free --email mock|relay`. Saat pindah ke Paid, jalankan
  `--plan paid --email cloudflare`, lalu aktifkan container lewat CI (`--containers-ready`).
- **Hasil pengukuran staging (2026-10-22):** walaupun batas resminya 10 ms, Free masih menjalankan invocation
  yang lebih lama. Scan 20 MB memakai 659 ms CPU, login OTP sekitar 130 ms, dan semuanya berhasil.
  Kelonggaran ini tidak dijamin, jadi untuk production tetap pakai Paid.
- **Cron:** Free membatasi 5 cron trigger per akun, dan 3 sudah dipakai Worker lain. `CRON.combined`
  (`5 * * * *`) menjalankan tugas per jam, ditambah tugas harian pada jam UTC-nya (17 = iklan harian,
  19 = malam). Paid tetap memakai 3 trigger terpisah.
- **Analytics Engine** harus diaktifkan sekali per akun dari dashboard (gratis).
- `cf-setup` hanya membaca JSON dari stdout dan berhenti kalau daftar secret tidak terbaca. Sebelumnya, warning
  wrangler di stderr membuat daftar terbaca kosong dan **semua secret dibuat ulang** (secret staging sempat
  berganti satu kali).

## ADR-036 — Login dan pembayaran lewat Zeiko Accounts (relay), harga tetap Rupiah
Pemilik memutuskan (2026-10-22) Cloud Storage memakai **Zeiko Accounts** yang sama dengan ZeikoAI dan
Zeiko Chat (relay `Chtting-relay-worker`, pintu `https://auth.zeiko.biz.id`). Pembayarannya memakai alur
proxychat (QRIS yang dikonfirmasi operator, dan crypto lewat NOWPayments). Harga storage tetap **Rupiah**.
Operator mengatur Cloud Storage dari layar baru di dashboard relay. Ini menyimpang dari SPEC §2 ("tanpa
password", Better Auth dengan Google/OTP/passkey) dan §16 #2 (gateway pembayaran).

- **Login = "Masuk dengan Akun Zeiko".** `GET /api/auth/zeiko/start` menyimpan `state` di cookie, lalu
  mengarahkan browser ke `{ZEIKO_SITE_URL}/account/connect?app=storage&state=…`. Website memakai sesi pintu
  (atau meminta login/daftar dulu), lalu meminta tiket sekali pakai (`POST /v1/ticket`, berlaku 2 menit).
  Pintu mengembalikan browser ke `/api/auth/zeiko/callback?ticket&state`. Worker menukar tiket
  server-ke-server (`POST /apps/v1/tickets/redeem`, bearer `ZEIKO_APP_TOKEN`), mencocokkan `state`, lalu
  membuat sesi Better Auth. Identitasnya disimpan di tabel `accounts` (`providerId = 'zeiko'`, `accountId` =
  id Zeiko), jadi id user lokal tetap ULID. Email dan nama disegarkan setiap kali login.
- **Yang dilepas:** OTP email, Google langsung, dan login dengan passkey (`disabledPaths`). Password, lupa
  password, konfirmasi email, Google, dan GitHub semuanya diurus Zeiko Accounts. Passkey dan TOTP tetap
  dipakai sebagai faktor kedua staf (SPEC §13.1).
- **Pembayaran = adapter `zeiko`.** `createCharge` → `POST /apps/v1/payments` (`amountIdr`, `method`
  `qris|crypto`, `orderRef` = id pembayaran lokal). QRIS mengembalikan halaman bayar website
  (`/account/pay?id=`). Nominalnya rupiah persis plus kode unik 1–999 (`Charge.amountIdr`), dan seluruh nominal
  itu masuk Saldo, jadi pembeli tidak kehilangan kodenya. Crypto mengembalikan invoice NOWPayments dengan
  dolar dari kurs QRIS yang diketik operator, dan hanya ditawarkan di atas `min_idr` metode `crypto`. Relay
  memberi kabar ke `/api/payments/webhook/zeiko` (HMAC-SHA256 dengan `ZEIKO_OPS_TOKEN` atas
  `timestamp.body`, maksimal 5 menit). `getStatus` dipakai cron untuk menyamakan kabar yang hilang.
  Semua pembelian tetap lewat Saldo dulu (ADR-026), sehingga paket keluarga, add-on, kompres, iklan, dan siklus
  tunggakan tidak berubah.
- **Saldo tetap Rupiah dan milik Cloud Storage**, tidak digabung dengan saldo dolar ZeikoAI/Zeiko Chat.
  Kalau digabung, nilainya akan ikut naik-turun dengan kurs yang diketik tangan. Penggabungan bisa diputuskan
  belakangan.
- **Layar Cloud Storage di dashboard relay** memanggil `/api/ops/*` di Worker (bearer `ZEIKO_OPS_TOKEN`).
  Layar ini mencakup ringkasan untung-rugi (`services/admin.ts::dashboard`), katalog paket, konfigurasi
  bisnis, pengguna (Saldo, kuota bonus, paket, suspend), dan pembayaran. Setiap perubahan butuh alasan dan
  dicatat di `audit_logs` atas nama operator relay. Tetap tidak ada akses melihat isi file user.
- **Relay offline** (HP mati): orang tidak bisa login baru atau bayar. Sesi yang ada, file, dan share tetap
  jalan karena sesi disimpan di D1.
- Dev dan test memakai mock: `/dev/zeiko-login` menerbitkan tiket mock untuk akun demo, dan pembayaran mock
  tetap memakai halaman `/dev/pay`.
- **Tambahan pemilik (2026-10-22, pesan lanjutan):** produk ini bernama **Zeiko Drive**. Harga dan
  deskripsinya pindah ke zeiko.biz.id (`proxychat`: halaman `/drive`, kartu paket dirender Worker situs dari
  `/api/public/catalog`, jadi perubahan harga di dashboard relay langsung terlihat). App-nya ada di
  **`zeiko.biz.id/dashboard`** (`APP_BASE_PATH`; build Vite di `dist/web/dashboard`) dan dibuka di storage.
  Sidebar punya "Produk Zeiko": AI Decision (`/dashboard/ai`, data dari pintu `/v1/account` dengan sesi
  browser sendiri), Zeiko Chat, dan Akun Zeiko. Worker situs meneruskan `/dashboard`, `/api/*`, `/d/*`, `/z/*`,
  `/ad/*`, dan link share ke Worker Drive lewat service binding `DRIVE`. Karena halaman ada di origin situs,
  pintu sudah mengizinkan CORS-nya, sehingga login tanpa klik (`signInSilently`) bekerja kalau browser sudah
  masuk di website.
- **Dua bahasa (EN/ID) di semua UI:** `strings.en.ts` mengikuti bentuk `strings.id.ts`. Bahasa disimpan di
  cookie `zk_lang` milik seluruh zeiko.biz.id (website ikut membacanya) dan di `users.locale` (migrasi 0004)
  untuk email. Halaman share yang dirender Worker memilih bahasa dari cookie atau `Accept-Language`.

## ADR-037 — Layar R2 di dashboard relay: meteran R2 sendiri, bukan hitungan Drive

**Konteks:** permintaan pemilik (2026-10-23): tab cloud storage di relay harus menghitung harga R2
(developers.cloudflare.com/r2/pricing) lengkap dengan pemakaian nyata, storage yang dialokasikan (orang × paket),
untung/rugi, dan operasi Class A/B. `dashboard()` sebelumnya hanya menghitung `used_bytes × $0.015`, tanpa
free tier, operasi, maupun pembulatan.

**Keputusan:**
- **Pemakaian nyata diambil dari GraphQL Analytics Cloudflare** (`r2StorageAdaptiveGroups`,
  `r2OperationsAdaptiveGroups`, `r2BandwidthUsageAdaptiveGroups`). Ini dataset yang sama dengan dasbor dan
  tagihan Cloudflare. D1 hanya tahu apa yang Drive catat. Thumbnail, arsip, manifest, dan multipart yang
  belum selesai ikut ditagih tetapi tidak ada di `blobs`, dan Worker tidak bisa menghitung operasinya sendiri
  tanpa menulis ke D1 di setiap akses R2. Adapter `adapters/r2-metrics.ts` memakai secret `CF_ANALYTICS_TOKEN`
  (token API dengan izin Account Analytics: Read) dan `CF_ACCOUNT_ID`, ditambah var `R2_BUCKET_NAME` per
  environment.
- **Per hari, hanya field yang didokumentasikan:** storage dan operasi diminta satu kali per hari UTC (alias
  `s0…`/`o0…`) dalam satu request, lalu dikelompokkan per bucket. Nilai `max` dalam satu hari adalah puncak
  harian yang dipakai R2 untuk menghitung GB-month, jadi hasilnya tidak bergantung pada seberapa sering
  Cloudflare mengambil sampel. Hasilnya di-cache 10 menit di `CONFIG_KV`.
- **Rumus tagihan mengikuti halaman harga.** GB-month adalah rata-rata puncak harian selama periode tagihan.
  Free tier (10 GB-month, 1 juta Class A, 10 juta Class B) berlaku per akun dan hanya untuk Standard.
  Pemakaian dibulatkan ke atas ke unit berikutnya. Egress gratis. Operasi diklasifikasikan menurut daftar
  Class A/B/gratis di halaman yang sama. Operasi yang tidak ada di daftar dihitung terpisah dan tidak ditagih.
- **Bagian Drive dihitung sebagai biaya marjinal:** tagihan akun dengan bucket Drive dikurangi tagihan tanpa
  bucket Drive. Alasannya, free tier dipakai bersama bucket lain di akun yang sama (`zeiko-models`, staging).
  Proyeksi akhir periode: storage memakai puncak terakhir untuk hari yang tersisa, operasi memakai laju
  sejauh ini (minimal dihitung satu hari).
- **Untung/rugi bulanan:** MRR (harga katalog × langganan `active`, plus add-on) dikurangi biaya R2, fee QRIS
  atas MRR, dan `fixed_costs_usd_per_month`. Yang juga dihitung: skenario `usage_scenarios_pct`, kondisi
  "semua kuota penuh", dan persentase isi kuota tempat titik impas.
- **Harga ada di `app_config`:** kunci baru `r2_billing` (free tier, tarif Infrequent Access, retrieval,
  `gb_bytes`, `cycle_start_day`). Kunci lama `r2_storage_usd_per_gb_month` dan
  `component_tariffs_usd.r2_class_*` tetap berlaku untuk Standard. Halaman harga tidak menyebut apakah GB
  berarti 10^9 atau 2^30, jadi `gb_bytes` mengikuti GB Drive (2^30) sampai ada tagihan yang menunjukkan
  sebaliknya.
- **Kalau token belum diisi atau Cloudflare menolak**, layar memakai hitungan Drive sendiri
  (`blobs`) dan menyebutkannya. Operasi ditampilkan sebagai *tidak diketahui*, bukan nol.

**Endpoint:** `GET /api/ops/storage` (`services/storage-report.ts`). Tes: `tests/integration/storage-report.test.ts`
(dua contoh di halaman harga, pembulatan, free tier milik akun, siklus tagihan, query per hari, laporan lengkap
dengan Cloudflare tiruan, fallback tanpa token, dan error dari Cloudflare).


## ADR-038 — Zeiko Drive pindah ke drive.zeiko.biz.id, dan dibayar dengan QRIS saja

**Konteks:** permintaan pemilik (2026-10-23): "Pindahkan produk Zeiko Drive ke drive.zeiko.biz.id, terus yang
ini ga bisa pakai crypto, QRIS doang bisanya." Sebelumnya app ada di `zeiko.biz.id/dashboard` dan diteruskan
oleh Worker situs lewat service binding `DRIVE` (ADR-036), dan Saldo bisa diisi dengan QRIS atau crypto.

**Keputusan:**
- **App ada di root alamatnya sendiri, `https://drive.zeiko.biz.id`** (`APP_ORIGIN` production, route custom
  domain di `scripts/gen-wrangler.mjs`). `APP_BASE_PATH` sekarang kosong secara default: SPA, API, link share,
  dan unduhan ada di satu origin, seperti sebelum ADR-036. Build Vite memakai `base: '/'` (`dist/web`), dan
  PWA (`manifest.webmanifest`, `sw.js`) memakai scope `/`. Service worker tidak menyentuh halaman milik Worker
  sendiri (`/api`, `/d`, `/z`, `/p`, `/ad`, `/berhenti`, link share) agar halaman share tidak tersimpan sebagai
  cangkang app. `uc.zeiko.biz.id` tetap jadi origin pratinjau (subdomain satu tingkat, masih tercakup sertifikat
  universal Cloudflare; `uc.drive.zeiko.biz.id` tidak tercakup).
- **`zeiko.biz.id/dashboard/…` tetap menjadi jalan pulang ke Drive.** Halaman akun di situs dan login
  Google/GitHub di pintu hanya mau mengirim orang ke halaman situs sendiri (`safeNext` / `safe_next`). Jadi
  halaman masuk Drive memberi situs `next=/dashboard/masuk?next=…` (`SITE_WAY_BACK`), dan Worker situs
  meneruskan `/dashboard/…` ke `https://drive.zeiko.biz.id/…`. Worker Drive juga meneruskan `/dashboard/…` di
  alamatnya sendiri ke `/…` (301), untuk link lama dan untuk pintu tiruan di dev. Dengan begitu tidak ada
  aturan `next` yang perlu dilonggarkan untuk origin lain.
- **Login tanpa klik tetap jalan:** cookie pintu (`zk_auth`, `SameSite=Lax`) tetap terkirim dari
  drive.zeiko.biz.id karena masih satu situs (zeiko.biz.id). Pintu (relay) kini juga mengizinkan CORS dari
  origin `drive.url`, jadi tidak ada lagi syarat "halaman ada di origin situs".
- **Pembayaran: QRIS saja.** `payment_methods` default hanya berisi QRIS. `services/billing.ts::DRIVE_METHODS`
  menolak kode lain di `createTopup` dan menyembunyikannya dari ringkasan, walaupun konfigurasi lama di D1
  masih menyalakan crypto. Konfigurasi operator tetap bisa mematikan QRIS atau mengubah fee-nya, tetapi tidak
  bisa menyalakan crypto lagi. Pilihan metode di dialog isi saldo hanya muncul kalau ada lebih dari satu metode.
- **Yang harus diubah operator di relay (layar Zeiko Drive → Setup):** URL Drive menjadi
  `https://drive.zeiko.biz.id` dan return path menjadi `/paket`. Return path lama `/dashboard/paket` tetap
  sampai ke halaman yang benar lewat 301 di atas.

## ADR-039 — Drive mengikuti sesi Akun Zeiko, dan login pulang langsung ke Drive

**Konteks:** keluhan pemilik (2026-10-23): "alur akun dan cookies sangat tidak beraturan … Zeiko Drive
gabisa masuk, bentrok". Drive punya sesi Better Auth sendiri (30 hari) yang lepas dari sesi pintu
(`zk_auth`). Akibatnya: keluar di website tetapi Drive tetap masuk; masuk di website sebagai orang lain
tetapi Drive tetap menampilkan orang sebelumnya; dua identitas di satu browser. Jalan pulang setelah login
juga memutar lewat `zeiko.biz.id/dashboard/masuk` (ADR-038), yang bergantung pada Worker situs versi baru.

**Keputusan:**
- **Sesi pintu adalah satu-satunya yang menentukan.** Sesi Drive hanya mewakilinya. `/api/me` sekarang
  menyertakan `user.zeikoId` (Akun Zeiko yang ditautkan), dan `useDoorSync` (`src/web/lib/door-sync.ts`,
  dipasang di `AppShell`) bertanya ke pintu `GET /v1/session` saat app dibuka dan saat tab dilihat lagi
  (paling sering 15 detik sekali):
  - pintu bilang **keluar** → Drive keluar juga (sesi dihapus, data di layar dibuang), lalu halaman masuk;
  - pintu bilang **orang lain** → Drive keluar, dan halaman masuk langsung memasukkan orang itu (tiket);
  - pintu **tidak menjawab** → Drive jalan terus seperti biasa (ADR-036: Drive tetap jalan saat relay mati).
- **Satu browser, satu sesi.** `POST /api/auth/zeiko/exchange` menghapus sesi yang masih dibawa browser
  (orang sebelumnya, atau orang yang sama dari login lama) sebelum membuat yang baru. Pintu melakukan hal
  yang sama untuk `zk_auth` saat login/daftar/OAuth.
- **Login pulang langsung ke Drive.** Halaman masuk mengirim
  `next=https://drive.zeiko.biz.id/masuk?next=…` (alamat Drive sendiri, `sitePage` di `src/web/lib/zeiko.ts`).
  Website (`safeNext`, daftar `APPS`) dan pintu (`safe_next`, dari `drive.url`) menerima alamat itu persis:
  origin Drive, path dan query biasa, tanpa user dan fragmen. `SITE_WAY_BACK` dihapus. `/dashboard/…` tetap
  diteruskan oleh website dan Drive untuk link lama.
- **Dev:** pintu tiruan sekarang di origin app (`APP_ORIGIN` + `/__dev/door`), bukan origin API di balik
  proxy Vite — kalau tidak, cookie pintunya tidak terkirim (beda site). Tombol akun demo diperbaiki (kotak
  email kosong menimpa pilihan tombol), dan `/__dev/door/account/signup` ada.

**Syarat di relay:** `drive.url` harus `https://drive.zeiko.biz.id`. Tanpa itu pintu menolak CORS dari Drive
(login diam-diam gagal) dan `next` ke Drive ditolak.

Tes: `tests/integration/auth.test.ts` (`zeikoId` di `/api/me`; login lagi mengakhiri sesi lama).

## ADR-040 — Orang Drive diatur di Zeiko Accounts → People (satu daftar untuk tiga produk)

**Konteks:** permintaan pemilik (2026-10-23): "People di dashboard relay bagian drive itu jadiin satu aja
dengan Zeiko account biar mudah ngaturnya dan ga kebanyakan akun. Jadi ZeikoAI, ZeikoChat, dan Zeiko Drive
itu cukup satu akun." Identitasnya memang sudah satu sejak ADR-036 (tiap user Drive ditautkan ke Akun Zeiko
lewat `accounts.provider_id = 'zeiko'`), tetapi dashboard relay punya dua daftar orang.

**Keputusan:**
- Ops API baru `POST /api/ops/people {zeikoIds}` (`services/admin.ts::peopleByZeikoId`): untuk setiap id Akun
  Zeiko yang punya user Drive, kembalikan paket (kode, nama, status, akhir periode), storage (terpakai, batas,
  bonus), Saldo, dan status user. Id tanpa user Drive tidak disertakan. D1 hanya menerima 100 parameter per
  statement, jadi id dipecah per 90. Tidak ada apa pun tentang isi file.
- Dashboard relay: **Zeiko Accounts → People** menampilkan kolom Zeiko Drive dan bagian Drive di laci orang
  (ubah Saldo, bonus storage, beri paket, suspend) memakai endpoint `/users/:id/*` yang sudah ada, dengan
  alasan wajib (audit log Drive). Tab People di layar Zeiko Drive dihapus.
- Kalau Drive tidak menjawab, daftar People relay tetap tampil dan menyebut alasannya.

Tes: `tests/integration/ops.test.ts` (lookup per id Akun Zeiko, lebih dari 100 id, ops key salah = 404).

## ADR-041 — Tanpa Saldo dan invoice; notifikasi lewat email; lokasi iklan dari Akun Zeiko; iklan lewat admin

**Konteks:** permintaan pemilik (2026-10-24): "hapus saldo drive, riwayat saldo, dan invoice. notifikasi cukup
email, lokasi data iklan itu ditanyakan pada saat pendaftaraan, kota wajib kodepos opsional. pasang iklan itu
langsung kontak ke admin@zeiko.biz.id". Pilihan pemilik saat ditanya: lonceng di app tetap ada (selain email),
dan lokasi ditanyakan di formulir daftar **Akun Zeiko** (bukan di Drive).

**Keputusan:**
- **Tidak ada Saldo untuk pengguna.** Tidak ada isi saldo, kartu Saldo, riwayat saldo, daftar/halaman invoice,
  atau email invoice. Setiap pembelian (paket, naik paket, add-on, paket kompres, perpanjangan) dibayar QRIS
  saat itu juga, sebesar harga pembelian itu: `POST /api/billing/checkout {item}`. Harga dihitung di server
  (`quoteItem`), sama dengan yang nanti dipotong.
- **Di dalam, `wallets`/`wallet_ledger` tetap ada sebagai buku kliring** (uang masuk → pembelian keluar), jadi
  angka pendapatan admin/ops tidak berubah dan tidak ada data yang dimigrasi. Rupiah yang tersisa di sana —
  kode unik QRIS, pembelian yang gagal dibuat setelah dibayar, saldo lama, konversi/bubarnya keluarga, refund
  iklan — disebut **kredit**: dipotong otomatis dari pembayaran berikutnya (kalau kredit menutup harganya,
  pembelian langsung jadi tanpa QRIS). Halaman Paket hanya menyebutnya selama nilainya > 0. Pembelian yang gagal
  setelah dibayar juga memberi tahu admin (`admin_alert`).
- **Perpanjangan manual.** Pengingat H-3/H-1 lewat email (dengan tombol ke Paket); tombol **Perpanjang** membayar
  bulan berikutnya (`item.kind = 'renew'`): paket aktif diperpanjang dari akhir periodenya, paket yang lewat
  tempo dipulihkan mulai hari bayar (seperti reaktivasi sebelumnya). Tidak dibayar → masa tenggang, baca saja,
  dikunci, dihapus, seperti sebelumnya (SPEC §12.5). Kredit yang cukup tetap memperpanjang otomatis. Tombol "Hentikan
  perpanjangan" dihapus (tidak ada yang ditarik otomatis lagi).
- **Invoice** tetap ditulis di tabel `invoices` untuk pembukuan internal (pajak, nomor), tetapi tidak ditampilkan
  dan tidak dikirim. Notifikasi `payment_paid` sekarang menyebut apa yang dibeli.
- **Operator:** admin Drive dan laci People di relay menyebutnya **Kredit**, bukan Saldo, dan tetap bisa
  mengubahnya (dengan alasan, masuk audit log): selama buku kliring bisa menyimpan uang (kode unik, pembelian
  yang gagal), operator harus bisa melihat dan membereskannya. Ops API tidak berubah (`balanceIdr`,
  `/api/ops/users/:id/balance`), supaya relay versi lama tetap jalan.
- **Notifikasi: email + lonceng.** Telegram dihapus: tidak ada kanal Telegram di preferensi, tidak ada pengiriman
  ke Telegram, tidak ada tombol tautkan Telegram, dan "kirim lewat bot Telegram" ke username dihapus. Bagikan
  link lewat Telegram (`t.me/share`) tetap, karena itu berbagi, bukan notifikasi.
- **Lokasi iklan dari Akun Zeiko.** Formulir daftar Akun Zeiko meminta **kota (wajib)** dan **kode pos
  (opsional)**; akun lama dan akun Google/GitHub mengisinya di halaman akun. Pintu mengirim keduanya saat tiket
  ditukar; Drive menyimpannya (`users.ad_city`, `ad_postal_code`) dan mencocokkan kota ke `ad_areas`
  (`ad_city_code`) setiap login, dan saat app dibuka kalau kota di pintu berbeda (`door-sync`: tiket baru).
  Akun yang belum punya kota tidak mengubah apa-apa (kota lama pilihan pengguna di Drive tetap dipakai).
  Pengaturan Drive hanya menampilkannya, dengan link ke Akun Zeiko untuk mengubah. **Tebakan dari IP (`request.cf`) tidak dipakai lagi**: tanpa kota yang cocok (atau pengunjung tanpa
  akun) iklannya nasional. Kode pos disimpan untuk penargetan yang lebih halus nanti.
- **Pasang iklan = hubungi admin.** Halaman `/iklan` dan iklan internal Zeiko sekarang mengarah ke
  admin@zeiko.biz.id. API swalayan pengiklan (`/api/advertiser/*`) ditutup; booking yang sudah dibayar tetap
  tayang sampai selesai, moderasi admin tetap ada. Pembayaran iklan yang masih tertunda tetap diproses.

Tes: `tests/integration/billing.test.ts` (checkout per item, kredit, perpanjangan manual),
`tests/integration/auth.test.ts` (kota dari pintu), `tests/integration/notifications.test.ts` (email saja),
`tests/integration/ads.test.ts` (kota dari akun, tanpa IP).

## ADR-042 — Email uji dari ops API
Pemilik minta penguji email (2026-10-24), setelah `MAIL_RELAY_TOKEN` production terpasang. Drive tidak punya
cara mengirim email tanpa menunggu notifikasi sungguhan, dan tanpa token adapter diam-diam jatuh ke `mock`.
- `POST /api/ops/test-email {to}` (token ops seperti route ops lain) mengirim satu email lewat adapter yang sedang
  jalan, lalu menjawab `200 {ok, adapter, id | error}`. `adapter` menyebut jalurnya (`relay`, `cloudflare`,
  `mock`), jadi `mock` berarti tidak ada yang keluar dari Worker. Penolakan relay diteruskan apa adanya
  (dipotong 300 karakter): endpoint ini hanya untuk operator.
- Setiap percobaan, berhasil atau gagal, dicatat di audit log sebagai `email.test` dengan alamat tujuannya.

## ADR-043 — Aturan dan harga iklan: kampanye tanpa batas slot, rotasi 15 detik, cek manual
**Konteks:** aturan pemilik (2026-10-24): (1) tidak boleh SARA, judi, scam, membahayakan, dll.; (2) UMKM, small
business, mahasiswa didulukan; (3) semua iklan dicek manual, tidak otomatis; (4) satu pengiklan boleh di berbagai
tempat atau paket nasional; (5) kuota tidak terbatas, satu iklan tampil 15 detik lalu diganti iklan lain;
(6) pengiklan dapat dashboard sendiri (dilihat, diklik, dll.). Harga: 1 kota Rp1.000/hari, 10 kota Rp3.000/hari,
Nasional Rp10.000/hari. Pilihan pemilik saat ditanya: **pesan tetap lewat email ke admin** ("no automation, jadi
pengiklan wajib email kita dan kita cek apakah aman untuk ditampilkan"); **bayar setelah disetujui**; "didulukan"
berarti **dicek lebih dulu dan lebih sering tampil**; 2–9 kota **Rp1.000/kota, maksimal Rp3.000**. Lalu
(2026-10-24): "iklan itu dipesan via Email, bukan via website" — dan **bayarnya juga lewat email**: QRIS dikirim
di email persetujuan, website hanya untuk statistik.

**Keputusan:**
- **Kampanye menggantikan slot harian.** `ad_campaigns` (migrasi 0006): satu materi, `scope` `cities` atau
  `national`, area di `ad_campaign_areas` (kota/kabupaten, atau satu baris `ID`), tanggal mulai + jumlah hari,
  harga per hari dan total yang **dibekukan saat dibuat**. Tidak ada inventori, slot, hold 15 menit, atau batas
  per sesi lagi; `ad_inventory`, `ad_bookings`, `ad_prices` tetap di skema dan tidak dibaca (production belum punya
  satu pun baris iklan saat ini diputuskan). Provinsi tidak bisa dipilih.
- **Harga** (config, `adCampaignPricePerDay` di `shared/ad-policy.ts`, dipakai server dan form admin): Nasional
  `ad_price_national_idr`; kota: tiap `ad_bundle_cities` (10) kota penuh `ad_price_bundle_idr`, sisanya
  `ad_price_city_idr` per kota tapi tidak lebih dari satu paket, dan semuanya tidak lebih dari Nasional. 1 kota
  Rp1.000, 2 Rp2.000, 3–10 Rp3.000, 12 Rp5.000, 40+ Rp10.000. Pajak (`tax_rate_pct`) ditambahkan saat bayar.
- **Alur:** pengiklan email admin → admin (Admin → Iklan → Pasang iklan) mencari Akun Zeiko-nya lewat email (harus
  sudah pernah masuk Drive, karena dashboard-nya di /iklan), mengisi data pengiklan, materi + gambar, dan kampanye →
  materi baru selalu **`pending`** dan masuk Antrean cek → staf menyetujui/menolak → kampanye yang menunggu cek itu
  jadi `awaiting_payment` atau `rejected`.
- **Bayar lewat email** (`sendCampaignPayment`): saat itu juga Drive membuka QRIS atas nama pengiklan untuk
  totalnya dikurangi kredit (`purpose {kind: 'ad_campaign'}`) dan mengirim email berisi **gambar QR-nya**, nominal
  persis (dengan kode unik), dan batas bayar. Gambarnya `GET /ad/qr/{id}.png?t=…` (token HMAC, hanya selama
  menunggu pembayaran): klien email tidak menampilkan SVG atau `data:` URI, jadi Drive menggambar PNG sendiri
  (`lib/qr-png.ts`: matriks dari paket `qrcode`, dikompres `CompressionStream`). Teks QRIS-nya dari relay
  (`qris` di `/apps/v1/payments`, sejak 2026-10-24); relay yang lebih lama tidak mengirimnya, dan emailnya hanya
  berisi nominal dan tombol ke halaman bayar. Pengiklan scan dari email; operator mengonfirmasi QRIS-nya di
  Zeiko Accounts → QRIS seperti QRIS lain (alarm tidak berbunyi karena tidak ada yang menekan "Sudah bayar"; QRIS
  yang sudah ditutup tetap bisa dicairkan) → relay memberi tahu Drive → `paid`, atau `live` kalau mulainya hari
  ini. Kredit yang menutup semuanya langsung membayar saat disetujui. Kalau QRIS tidak bisa dibuka, pengiklan
  diberi tahu QRIS menyusul dan operator mendapat `admin_alert`; **Kirim ulang QRIS** di Admin → Iklan →
  Kampanye mengirim lagi QRIS yang masih terbuka atau membuka yang baru. Tidak ada tombol bayar di website.
  Belum dibayar sampai hari mulainya lewat → `expired` (cron 00:05 WIB). Catatan: kode unik QRIS hanya dijamin
  beda di antara QRIS terbuka satu hari terakhir, jadi pembayaran yang sangat telat perlu dicocokkan operator. Materi yang sudah disetujui bisa dipakai lagi: kampanye barunya
  langsung menunggu pembayaran. Mengubah materi mengirimnya ke cek lagi, beserta kampanye yang menunggu pembayaran.
- **Tidak ada keputusan otomatis.** `bannedTopic` hanya memberi tanda untuk pemeriksa ("perlu diperhatikan") dan
  tidak pernah menolak. `submitCreative` dan filter otomatisnya dihapus.
- **Didulukan:** Antrean cek mengurutkan UMKM/usaha kecil dan mahasiswa (`advertisers.kind` ≠ `lainnya`) lebih dulu;
  di rotasi mereka mendapat `ad_priority_weight` (2) giliran untuk tiap 1 giliran pengiklan lain. Diskon mahasiswa
  dan verifikasi `.ac.id` dihapus: harganya sudah rata, dan statusnya dicek admin.
- **Penayangan:** semua kampanye live untuk kota penonton + semua kampanye nasional, tanpa batas.
  `GET /api/ads` mengirim `{ads, rotateSeconds}`: urutan rotasi (smooth weighted round robin, maks 40 giliran,
  dimulai dari posisi acak). Kartu berganti tiap `ad_rotate_seconds` (15): ganti isi saja tanpa animasi, diam saat
  tab tersembunyi, dan minta urutan baru di akhir. Halaman share (tanpa JS) menampilkan satu iklan pilihan berbobot.
- **Statistik** per kampanye per hari per kota penonton (`ad_campaign_stats`): dilihat (≥ 50% terlihat ≥ 1 detik,
  token HMAC mengikat kampanye + tanggal + kota) dan diklik (`/ad/c/{id}?a=kota`). Tetap tanpa ID pengguna.
- **Dashboard pengiklan** di /iklan (aturan 6) untuk siapa pun yang punya kampanye: status, kota, tanggal, harga,
  pengingat bahwa QRIS-nya ada di email, dilihat/diklik/CTR, per hari dan per kota. Halaman yang sama menampilkan aturan dan harga untuk
  semua orang (dibaca dari config).
- **Penghentian:** kampanye `paid`/`live` dari materi itu `suspended`; hari yang belum tayang (mulai besok)
  dikembalikan sebagai kredit sesuai `ad_refund_on_suspend`; yang masih menunggu dibatalkan.
- Route: pengiklan `GET /api/advertiser` (baca saja); operator `/api/admin/ads/{advertiser,creatives,campaigns}`
  dan `campaigns/:id/send-payment` (admin saja, karena membuka tagihan), cek dan takedown untuk admin dan
  moderator; publik `/ad/qr/:id.png`.

Tes: `tests/integration/ads.test.ts` (harga, cek manual tanpa keputusan otomatis, urutan antrean, QRIS + gambar QR
di email persetujuan, kredit yang langsung membayar, rotasi berbobot tanpa batas, statistik per kota, kedaluwarsa,
refund takedown), `tests/integration/idor.test.ts`; relay `tests/drive.rs` (`qris` di jawaban pembayaran).


## ADR-044 — Zeiko S3: API S3 di Worker bersama, index per akun di D1
**Konteks:** permintaan pemilik (2026-10-24, diagram "Zeiko drive x Zeiko S3"): "Kerjakan S3 API". Diagramnya:
S3 → 1 user → **Worker bersama** → "1 user, 1 D1 pengganti index.txt" → "File tetap disimpan di 1 R2 1 folder 1
akun"; "1 worker dan R2 dapat dipakai untuk ratusan hingga ribuan user"; "Relay nanti dikasih tombol untuk
menambahkan user dan binding ke worker". ToS dan Kebijakan Privasi baru (ADR-045) menyebut Zeiko S3, Bucket, Access
Key/Secret Key, dan Bucket publik. SPEC §1/§5.1 sebelumnya melarang akses S3 langsung oleh klien; yang dimaksud di
sana adalah **kredensial atau presigned URL R2**, dan itu tetap tidak pernah keluar.

**Keputusan:**
- **Worker yang sama dengan Drive**, di host sendiri `S3_ORIGIN` (`https://s3.zeiko.biz.id`, staging
  `https://s3-staging.zeiko.biz.id`, dev `http://s3.localhost:8790`). Middleware pertama di `app.ts` meneruskan semua
  request host itu ke `routes/s3-api.ts`, jadi app, API Drive, dan cookie tidak pernah ada di sana. Satu Worker,
  satu bucket R2, satu D1 utama untuk semua akun.
- **Protokol S3 sungguhan:** SigV4 lewat header dan presigned URL (maks 7 hari, selisih jam 15 menit), payload hex
  SHA-256 (dicek sambil streaming: `DigestStream` di Workers), `UNSIGNED-PAYLOAD`, dan body `aws-chunked`
  (`lib/aws-chunked.ts`): chunk bertanda tangan dicek satu per satu, chunk tanpa tanda tangan + trailer checksum
  (default AWS SDK terbaru) diteruskan; checksum trailer tidak dicek karena TLS sudah menjaga isi. Operasi:
  ListBuckets, Create/Head/DeleteBucket, GetBucketLocation (`auto`), GetBucketVersioning (kosong), Get/PutBucketAcl
  (`private` / `public-read`), ListObjects v1/v2 (prefix, delimiter, marker/start-after, continuation token,
  `encoding-type=url` dengan spasi sebagai `+`), Put/Get/Head/DeleteObject (Range, If-Match/None-Match/
  Modified-Since/Unmodified-Since, `response-*` hanya untuk request bertanda tangan, metadata `x-amz-meta-*` maks
  2 KB, Content-MD5), DeleteObjects (maks 1.000), CopyObject (maks 5 GiB; ganti metadata pada objek yang sama tanpa
  menyalin byte), multipart lengkap termasuk UploadPartCopy, ListParts, ListMultipartUploads, Abort. Sisanya
  (CORS, policy, lifecycle, tagging, versi, ACL objek, GET per partNumber) menjawab `NotImplemented`.
  Error mengikuti kode dan status Amazon; satu tambahan: `QuotaExceeded` (403) saat penyimpanan akun penuh.
- **Akun = user Drive** (sudah pernah masuk dengan Akun Zeiko) dengan baris `s3_accounts`. Operator yang
  menyalakan dan memberi batas penyimpanan, sesuai diagram ("relay … tombol untuk menambahkan user"): ops API
  `POST /api/ops/s3/accounts {zeikoId | email | userId, limitBytes, reason}`, `GET /api/ops/s3/accounts`,
  `GET|PATCH /api/ops/s3/accounts/:userId {limitBytes?, suspended?, reason}`,
  `PUT /api/ops/s3/accounts/:userId/index {binding, reason}`, `POST /api/ops/s3/buckets/:name/block`.
  Penyimpanan S3 terpisah dari paket Drive; harga paket S3 belum ada (belum diputuskan pemilik).
- **Index per akun ("1 user, 1 D1")**: `s3_accounts.index_binding` menunjuk binding D1 milik akun itu
  (`S3_DB_*`). Selama belum ada, index-nya di D1 utama. Tabel index (`s3_objects`, `s3_uploads`,
  `s3_upload_parts`) dibuat oleh `services/s3-index.ts` saat pertama dipakai dan diberi versi skema (`s3_index_meta`),
  karena D1 per akun dibuat kosong oleh relay; jadi tabel itu tidak ada di folder `migrations/`. Index hanya bisa
  dipindah saat akun masih kosong (tidak ada objek atau upload), tanpa menyalin antar database. Batas Cloudflare:
  Workers Free 10 D1 per akun Cloudflare (semuanya), Paid 50.000; satu Worker bisa diberi sekitar 5.000 binding D1,
  cocok dengan "ratusan hingga ribuan user". Di Free, praktisnya index tetap di D1 utama.
- **Binding tetap ada setelah deploy:** binding `S3_DB_*` dicatat di `deploy/{env}.json` (`s3Indexes:
  [{binding, id, name}]`) dan ikut dibuat `gen-wrangler`. Tombol relay (belum dibuat) nanti harus: membuat D1,
  menambahkan entrinya ke daftar itu atau ke binding Worker lewat API Cloudflare, lalu memanggil
  `PUT …/index`. Kalau deploy menghapus binding yang masih dipakai, akun itu dapat `ServiceUnavailable`
  sampai binding-nya kembali.
- **Nama bucket global** (`s3_buckets`), mengikuti aturan nama Amazon (path-style, titik boleh), maks
  `s3_max_buckets_per_account` (100). Bucket hanya bisa dihapus saat kosong; upload multipart yang belum selesai
  ikut dibatalkan.
- **Access key** `ZK` + 18 huruf/angka, secret 40 karakter base62, ditampilkan sekali. Secret disimpan
  terenkripsi AES-GCM dengan secret Worker baru `S3_KEYS_ENC_KEY` (dibuat `cf-setup`), karena SigV4 butuh secret
  aslinya. Maks `s3_max_keys_per_account` (10). Hasil lookup key disimpan 15 detik per isolate; status akun dibaca
  ulang di setiap request, jadi pembekuan langsung berlaku dan pencabutan key berlaku paling lama 15 detik.
  `last_used_at` ditulis paling sering sekali per jam per key (penulisan D1 terbatas di Free).
- **Penyimpanan per akun** dipesan sebelum byte ditulis dan dicatat setelahnya, seperti Drive (SPEC §4):
  `reserveBytes` / `commitBytes` / `releaseBytes`. Part multipart dipesan per part; part yang diunggah ulang
  melepas pesanan lamanya. Cron malam menghitung ulang pemakaian dari index (`reconcileS3`), cron per jam membuang
  multipart yang lewat `s3_multipart_ttl_hours` (144) dan mengembalikan pesanannya.
- **Byte di R2** di `s3/{userId}/{blobId}` (satu folder per akun, sesuai diagram); nama hanya di index. Setiap
  objek punya byte sendiri: menimpa atau menghapus langsung menghapus byte lamanya, dan CopyObject menyalin byte di
  R2. Tidak ada dedup, juga di dalam satu akun.
- **Batas R2 dan Workers tetap berlaku:** body request 100 MB di zona Free/Pro (upload lebih besar = multipart),
  part minimal 5 MiB dan semua part kecuali terakhir sama besar (dicek sebelum R2 menolak, dengan pesan jelas).
- **Pemindaian:** setiap objek baru masuk Queue `scan` (`s3_scan`) dan memakai rantai scanner yang sama dengan Drive.
  Pemilik bisa langsung membaca objeknya; orang lain hanya setelah `clean`/`skipped`. Objek berbahaya dihapus,
  pemakaian dikembalikan, hash masuk blocklist, dan pemilik mendapat notifikasi `file_rejected`.
- **Bucket publik** (`public-read`): siapa pun boleh GET/HEAD objek yang sudah lolos pemindaian, tanpa listing dan
  tanpa menulis, dibatasi `RL_DOWNLOAD` per IP. Zeiko bisa mematikan akses publik sebuah bucket (`blocked_at`,
  ToS §4.2); pemiliknya tidak bisa menyalakannya lagi. Akun yang dibekukan (S3 atau user Drive) kehilangan API dan
  bucket publik, tetapi isinya tetap ada (ToS §9.1).
- **Keamanan respons:** semua objek dilayani dengan `X-Content-Type-Options: nosniff` dan
  `Content-Security-Policy: sandbox; default-src 'none'`. Host S3 satu *site* dengan `auth.zeiko.biz.id`, jadi HTML
  milik pengguna tidak boleh berjalan sebagai halaman di sana. Akibatnya hosting situs statis dari bucket tidak
  bisa, dan itu sejalan dengan ToS §3 (bukan CDN gratis).
- **Hapus akun (UU PDP):** `processAccountDeletions` mencabut key lalu menghapus objek per batch
  (`purgeS3Account`); sisanya dilanjutkan lewat Queue `cleanup` (`s3_purge`). Ekspor data menyertakan akun S3, id key
  (tanpa secret), dan daftar bucket.
- **Pemakaian per request** dicatat ke Analytics Engine (`s3_request`: akun, operasi, status, byte masuk/keluar)
  tanpa menulis ke D1, sebagai dasar batas request/bandwidth yang disebut ToS §5 bila nanti ada harga paket.
- **Halaman `/s3` di Drive** (sidebar "Produk Zeiko"): endpoint, region, pemakaian, membuat/mencabut key,
  membuat/menghapus bucket, publik/privat, contoh aws-cli dan rclone. API-nya `/api/s3/*` (sesi Drive, masuk suite
  IDOR).

**Konsekuensi:** Workers Free membagi 100 ribu request/hari dengan semua Worker di akun; klien S3 cukup cerewet,
jadi pemakaian sungguhan sebaiknya menunggu Workers Paid. Tes: `tests/integration/s3.test.ts` memakai AWS SDK v3
asli (bucket, objek, Range, metadata, aws-chunked, listing + paging + marker + url encoding, multipart + aturan
part, copy, kuota, DeleteObjects, presigned URL, bucket publik + pemindaian + blokir, EICAR, kunci salah/dicabut,
akun dibekukan, orang lain, index di D1 sendiri, hapus akun), `tests/unit/s3.test.ts` (SigV4 dibandingkan dengan
`@smithy/signature-v4`, rantai chunk dihitung terpisah dengan `node:crypto`, prefix, nama bucket, XML),
`tests/integration/idor.test.ts`.

## ADR-045 — Syarat & Ketentuan dan Kebijakan Privasi dari pemilik, dua bahasa
**Konteks:** pemilik memberi dua dokumen (bertanggal 25 Oktober 2026), "Syarat & Ketentuan Layanan Zeiko Drive dan
Zeiko S3" dan "Kebijakan Privasi Zeiko Drive dan Zeiko S3", untuk dimasukkan. Halaman `/kebijakan/*` sebelumnya
draf buatan sendiri, hanya Bahasa Indonesia (melanggar ADR-036), dan sebagian sudah usang (Saldo, perpanjangan
otomatis, lokasi dari IP).

**Keputusan:**
- Teks Indonesia dipakai **kata per kata** (`src/web/legal/{syarat,privasi}.id.ts`, dibuat langsung dari file
  pemilik). Baris judul dan "@bagas zainul" tidak ditampilkan; tanggal berlaku ditampilkan dari metadata.
  Terjemahan Inggris (`*.en.ts`) menyebut bahwa teks Indonesia yang berlaku.
- **Isian yang dikosongkan pemilik** diisi di satu tempat (`src/web/legal/contacts.ts`): dukungan dan privasi
  `admin@zeiko.biz.id` (alamat operator yang sudah dipakai), penyalahgunaan `abuse@zeiko.biz.id` (sudah di draf lama
  dan LAUNCH-CHECKLIST), website `https://zeiko.biz.id`, retensi log akses "90 hari" (`log_retention_days`), dan
  enkripsi saat disimpan "untuk file (Cloudflare R2)" (R2 mengenkripsi objek; untuk D1 tidak ditemukan pernyataan
  di dokumentasi, jadi tidak diklaim). Semua isian ini perlu dikonfirmasi pemilik.
- Halaman ditulis dalam subset Markdown kecil (`components/Markdown.tsx`: judul, paragraf, daftar, tabel, tebal,
  tautan dan email otomatis), dirender sebagai teks React, bukan HTML. Kebijakan Iklan ikut dipindah ke format yang
  sama dan diterjemahkan. **Kebijakan Konten** digabung: isinya kini ToS Bagian 3, dan `/kebijakan/kebijakan-konten`
  menampilkan ToS. Label "DRAF, perlu review hukum" tetap (SPEC §14.5) sampai pemilik bilang sudah direview.
- Tautan ke ToS dan Kebijakan Privasi ada di halaman masuk, sidebar, dan halaman Zeiko S3.

**Yang tidak sesuai dengan kode sekarang (perlu keputusan pemilik, belum diubah):**
- Kebijakan Privasi §4/§6 menyebut file **diunggah utuh ke VirusTotal** bila belum dikenal, dan gambar/video dikirim
  ke **Hive dan Thorn**. Kode tidak mengirim isi file ke mana pun: pemindai bawaan (hash + EICAR + blocklist), ClamAV
  di container sendiri saat Workers Paid, CSAM detector masih mock, dan aturan proyek (`CLAUDE.md`, SPEC §14.2)
  melarang mengirim isi file ke VirusTotal. Aturan itu tetap berlaku sampai pemilik memutuskan lain; teks
  kebijakannya (lebih luas dari praktik) tidak diubah.
- ToS §6–§9 menjelaskan prosedur peringatan 24 jam → suspensi → hapus, peringatan bertingkat untuk Kategori C,
  dan masa unduh 7 hari setelah akun dihapus. Panel moderasi sekarang punya takedown, karantina, blokir hash, dan
  bekukan akun, tetapi belum punya alur peringatan bertenggat dan hitungan peringatan per akun.
- ToS §2 menyebut Access Key/Secret Key dan §5 batas request API per paket: key sudah ada (ADR-044); batas request
  baru dicatat, belum ditegakkan, karena paket Zeiko S3 belum punya harga.
- Kebijakan Privasi tidak menyebut kota/kode pos untuk iklan lokal (SPEC §10.3 meminta itu dijelaskan); penjelasannya
  masih ada di Kebijakan Iklan.

## ADR-046 — VirusTotal dengan key pemilik: cek hash, kirim program yang belum dikenal

**Konteks:** ADR-045 mencatat Kebijakan Privasi §4 menyebut VirusTotal (hash, dan file yang belum dikenal "dapat
diunggah utuh"), sementara SPEC §14.2 dan `CLAUDE.md` melarang mengirim isi file ke VirusTotal. Pemilik
(2026-10-25): "Untuk sekarang pakai API Key Virus total ini", dan saat ditanya memilih **mengunggah executable yang
belum dikenal**. Key yang diberikan adalah key gratis (Public API: 4 request/menit, 500/hari, 15.500/bulan, tanpa
private scanning; dicek ke `/users/{key}/overall_quotas`).

**Keputusan:**
- Langkah baru di pemindaian Drive dan Zeiko S3, setelah scanner sendiri dan blocklist hash
  (`services/virustotal.ts`, adapter `adapters/virustotal.ts`). Hanya tipe berisiko yang dicek (`vtKind`, dari
  ekstensi lalu byte awal): program/installer/APK dan skrip dropper Windows, dokumen ber-macro, skrip `.bat/.cmd/.ps1`,
  arsip, dokumen Office/PDF. Foto, video, teks, dan kode sumber tidak dicek sama sekali.
- **Dikirim utuh** hanya program dan dokumen ber-macro yang belum dikenal VirusTotal, ≤ 32 MB (batas upload
  langsung), dengan nama `file.<ext>` (nama asli tidak ikut). Skrip teks tidak pernah dikirim (sering berisi
  kredensial); arsip, PDF, dan dokumen biasa hanya dicek hash-nya. Ini sejalan dengan Kebijakan Privasi §4 dan
  peringatannya tentang .exe/.apk/dokumen ber-macro.
- Ditolak bila ≥ `malicious_min` (default 3) mesin menyebutnya berbahaya: jalur `infected` biasa (hapus, kuota
  kembali, hash diblokir dengan alasan `VirusTotal: <label> (n/m)`, notifikasi).
- **Anggaran key** di D1 (`vt_budget`): per menit, per hari (UTC), dan per orang per hari (`per_user_day` 50), supaya
  satu folder berisi seribu DLL tidak menghabiskan jatah semua orang. Jawaban per hash disimpan (`vt_verdicts`):
  berbahaya selamanya, bersih `cache_days`, belum dikenal sehari.
- **VirusTotal tidak pernah menahan file lama.** Jatah menit habis atau HTTP 429 → pesan scan dikirim lagi
  menit berikutnya (maks `max_waits`); analisis upload dibaca tiap `poll_seconds` (maks `max_polls`). Jatah harian
  habis, key ditolak (operator mendapat email), error berulang, atau analisis terlalu lama → file lolos dengan
  putusan scanner sendiri, alasannya di `scan_detail`. Selama menunggu, pesan antrean membawa hash dan tipe hasil
  scanner (bukan data orang), supaya objek tidak dibaca ulang.
- Aktif bila secret `VIRUSTOTAL_API_KEY` ada dan config `virustotal.enabled`; `virustotal.upload` mematikan
  pengiriman file. Dev/test memakai `MockVirusTotal` (`ADAPTER_VIRUSTOTAL=mock`). Flag lama
  `features.virustotal_hash_lookup` dihapus.
- Aturan proyek diubah: isi file boleh keluar **hanya** ke VirusTotal, **hanya** untuk tipe di atas.

**Risiko yang diterima pemilik:** ketentuan VirusTotal melarang Public API dipakai di produk/layanan komersial
dan di alur bisnis yang tidak menyumbang file baru; key bisa diblokir kapan saja (pemindaian tetap jalan tanpa
VirusTotal). File yang dikirim lewat Public API dapat dilihat pelanggan VirusTotal. Jalan keluarnya lisensi
Premium (private scanning), lihat LAUNCH-CHECKLIST.

## ADR-047 — Paket Zeiko S3 dibayar di awal, 1 atau 3 salinan sungguhan

**Konteks:** harga dari pemilik (2026-10-25): "Replicate 1x: 500/Gb", "Replicate 3x: 1250/Gb", "Egress: Free 500Gb
lalu 5000 / 500Gb". Tier 3x yang isinya tetap satu salinan tidak dibuat (menjual fitur yang tidak ada). Pemilik
lalu memutuskan: "Replikasi 3x jadi 1500" (dengan salinan sungguhan) dan "Bayar diawal berapa giga, minimal 3
giga". Egress tetap "jalan terus, ditagih belakangan" (pilihan pemilik sebelumnya). Model pascabayar yang sempat
dibuat di commit sebelumnya diganti; migrasi `0007`/`0008` belum pernah dijalankan di database remote mana pun,
jadi `0008` diubah langsung.

**Keputusan:**
- **Paket** (`s3_subscriptions`, satu per orang): ukuran dalam GB bulat, minimal `s3_min_gb` (3), maksimal
  `s3_max_gb` (5.000), dengan 1 salinan (`s3_price_idr_per_gb_month`, Rp500/GB/bulan) atau 3 salinan
  (`s3_price_idr_per_gb_month_3x`, Rp1.500/GB/bulan). Periode = bulan tagihan seperti paket Drive
  (`addBillingMonth`, tanggal jangkar WIB). Batas akun (`limit_bytes`) = ukuran paket.
- **Dibayar di awal** lewat checkout yang sama dengan Drive (ADR-041): `CheckoutItem { kind: 's3_plan', gb, replicas }`
  dan `{ kind: 's3_renew' }`. QRIS untuk sisanya setelah kredit; invoice untuk pembukuan. Siapa pun yang sudah masuk
  Drive bisa membeli di `/s3`; akun S3 dibuat saat pembelian pertama. Akun yang dinyalakan operator tanpa paket
  (relay, ADR-044) tetap ada dan tidak ditagih.
- **Ubah paket:** yang lebih mahal per bulan langsung berlaku, dibayar selisihnya untuk sisa periode (pro-rata);
  yang lebih murah dijadwalkan (`next_gb`, `next_replicas`) mulai periode berikutnya, tanpa bayar. Ukuran tidak boleh
  lebih kecil dari isi yang tersimpan (`S3_TOO_SMALL`).
- **Perpanjangan manual** seperti Drive: pengingat H-3/H-1 (`billing_reminder_days_before`, notifikasi `s3_reminder`),
  tombol Perpanjang (dari akhir periode; paket yang sudah berakhir dimulai lagi dari hari bayar). Kredit yang cukup
  memperpanjang sendiri dalam sehari setelah berakhir (cron per jam).
- **Egress:** setiap GET objek (ber-key atau anonim di bucket publik) menambah egress pemilik bucket pada periode
  paketnya (`s3_usage`, lewat `waitUntil`). Gratis `s3_egress_free_bytes` (500 GB) per periode; kelebihannya per blok
  `s3_egress_block_bytes` (500 GB) yang dimulai × `s3_egress_block_idr` (Rp5.000) ditambahkan ke perpanjangan **setelah
  periodenya selesai** (periode yang masih berjalan masih bertambah). Kalau kredit/pembayaran tidak menutup semua blok,
  sisanya menunggu perpanjangan berikutnya (`billed_blocks`), jadi egress yang terjadi di antara harga dan pembayaran
  tidak pernah menggagalkan pembelian.
- **3 salinan sungguhan** (`services/s3-replicas.ts`): dua bucket R2 lagi, `zeiko-s3-replica-a-<env>` (lokasi
  `weur`) dan `-b-<env>` (`wnam`), dibuat `cf-setup` dan diikat sebagai `S3_REPLICA_A/B`. Objek di akun 3 salinan
  disalin ke keduanya setelah lolos pemindaian (≤ 4 GiB sekali put, lebih besar per bagian), ditandai `replicated` di
  index (skema index v2). Naik ke 3 salinan menyalin isi yang sudah ada (antrean `s3_replicate`); turun ke 1 salinan
  menghapus salinan tambahan (`s3_unreplicate`). Hapus selalu ke ketiga bucket (gratis). Baca dari salinan pertama, dan
  dari salinan lain kalau yang pertama hilang. Sapuan malam menyalin ulang yang gagal. Tanpa kedua binding, pilihan 3
  salinan tidak ditawarkan dan ditolak (`NO_REPLICAS`).
- **Tidak diperpanjang** (`s3_dunning`, hari setelah periode berakhir): 0–2 hari jalan normal; 3 hari →
  `billing_state = readonly` (PUT/POST ditolak `AccountProblem`, kecuali DeleteObjects; bucket publik tertutup; baca,
  list, dan hapus tetap bisa); 14 hari → `locked` (semua request ber-key ditolak); 30 hari → data dihapus
  (`s3_purge`), hanya bila `dunning_delete_mode = live` dan tidak ada pembayaran yang sedang berjalan. Memperpanjang
  langsung mengembalikan `billing_state`. Email + lonceng `s3_reminder` dan `s3_dunning` wajib.
- Biaya R2 untuk 3 salinan ±3 × $0,015/GB-bulan (±Rp750–810/GB), jadi harga Rp1.500 masih menutupnya.
