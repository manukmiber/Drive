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

