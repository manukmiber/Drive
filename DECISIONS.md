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
**Digantikan ADR-064** (pemilik, 2026-10-26): Drive kembali ke diagram, satu index per user/keluarga di R2, tanpa D1.
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
  **Diperbarui 2026-10-26:** pemilik minta label draf dihapus dari semua halaman kebijakan; sekarang tidak ada label.
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
- **Diubah 2026-10-27** (pemilik: "S3 3 salinan 1250/Gb"): `s3_price_idr_per_gb_month_3x` default Rp1.250/GB/bulan,
  masih di atas biaya R2 tiga salinan. Database yang sudah punya baris `app_config` untuk kunci ini tetap memakai
  nilainya sampai diganti lewat ops.

## ADR-048 — Alamat Zeiko S3 sendiri: subdomain Zeiko Rp3.000, domain sendiri Rp5.000

**Status:** diterima (pemilik, 2026-10-25). **Konteks:** pemilik: "S3 pakai Url mereka sendiri bayar 5K dan kalau
S3nya ga dibayar 1 bulan, maka next renewal bayar url lagi", lalu "Kalau misal S3.namapilihanuser.zeiko.biz.id itu
cuma 3K". Pilihan: keduanya, dan opsional.

**Keputusan:**
- Tambahan opsional untuk akun yang punya paket aktif (ADR-047), satu alamat per akun, **sekali bayar** lewat checkout
  (`CheckoutItem { kind: 's3_url', url: { type: 'zeiko', name } | { type: 'custom', hostname } }`), harga di config
  `s3_url_zeiko_idr` (Rp3.000) dan `s3_url_custom_idr` (Rp5.000).
  - **Subdomain Zeiko** `s3.<nama>.<S3_SUBDOMAIN_SUFFIX>` (production `zeiko.biz.id`): custom domain Worker lewat API
    Cloudflare; Cloudflare membuat record DNS dan sertifikat (Advanced Certificate, juga untuk subdomain bertingkat),
    langsung aktif. Nama 3–32 huruf kecil/angka/tanda hubung; nama layanan Zeiko dan nama yang memuat `zeiko` ditolak
    (`URL_RESERVED`). Custom domain yang sudah ada tidak pernah diambil alih (PUT Cloudflare akan memindahkannya).
  - **Domain sendiri** (mis. `s3.tokobudi.com`, minimal tiga label, bukan di zone Zeiko): custom hostname Cloudflare for
    SaaS + route Worker khusus untuk host itu (bukan `*/*`, karena zone `zeiko.biz.id` juga dipakai layanan lain).
    Menunggu DNS sampai pemiliknya membuat CNAME ke `S3_CNAME_TARGET` (fallback origin, `custom-s3.zeiko.biz.id`);
    halaman `/s3` menampilkan record yang harus dibuat, tombol Periksa lagi, dan cron per jam memeriksa sendiri.
- Alamat sendiri melayani **hanya akun pemiliknya**: path-style, key orang lain `AccessDenied`, bucket orang lain
  `NoSuchBucket`. Endpoint bersama tetap jalan. Siapa pemilik host dibaca dari `s3_urls` (cache 30 detik per isolate).
- Pembelian memesan nama dulu (baris `reserved`), baru memanggil Cloudflare, lalu memotong kredit dan mengaktifkan
  baris dalam satu batch. Gagal di tengah → nama dilepas lagi (dan dihapus di Cloudflare); pesanan yang tertinggal
  (request mati) dibersihkan cron per jam setelah 10 menit.
- **Dilepas** kalau paket tidak dibayar `s3_url_release_days` (30) hari setelah periodenya berakhir (cron malam,
  notifikasi `s3_url_released`, email wajib), kalau pemiliknya melepas sendiri (tanpa refund), atau saat akun S3
  dihapus. Setelah dilepas, alamat harus dibeli lagi (setelah memperpanjang paket) dan namanya bisa diambil orang lain.
  Selama paket diperpanjang, alamat tetap dan tidak ditagih lagi.
- Butuh secret `CF_HOSTNAMES_TOKEN` (pemilik) dan `CF_ACCOUNT_ID`, `CF_ZONE_ID` (`zoneId` di `deploy/{env}.json`),
  `WORKER_NAME`. Tanpa itu pilihan ini tidak ditampilkan. Adapter `hostnames` dengan mock untuk dev/test.

**Konsekuensi:** Cloudflare for SaaS harus dinyalakan di zone dan fallback origin dibuat (perubahan zone, oleh pemilik).
Kuota custom hostname dan batas route/custom domain per zone dari Cloudflare berlaku; cek sebelum ramai. Virtual-hosted
style (`bucket.s3.nama…`) tidak didukung di alamat sendiri.

## ADR-049 — Fitur yang belum siap disembunyikan; relay menampilkan kebutuhannya

**Status:** diterima (pemilik, 2026-10-25). **Konteks:** pemilik: "Kalau misal ada fitur yang belum ready, sembunyikan
dari tampilan user ya. Baru nanti ditampilkan kalau misal aku udah isi semua yang diperlukan", lalu "Sekalian kasih
how to atau caranya ngisi yang diperlukan di relay".

**Keputusan:**
- `services/readiness.ts` adalah satu-satunya tempat yang memutuskan fitur mana yang jalan di sini. Setiap fitur punya
  daftar kebutuhan, masing-masing dengan jenis:
  - `secret`: diisi dari Setup relay, yang menaruhnya ke Worker;
  - `deploy`: datang dengan `cf-setup` (binding, var, secret acak, tabel);
  - `cloudflare`: langkah di dashboard Cloudflare, lalu satu baris di `deploy/<env>.json`.

  Setiap kebutuhan punya cara mengisinya (`how`). Sebuah fitur siap kalau semua kebutuhannya terpenuhi dan fitur yang
  ditunggunya (`after`) juga siap.
- Aplikasi membaca `capabilities` dari `/api/public/catalog` dan **menyembunyikan** yang belum siap, tidak
  menampilkannya dalam keadaan mati:
  - Zeiko S3 (menu dan halaman `/s3`, yang menjadi 404);
  - pilihan 3 salinan dan harganya;
  - alamat sendiri (subdomain Zeiko / domain sendiri);
  - kirim link lewat email (di staging/production tanpa email sungguhan);
  - arsip TAR.ZST.

  Server tetap menolak hal yang sama.
- Relay membaca `GET /api/ops/readiness` (bearer ops), berisi nama kebutuhan dan status saja, **tidak pernah nilai
  secret**. Tab Features di layar Zeiko Drive relay menampilkannya dan mengisi secret yang ada di daftar izin relay ke
  Worker Drive.
- Di dev/test, adapter mock alamat sendiri membuat kebutuhan Cloudflare-nya dianggap terpenuhi (mock tidak pernah aktif
  di production).

**Konsekuensi:** fitur baru yang bergantung pada setelan pemilik harus didaftarkan di `readiness.ts` dan disembunyikan
lewat `capabilities` sampai siap.

## ADR-050 — Editor foto, video, dan PDF di browser

**Status:** diterima (pemilik, 2026-10-25). **Konteks:** pemilik: "Tambahkan basic photo editor", "basic video editor
(Cut, split, merge)", dan "PDF viewer, sign, compress, dll".

**Keputusan:**
- Semua editor jalan **di browser orang itu sendiri**. Isi file tidak dikirim ke layanan luar mana pun (larangan di
  `CLAUDE.md`) dan tidak memakai Container, kredit, atau CPU Worker. Library dibundel di app (tidak dari CDN):
  - `mediabunny` (MPL-2.0) untuk video;
  - `pdfjs-dist` build *legacy* (Apache-2.0) untuk menampilkan PDF. Build biasa memakai API JavaScript yang belum ada
    di banyak HP;
  - `pdf-lib` (MIT) untuk mengubah PDF.

  Ketiganya hanya dimuat saat editor dibuka.
- Bytes diambil lewat URL pratinjau `USERCONTENT_ORIGIN` yang sudah ada (CORS untuk `APP_ORIGIN`), dengan cek izin
  dan scan yang sama. Hasil disimpan lewat antrean upload biasa, jadi kuota, scan, thumbnail, dan izin folder tetap
  berlaku:
  - **file baru** di folder yang sama, dengan nama "… (edit)" (kalau tidak boleh mengubah folder itu, ke Drive Saya);
  - **ganti file asli**: file lama masuk Sampah, jadi masih bisa dipulihkan.

  Hasil juga bisa langsung diunduh ke perangkat tanpa disimpan. File dari perangkat juga bisa dibuka lewat halaman
  `/alat`.
- **Foto:** potong (bebas atau rasio), putar, balik, terang/kontras/saturasi/hangat, filter, ubah ukuran, simpan
  JPEG/PNG/WebP. Data EXIF (termasuk GPS) tidak ikut ke hasil.
- **Video:** potong awal/akhir, pisah di titik putar, hapus dan urutkan bagian, gabung beberapa video. Hasilnya satu
  file, atau tiap bagian jadi file sendiri. Ada dua cara:
  - **Cepat:** salin tanpa encode ulang. Potongan menempel ke keyframe terdekat, dan gabung hanya untuk video dengan
    format yang sama;
  - **Tepat:** encode ulang dengan WebCodecs. Tepat per frame dan bisa menggabung ukuran berbeda, tapi lebih lama
    dan hanya ada kalau browser bisa meng-encode.
- **PDF:**
  - lihat (pdf.js, juga di pratinjau, karena Chrome Android tidak bisa menampilkan PDF di iframe);
  - atur halaman: putar, hapus, urutkan, ambil sebagian, pisah per halaman, tambah PDF/gambar (gabung);
  - tanda tangan (gambar, ketik, atau foto), teks, tanggal;
  - kompres:
    - *Seimbang:* foto JPEG di dalamnya diperkecil, teks tetap bisa dipilih;
    - *Kecil:* halaman jadi gambar.
  - Gambar yang dipilih di Drive bisa dijadikan satu PDF.

  PDF bersandi bisa dilihat, tapi tidak bisa diubah.
- Batas ukuran yang dibuka editor ada di config, dan dikirim ke app lewat katalog publik: `editor_image_max_bytes`,
  `editor_video_max_bytes`, `editor_pdf_max_bytes`. Alasannya: semuanya diproses di memori perangkat. Editor tidak
  butuh apa pun dari pemilik, jadi tidak didaftarkan di `readiness.ts`.

**Konsekuensi:**
- Hasil edit memakai kuota seperti file lain.
- Mode Tepat dan HEIC bergantung pada browser.
- `pdfjs-dist` membawa cmaps, font standar, dan decoder wasm sebagai aset statis di `/pdfjs-<versi>/`. Aset ini
  disalin oleh plugin kecil di `vite.config.ts`.

## ADR-051 — Editor teks/kode, dokumen, spreadsheet, dan ZIP di browser

**Status:** diterima (pemilik, 2026-10-25). **Konteks:** pemilik: "memperbanyak fitur editing, file, beserta menambahkan
spreadsheet, docs, dll? ambil dari github boleh kok gausah bikin dari awal".

**Keputusan:**
- Aturannya sama dengan ADR-050:
  - semuanya jalan di browser, isi file tidak dikirim ke mana pun;
  - library open source dibundel dan baru dimuat saat editor dibuka;
  - bytes lewat URL pratinjau, hasil lewat antrean upload (file baru, ganti asli → Sampah, atau unduh).
- **Teks dan kode** (`.txt`, `.md`, `.json`, kode, config, subtitle; daftar `TEXT_EXT` pratinjau): CodeMirror 6 (MIT).
  - Bahasa dipilih dari ekstensi (`@codemirror/language-data`; mode bahasanya juga baru dimuat saat dipakai).
  - Ada cari & ganti, nomor baris, dan bungkus baris.
  - Markdown punya tampilan pratinjau: `marked` (MIT), dibersihkan `DOMPurify` (Apache-2.0/MPL-2.0).
  - Hanya UTF-8. BOM dan akhir baris (CRLF/LF) dipertahankan. File yang bukan UTF-8 ditolak, tidak diubah diam-diam.
- **Dokumen** (`.docx`, dokumen baru): TipTap 3 (MIT, di atas ProseMirror).
  - Isinya: judul, tebal/miring/garis bawah/coret, warna sorot, daftar, daftar centang, perataan, tautan, tabel,
    gambar.
  - `.docx` dibuka dengan `mammoth` (BSD-2-Clause) menjadi HTML yang dibersihkan DOMPurify. Tata letak halaman,
    header/footer, komentar, dan lacak perubahan tidak ikut. Editor menyebutkannya saat file dibuka, dan "ganti asli"
    tetap mengirim yang lama ke Sampah.
  - Disimpan sebagai `.docx` (`docx`, MIT; HTML dari TipTap diubah oleh `docx/html` milik library itu sendiri),
    Markdown (`@tiptap/markdown`), atau HTML.
  - Pratinjau `.docx` memakai `docx-preview` (Apache-2.0), dibersihkan DOMPurify. Tautan hanya http(s)/mailto, dan
    CSP app tetap menolak skrip inline.
- **Spreadsheet** (`.xlsx`, `.csv`, `.tsv`, spreadsheet baru): FortuneSheet (MIT), dengan `@corbe30/fortune-excel`
  (MIT, memakai `exceljs`) untuk `.xlsx`.
  - Isinya: rumus, format angka, gabung sel, bekukan baris, urut, filter, beberapa lembar.
  - Disimpan sebagai `.xlsx`, atau `.csv` (lembar yang sedang dibuka). `.xls` lama (biner) tidak didukung.
  - Teks UI FortuneSheet hanya ada dalam bahasa Inggris (dan beberapa bahasa lain, tanpa Indonesia). Untuk bahasa
    Indonesia, teks bagian yang kita tampilkan ditimpa terjemahan kita di `editors/sheet/fortune-id.ts` (bukan
    `strings.*`, supaya ikut dimuat bersama editor, tidak bersama app). Bantuan fungsi rumus (SUM, VLOOKUP, …) tetap
    bahasa Inggris, karena nama fungsinya pun bahasa Inggris. Huruf bawaan sel Arial, bukan Times New Roman.
  - FortuneSheet memakai `new Function` saat menyisipkan baris, dan itu ditolak CSP app (tanpa `unsafe-eval`).
    Plugin kecil di `vite.config.ts` menggantinya dengan `JSON.parse` (dan membuang dua label tombol berbahasa
    Mandarin yang ditulis langsung di kodenya). Build gagal kalau kode aslinya berubah, supaya ketahuan saat versi
    naik.
  - FortuneExcel membaca semua nilai `.xlsx` sebagai teks, lalu menulisnya kembali sebagai teks: `100` akan kembali ke
    Excel sebagai `"100"`. Sel yang angka menurut `exceljs` dijadikan angka lagi saat dibuka (`sheet/xlsx.ts`).
  - CSV: pemisah (`,` `;` tab) dikenali dari baris pertama dan dipakai lagi saat menyimpan. Hanya desimal biasa yang
    jadi angka, jadi `0812…` dan kode tetap teks. CSV bukan UTF-8 dibaca sebagai Windows-1252 (CSV dari Excel
    Windows).
- **ZIP:** isi `.zip` dilihat dan dibongkar di browser. Pilihannya: unduh satu file, bongkar yang dipilih, atau
  bongkar semua ke folder baru bernama sama di sebelah ZIP-nya (lewat antrean upload, folder dibuat seperti upload
  folder).
  - Daftar isi (central directory, termasuk ZIP64) dibaca sendiri di `editors/zip/zip.ts`, jadi file bersandi sudah
    ketahuan sebelum dibongkar (ditandai, tidak bisa dipilih). `fflate` (MIT) hanya untuk inflate; file > 512 KB
    di-inflate di worker fflate (`blob:`, diizinkan `worker-src`) supaya halaman tidak macet.
  - Setiap file dicek CRC-32-nya; yang rusak dilewati dan disebutkan. Hasil inflate tidak pernah lebih besar dari
    ukuran di daftar isi (fflate menulis ke buffer seukuran itu), jadi batas `editor_zip_extract_max_bytes` dihitung
    dari daftar isi dan tetap aman terhadap ZIP bom yang berbohong soal ukuran.
  - Nama dibersihkan per folder seperti di Worker (`worker/lib/names.ts`), plus `..`, `/` di depan, dan huruf drive
    dibuang, jadi tidak ada file yang keluar dari folder tujuan. Sampah dari Mac/Windows (`__MACOSX/`, `.DS_Store`,
    `Thumbs.db`, `desktop.ini`) tidak ditampilkan dan tidak ikut dibongkar.
- **Baru → File teks / Dokumen / Spreadsheet** di menu Baru: editor dibuka dengan file kosong, lalu disimpan ke folder
  yang sedang dibuka (atau Drive Saya kalau tidak boleh menambah file di sana).
- **Batas ukuran** di config, dikirim lewat katalog publik: `editor_text_max_bytes`, `editor_doc_max_bytes`,
  `editor_sheet_max_bytes`, `editor_zip_max_bytes`. Total hasil bongkar dibatasi `editor_zip_extract_max_bytes`
  (melindungi memori HP dari ZIP bom). Seperti ADR-050, tidak ada yang dibutuhkan dari pemilik, jadi tidak masuk
  `readiness.ts`.

**Konsekuensi:**
- Bundel app bertambah besar, tapi hanya untuk orang yang membuka editornya. FortuneSheet + exceljs adalah yang
  terbesar.
- `.docx` yang rumit bisa berubah tampilannya setelah disimpan dari editor.
- `npm audit` saat ditambahkan: `uuid` 8 di FortuneSheet/exceljs (moderat; celahnya di v3/v5/v6 dengan `buf`, yang
  tidak dipakai, keduanya hanya `v4`). Temuan `undici` (tinggi) ada di `wrangler`/`miniflare`, alat dev, sudah ada
  sebelumnya.

## ADR-052 — Editor foto ala Snapseed dan alat PDF yang lebih lengkap

**Status:** diterima (pemilik, 2026-10-26). **Konteks:** pemilik: "aku mau kita punya editor yang ga kaleng²… tambahin
banyak fitur tapi jangan bikin bingung user dengan tombolnya", lalu "tambahkan fitur editing aja, kek snapseed minimal".
Hapus/ganti latar belakang dibatalkan pemilik (butuh model AI), jadi tidak ada model atau layanan baru.

**Keputusan:**
- Aturan ADR-050 tetap: semuanya jalan di browser, isi foto tidak dikirim ke mana pun, hasil lewat antrean upload.
  Tidak ada library baru; efeknya ditulis sendiri pada piksel (`editors/photo/effects.ts`), tanpa canvas `filter`
  (Safari tidak punya), jadi pratinjau dan hasil simpan sama.
- **Tata letak seperti Snapseed**, supaya tombolnya tidak membingungkan: dua tab, **Looks** (15 gaya siap pakai dengan
  slider kekuatan) dan **Alat** (grid 13 alat). Alat dibuka di bawah foto dengan ✕ (batal) dan ✓ (terapkan); satu ✓
  = satu langkah urungkan/ulangi. Tombol mata di atas: tahan untuk melihat foto asli dalam bingkai yang sama.
- **Alat:** Atur gambar (kecerahan, kontras, saturasi, suasana, sorotan, bayangan, kehangatan, + Otomatis), Detail
  (struktur, ketajaman), Kurva (semua/merah/hijau/biru, titik digeser, preset, histogram), White balance (suhu, rona,
  + Otomatis gray-world), Potong (8 rasio), Putar (90°, balik, luruskan ±45° yang membesar sendiri tanpa sudut kosong),
  Perbaiki (ketuk noda; ditambal dari area sekitar yang paling mirip), Blur lensa (bulat/garis, titik tengah digeser),
  Vinyet, Efek (glow, butiran film, pudar), Teks (4 gaya, warna, ukuran, digeser), Bingkai (tipis, tebal, polaroid,
  sudut bulat), Ukuran (skala atau piksel pas, JPEG/PNG/WebP, kualitas).
- Ukuran efek (radius blur, butiran, teks, titik perbaikan) dihitung sebagai bagian dari foto, bukan piksel layar,
  supaya salinan kecil di layar terlihat sama dengan foto penuh yang disimpan. Teks dan titik perbaikan disimpan di
  koordinat foto, jadi ikut berpindah saat foto diputar, dibalik, atau dipotong.
- Struktur menekan beda yang besar (tepi tajam) supaya tekstur naik tanpa halo; blur besar dihitung di salinan kecil
  lalu diperbesar (cepat di HP).

- **Alat PDF** (pemilik: "More editor PDF"), tetap pdf-lib + pdf.js, tanpa library baru. Lima tab: Lihat, Halaman,
  Isi & TTD, Formulir (hanya kalau PDF-nya punya isian), Alat.
  - Halaman: tambahan **Duplikat** (stempelnya ikut) dan **Halaman kosong** seukuran halaman yang dipilih. Halaman
    kosong tidak membuat hasilnya dianggap gabungan, jadi "ganti file asli" tetap ada.
  - Isi & TTD: tambahan **centang** dan **silang** (digambar, bukan huruf), **stabilo** (kotak kuning *multiply*, teks
    tetap terbaca), **tutup putih**, **gambar** dari perangkat (logo, stempel), dan tinta merah untuk teks/tanda.
    Tanda tangan tetap hitam/biru. Tutup putih hanya menutupi tampilan; teks di bawahnya masih bisa disalin, dan
    editor mengatakannya (untuk menghapus sungguhan: Kecilkan → Paling kecil, yang menjadikan halaman gambar).
  - Formulir: isian teks, centang, pilihan, dan radio dari AcroForm diisi lewat daftar per halaman, lalu disimpan di
    file yang sama; bisa dikunci (*flatten*). Kalau halaman diubah urutannya atau digabung, isian otomatis dikunci
    supaya tidak hilang. Font standar PDF hanya punya huruf Latin; huruf lain ditolak dengan pesan yang jelas.
  - Alat: **tanda air** (tulisan miring di tengah tiap halaman, kepekatan dan ukuran; huruf non-Latin ditulis
    sebagai gambar), **nomor halaman** (3 posisi, 3 bentuk, mulai dari), Kecilkan (yang lama), **Jadikan gambar**
    (JPG/PNG 150/300 dpi per halaman) dan **Ambil teks** (.txt). Semuanya bekerja pada PDF seperti akan disimpan,
    stempel dan isian ikut. Tanda air dan nomor halaman terlihat di atas halaman selama mengedit.

**Konsekuensi:**
- Menyimpan foto 2 MP dengan semua efek ±1,5 detik di HP uji; foto 12 MP bisa beberapa detik (ada tanda memproses).
- Belum ada: kuas lokal (selective/brush), perspektif, hapus latar, sensor PDF permanen, sandi PDF, OCR.

## ADR-053 — Batas upload/unduh sendiri (maks 20) dan antrean unduhan di app

**Status:** diterima (pemilik, 2026-10-26). **Konteks:** pemilik: "buat untuk share, S3, dan upload/download lebih
robust dan punya banyak fitur. Sekarang user bisa ngelimit upload dan download per batch sesuai dengan internet
mereka. Mentok 20 upload dan 20 download." Sebelumnya batas upload hanya dari config (3 file × 4 bagian) dan unduhan
banyak file hanya lewat ZIP.

**Keputusan:**
- **Pilihan orangnya sendiri, per perangkat** (`src/web/lib/transfer.ts`, localStorage `zk_transfer`): upload
  bersamaan, bagian per file besar, dan unduhan bersamaan. Internet melekat ke perangkat dan jaringannya, bukan ke
  akun, jadi tidak disimpan di server. Preset Hemat (1/2/1), Normal (default config), Cepat (8/6/8), Maksimal (batas
  atas), atau atur sendiri; saran dari `navigator.connection` kalau browser punya. Di Pengaturan → "Upload &
  unduhan" dan lewat ⋮ di panel transfer.
- **Batas atas 20 file tiap arah, tidak bisa lebih**: config `upload_parallel_files_cap` dan
  `download_parallel_files_cap` (skema `max(20)`, default 20) hanya bisa menurunkan; `upload_part_concurrency_cap`
  (default 8) untuk bagian per file. Default untuk perangkat yang belum memilih: `upload_max_parallel_files` (3),
  `upload_part_concurrency` (4), `download_max_parallel_files` (3). Semua ada di config publik.
- **Upload lebih tahan banting** (`upload/manager.ts`): batas baru langsung berlaku, juga untuk file yang sedang
  berjalan (jumlah pekerja bagian ikut naik/turun); tanpa jaringan, bagian **menunggu** (status "Menunggu koneksi")
  tanpa menghabiskan jatah coba ulang; upload yang gagal karena jaringan dimulai lagi otomatis saat online; satu bagian
  yang gagal permanen menghentikan bagian lain; jeda/lanjut/batal semua.
- **Unduh file terpisah** (dialog Unduh untuk banyak item/folder, di samping ZIP): `POST /api/files/download-plan
  {nodeIds}` membuka folder seperti arsip (`collectFiles`) dan memberi link `/d/` bertanda tangan per file (izin
  `view` per item, maks `download_plan_max_items` = 5.000, file yang belum siap dihitung `skipped`). Antrean unduhan
  (`download/manager.ts`) mengambil N file sekaligus dengan `fetch` + Range: jeda/lanjut dari byte terakhir, coba ulang
  dengan backoff (maks 5), menunggu jaringan, link baru lewat `/api/files/:id/download` kalau yang lama kedaluwarsa
  (410/403), mulai dari awal kalau server mengabaikan Range, ukuran akhir dicek.
- **Ke mana byte-nya**: (1) penyimpanan privat browser (OPFS), lalu file jadi diserahkan ke folder Unduhan lewat blob
  URL dan dihapus dari OPFS 15 menit kemudian (sisa tab yang tertutup dibersihkan saat app dibuka lagi); (2) **folder
  pilihan** di perangkat (File System Access API, Chrome/Edge desktop) dengan struktur folder ikut, nama aman untuk
  semua sistem, tidak pernah menimpa ("a (1).jpg"); (3) kalau OPFS tidak ada atau ruangnya kurang, file diserahkan
  ke unduhan browser sendiri, berjeda 400 ms. Satu file tetap langsung ke browser seperti dulu (IDM/aria2 tetap jalan).
- Panel transfer di kanan bawah sekarang punya tab Upload/Unduh, progres dan kecepatan total, ⋮ (jeda/lanjut/batal
  semua, atur jumlah bersamaan). Selama ada transfer: menutup tab ditanya dulu, dan layar dijaga menyala (wake lock,
  bisa dimatikan) karena HP menghentikan tab yang tidur.
- Tidak ada pembatasan kecepatan buatan dari server (SPEC §5.1 tetap): yang diatur hanya berapa yang berjalan bersamaan.

**Konsekuensi:** unduhan lewat OPFS butuh ruang dua kali ukuran file sebentar. Safari lama tanpa
`createWritable` memakai jalur (3). Test: `tests/unit/transfer.test.ts` (batas 20, preset, saran koneksi, antrean:
batas bersamaan dan perubahannya, Range setelah putus, link kedaluwarsa, server tanpa Range, offline, coba ulang,
jeda/lanjut/batal, serah ke browser), `tests/integration/download.test.ts` (plan, link per file, akses orang lain,
batas jumlah).

## ADR-054 — Share: daftar file untuk folder, QR lengkap, dan kelola link

**Status:** diterima (pemilik, 2026-10-26, permintaan yang sama dengan ADR-053: "share … lebih robust dan punya
banyak fitur"). **Konteks:** link folder/beberapa file langsung mengunduh ZIP (SPEC §6.1); penerima yang hanya
butuh satu file harus mengunduh semuanya. Password tidak bisa dihapus dari app, judul tidak bisa diganti, QR hanya
gambar (SPEC §6.2 minta unduh PNG/SVG, salin, layar penuh), dan Dibagikan hanya bisa salin/cabut.

**Keputusan:**
- **"Tampilkan daftar file dulu"** per link (`shares.show_listing`, migrasi `0009`), hanya untuk folder dan
  bundle; link satu file tetap langsung mengunduh. Default mati, jadi perilaku SPEC §6.1 tidak berubah untuk link
  lama maupun baru. Kalau nyala, link membuka halaman kecil (Worker, tanpa skrip, dua bahasa) berisi file yang siap
  (maks 500 baris; sisanya lewat ZIP) dengan path foldernya, tombol "Unduh semua (ZIP)" (`?all=1`, ZIP yang sama
  seperti dulu, Range tetap jalan), dan link per file `/{r64}/{s32}/f/{nodeId}/{nama}`.
- Link per file melewati gerbang yang sama dengan link utamanya (`openShare`): tanda tangan dicek sebelum D1, rate
  limit, status link (dicabut/kedaluwarsa/batas/nonaktif), bot pratinjau dapat Open Graph. File harus ada di isi
  share **saat itu** (folder = isi live, `collectFiles`), siap, dan tidak dikarantina; node lain milik pemilik yang
  sama ditolak 404. Password: tanpa cookie password, diarahkan (303) ke halaman password link utamanya; cookie-nya
  berlingkup `/{r64}/`, jadi berlaku untuk file-file itu juga. Mematikan daftar langsung mematikan link per file.
- Hitungan unduhan: melihat daftar tidak dihitung; unduhan per file dihitung seperti biasa (tanpa Range atau mulai
  byte 0, sekali per IP+UA dalam jendela dedupe), jadi `download_count` = jumlah pengunjung yang mengunduh, dan
  `max_downloads` tetap berlaku.
- **Pengaturan link** (`ShareSettings`, dipakai dialog Bagikan dan Dibagikan): judul, berlaku, batas unduhan,
  password baru atau **hapus password**, daftar file, buat ulang link (pengaturannya ikut, termasuk daftar file),
  cabut.
- **QR** (`ShareQr`): koreksi galat H, unduh PNG (720 px) dan SVG, salin gambar (Clipboard API), dan layar penuh
  berlatar putih sebagai `<dialog>` modal sendiri (supaya berada di atas dialog Bagikan). Logo di tengah belum.
- **Dibagikan**: cari judul, QR, atur link, "terakhir diunduh", tanda password dan daftar file; teks "Tampilkan link
  lama" sekarang dua bahasa.

**Konsekuensi:** test `tests/integration/shares.test.ts` (daftar, unduh per file + hitungan, node di luar share,
ZIP `?all=1`, mati → ZIP lagi, password di depan file, satu file tidak pernah didaftar, buat ulang menyimpan
pengaturan).

## ADR-055 — Zeiko S3: CORS per bucket dan isi bucket di halaman /s3

**Status:** diterima (pemilik, 2026-10-26, permintaan yang sama dengan ADR-053: "S3 … lebih robust dan punya banyak
fitur"). **Konteks:** CORS menjawab `NotImplemented` (ADR-044), jadi aplikasi web di situs lain tidak bisa memakai
bucket (presigned URL dari browser butuh CORS). Halaman `/s3` hanya mengatur key dan bucket; melihat, mengunggah,
atau membagikan satu objek harus lewat aws-cli/rclone.

**Keputusan:**
- **CORS sungguhan** (`services/s3-cors.ts`, kolom `s3_buckets.cors_json`, migrasi `0010`): PutBucketCors (XML
  `CORSConfiguration`, maks 100 aturan, metode GET/PUT/POST/DELETE/HEAD, satu `*` per origin/header,
  `MaxAgeSeconds` ≥ 0; salah = `MalformedXML`/`InvalidRequest`), GetBucketCors (`NoSuchCORSConfiguration` 404 kalau
  belum ada), DeleteBucketCors. Hanya pemilik bucket. `cors` tidak lagi di daftar sub-resource `NotImplemented`.
- **Preflight** `OPTIONS` (tanpa tanda tangan, seperti Amazon): aturan pertama yang cocok dengan Origin, metode, dan
  semua `Access-Control-Request-Headers` (header tanpa beda huruf besar/kecil; origin persis) → 200 dengan
  `Allow-Origin` (origin itu, atau `*` kalau aturannya `*`, tanpa credentials), `Allow-Methods`, `Allow-Headers`,
  `Max-Age`, `Vary`. Tidak ada aturan/tidak cocok → 403 `CORSResponse`. Request biasa yang membawa Origin mendapat
  header CORS dari aturan yang cocok (origin + metode), **termasuk respons error**, supaya aplikasi bisa membaca
  pesan error-nya. Di alamat sendiri (ADR-048) hanya bucket pemilik alamat itu.
- **Isi bucket di `/s3`** (`S3Browser.tsx`, API sesi Drive `/api/s3/buckets/:name/…`, `services/s3-browse.ts`):
  - `GET objects?prefix&cursor`: satu tingkat folder (delimiter `/`), 200 per halaman, "Muat lagi".
  - `PUT objects?key` (body = file, `x-object-content-type`): satu request per file lewat app, maks
    `s3_web_upload_max_bytes` (95 MiB, di bawah batas body Workers 100 MB); lebih besar → pakai aws-cli/rclone
    (multipart). Upload berjalan sebanyak "upload bersamaan" perangkat itu (ADR-053). Folder baru = objek 0 byte
    berakhiran `/` (tidak ditampilkan sebagai file).
  - `POST objects/link {key, expiresInSeconds, download}`: **presigned URL biasa** (`presignUrl`, SigV4 query, host
    ditandatangani, `UNSIGNED-PAYLOAD`), ditandatangani dengan access key terbaru akun itu yang belum dicabut, maks
    `s3_link_max_seconds` (7 hari, batas S3). Mencabut key itu mematikan link-nya, dan halaman mengatakannya. Tanpa
    key → 409 `s3_no_key` dengan pesan "buat access key dulu". Ini bukan presigned URL **R2** (larangan CLAUDE.md
    tetap): URL-nya ke host Zeiko S3 dan dicek Worker seperti request S3 lain (egress dihitung, objek yang belum
    lolos scan tetap hanya untuk pemilik).
  - `POST objects/delete {keys ≤ 1000}`.
  - `GET|PUT|DELETE cors`: editor satu aturan (origin per baris, metode, header, expose, max age); aturan lebih dari
    satu tetap bisa lewat S3 API, dan halaman memberi tahu kalau menyimpan akan menggantinya.
  - Unduh banyak objek: link presigned per objek diserahkan ke unduhan browser satu per satu lewat antrean unduhan
    (ADR-053, tanpa OPFS karena host S3 beda origin dan tidak memberi app CORS diam-diam).
  - Tagihan (ADR-047): `locked` menolak semuanya, `readonly` menolak upload. Semua di-scope ke pemilik bucket dan
    masuk suite IDOR.

**Konsekuensi:** satu baca D1 tambahan untuk request S3 yang membawa header Origin (hanya browser). Test:
`tests/integration/s3-cors-browse.test.ts` (AWS SDK Put/Get/DeleteBucketCors, preflight cocok/tidak, wildcard,
header CORS di error, aturan salah, bucket orang lain; daftar per folder, upload lewat app + dibaca SDK, folder kosong,
link presigned yang jalan tanpa sesi, hapus, tanpa key, batas ukuran; presign dicek `verifySignature` + kedaluwarsa),
`tests/integration/idor.test.ts`.

## ADR-056 — Perbaikan audit OWASP Top 10:2025: faktor kedua staf, laporan CSAM, guard batch
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: "kerjakan semua OWASP"); bagian faktor kedua staf,
status/hierarki staf, dan `sessions.second_factor_at` digantikan ADR-057 (tidak ada staf lagi di Drive). **Konteks:** audit statis OWASP
Top 10:2025 atas seluruh repo menemukan tujuh hal (ringkasan di `docs/SECURITY.md`). Yang paling berat: laporan
kategori CSAM dari siapa pun langsung membekukan akun pengunggah, sesuai SPEC §14.3 lama; dan "wajib passkey/TOTP"
untuk staf hanya memeriksa bahwa faktor itu terpasang, tidak pernah memintanya.

**Keputusan:**
- **Faktor kedua dibuktikan per sesi** (`src/worker/auth-second-factor.ts`). Kolom `sessions.second_factor_at`
  (migrasi `0011`) diisi saat sesi itu membuktikan TOTP (`POST /api/auth/second-factor/totp`) atau passkey
  (`/second-factor/passkey/options` + `/verify`, `@simplewebauthn/server`, challenge di `verifications` 5 menit, kunci
  harus milik user sesi itu). `requireStaff` meminta: akun `active`, peran cocok, faktor terpasang
  (`ADMIN_2FA_REQUIRED`), dan bukti yang belum lewat `staff_second_factor_hours` (config, default 12 jam;
  `SECOND_FACTOR_REQUIRED`). Login baru lewat Akun Zeiko selalu mulai tanpa bukti. 5 kode TOTP salah berturut-turut →
  istirahat 15 menit; rate limit `RL_AUTH` per user. Passkey tetap bukan faktor pertama (ADR-036).
- **Mengubah faktor butuh faktor:** begitu akun punya TOTP atau passkey, rute Better Auth untuk menambah, melihat,
  atau menghapus faktor (`/passkey/*register*`, `/passkey/delete-passkey`, `/two-factor/enable|disable|…`) meminta
  bukti yang sama. Faktor pertama tetap bebas dipasang (tidak ada yang bisa dibuktikan). Perubahan faktor akun staf
  dicatat di log dan dikirim sebagai `admin_alert`. UI: `components/SecondFactorPrompt.tsx` di Admin dan Pengaturan.
- **Status dan hierarki:** akun staf yang dibekukan tidak lagi bisa membuka rute admin walau login ulang. Moderator
  hanya boleh membekukan akun biasa; akun staf hanya oleh admin (`assertMaySuspend`, juga untuk aksi
  `ban_uploader`).
- **Laporan CSAM** (SPEC §14.3 diubah): hanya isi yang langsung dimatikan (link mati, karantina, legal hold), dan
  hanya bila pelapornya login atau lolos Turnstile. Pembekuan akun adalah keputusan moderator. Laporan anonim tanpa
  Turnstile tetap masuk antrean mendesak dan alert, tanpa aksi otomatis. Tanda di link dan blob memuat ID laporan
  (`abuse:<id>`), sehingga **menolak** laporan memulihkan link, karantina, dan legal hold yang dipasang laporan itu
  saja. `verifyTurnstile` sekarang mengembalikan apakah manusia benar-benar dicek (tanpa secret = tidak).
- **Guard batch D1** (`lib/batch-guard.ts`, tabel `batch_guards` dengan `CHECK (ok = 1)`): pernyataan yang
  membatalkan seluruh batch bila syaratnya tidak lagi benar saat batch jalan. Dipakai saat menerima undangan
  keluarga: undangan yang sama tidak bisa dipakai dua orang sekaligus, dan anggota tidak melewati `max_members`.
- **Redirect `/dashboard/…`** hanya ke path app sendiri (garis miring/backslash di depan dibuang).
- **Label pindai:** `capabilities.antivirus` (scanner bukan mock). Tanpa ClamAV, status `clean` ditampilkan
  "Dicek dasar (belum dengan antivirus)", bukan "Aman". Kesiapan baru di tab Features relay: `antivirus` (butuh
  Containers) dan `captcha` (Turnstile: site key di `deploy/<env>.json` → `turnstileSiteKey`, secret
  `TURNSTILE_SECRET_KEY`).

**Tidak dikerjakan:** kode cadangan TOTP sebagai bukti (staf yang kehilangan HP dipulihkan operator lewat ops API);
pemakaian ulang kode TOTP yang sama dalam 30 detik; memisahkan `ZEIKO_OPS_TOKEN` jadi bearer dan kunci callback
(butuh perubahan di relay); panjang minimum password link share.

**Konsekuensi:** staf mengetik kode atau memakai passkey sekali per 12 jam per sesi. Test:
`tests/integration/auth.test.ts` (passkey sungguhan dengan kunci ES256 software `tests/helpers/webauthn.ts`,
challenge/kunci salah, TOTP benar/salah/terkunci/kedaluwarsa, login baru, ubah faktor, staf dibekukan, moderator vs
admin), `admin.test.ts` (laporan CSAM dari user login/anonim, tolak laporan), `family.test.ts` (undangan direbut di
tengah jalan), `app.test.ts` (redirect), `readiness.test.ts`.

## ADR-057 — Tidak ada panel admin di Drive: semua kerja operator di relay
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: "Bukannya semua yang berhubungan dengan admin termasuk owner
itu di Relay semua ya? … Pindah semua ke relay"). Menggantikan bagian ADR-056 tentang faktor kedua staf,
status/hierarki staf, dan `assertMaySuspend`; menggantikan "Admin → Iklan" di ADR-043; SPEC §13.1 diubah.

**Konteks:** akun, uang, katalog, angka bisnis, dan People sudah di relay (ADR-036, ADR-040). Yang tersisa di `/admin`
Drive hanya laporan/takedown, iklan, pemindai, dan audit log, dijaga role admin/moderator + passkey/TOTP. Itu berarti
dua pintu operator dengan dua cara login, dan sebuah panel di domain publik yang berjarak satu sesi curian dari setiap
akun. Pemiliknya satu orang, dan ia bekerja dari relay.

**Keputusan:**
- **Ops API mendapat sisanya** (`routes/ops.ts`, bearer `ZEIKO_OPS_TOKEN`, aktor `relay-operator`): `GET /reports`,
  `GET /reports/:id`, `POST /reports/:id/actions {actions, note}`, `POST /reports/:id/preview {nodeId}`,
  `GET /scanner`, `POST /scanner/:blobId/retry`, `GET /ads?status=`, `GET /ads/areas?q=`, `GET|PUT /ads/advertiser`,
  `POST /ads/creatives`, `PATCH /ads/creatives/:id`, `PUT /ads/creatives/:id/image`, `GET /ads/:id/image`,
  `POST /ads/:id/review|suspend`, `GET|POST /ads/campaigns`, `POST /ads/campaigns/:id/send-payment|cancel`. Audit log
  sudah ada (`GET /audit`). Relay hanya meneruskan JSON, jadi gambar iklan lewat **base64**: masuk
  `{advertiserId, imageBase64}`, keluar `{dataUrl}`. Batas ukuran tetap `ad_image_max_bytes` (dicek setelah decode).
- **Layar Zeiko Drive di relay** mendapat tab Reports, Ads, Scanner, dan Audit (repo relay, `zeikodrive.js`), dan
  forwarder relay perlu batas body ≥ 1 MiB untuk gambar iklan base64. Belum dikerjakan saat ADR ini ditulis: Drive
  ini tidak di-deploy sebelum tab Reports ada.
- **Dihapus dari Drive:** `/api/admin`, halaman `/admin` dan `AdminAds`, link Admin di menu, `requireStaff`,
  `auth-second-factor.ts`, `SecondFactorPrompt`, `TotpSetup`, bagian Keamanan di Pengaturan, plugin Better Auth passkey
  dan twoFactor beserta paketnya (`@better-auth/passkey`, `@simplewebauthn/*`), `setUserRole`, `assertMaySuspend`,
  config `staff_second_factor_hours`. Passkey dan TOTP di Drive hanya pernah menjadi faktor kedua staf (ADR-019,
  ADR-036): tanpa staf, keduanya tidak melindungi apa pun, jadi tidak ditampilkan lagi.
- **Tabel dan kolom lama tetap ada** (migrasi append-only): `users.role`, `users.two_factor_enabled`, `passkeys`,
  `two_factors` tidak dibaca lagi; hapus akun tetap membersihkan `passkeys`. `/api/me` tidak lagi mengirim `role`,
  `twoFactorEnabled`, atau `hasPasskey`.
- **Kolom pelaku yang menunjuk `users`:** operator bukan user Drive. `abuse_reports.resolved_by` dan
  `ad_creatives.reviewed_by` dibiarkan `NULL`; siapa yang bertindak ada di audit log. `legal_holds.created_by` kehilangan
  foreign key-nya dan berisi `relay-operator` atau `auto` (migrasi `0011`, yang belum pernah dijalankan di remote, jadi
  masih boleh diubah: kolom `sessions.second_factor_at` dari ADR-056 dikeluarkan lagi, `batch_guards` tetap).
- **Pratinjau konten laporan** (SPEC §13.1: tidak ada tombol "lihat file user"): token `a` sekarang membawa ID
  **laporan** di tempat ID user (formatnya tetap ULID), dan `/p/` hanya membukanya selama laporan itu ada. Tetap
  5 menit, tetap tercatat `report.content_view` dengan aktor `relay-operator`.
- **Akun demo** `admin@zeiko.local` menjadi `max@zeiko.local` (paket Max, tanpa peran).

**Konsekuensi:** satu pintu operator, yaitu relay dengan sandi, passkey, dan gerbangnya sendiri. Selama HP relay mati,
tidak ada takedown dari mana pun; pelaporan dan aksi otomatis CSAM (link mati, karantina, legal hold dari pelapor yang
login atau lolos Turnstile) tetap jalan di Drive, dan `admin_alert` tetap dikirim ke email operator. Moderator kedua
tidak bisa ditambahkan tanpa akses ke relay. Test: `tests/integration/takedown.test.ts` (dulu `admin.test.ts`: tidak ada
`/api/admin` walau akun lama masih ber-role, laporan lewat ops, legal hold atas nama operator, token review palsu),
`ads.test.ts` dan `idor.test.ts` (operator lewat ops, gambar base64, sesi biasa tidak bisa membuka `/api/ops`),
`ops.test.ts` (pemindai), `auth.test.ts` (tidak ada rute passkey/TOTP/second-factor).

## ADR-058 — Dekorasi folder: warna, ikon, gambar sampul
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap D5).

**Keputusan:**
- Kolom baru di `nodes` (migrasi `0012`): `decor_color` (12 warna tetap di `src/shared/folder-decor.ts`, tiap warna punya
  shade terang dan gelap), `decor_icon` (24 ikon lucide atau tepat satu emoji, dicek dengan `Intl.Segmenter`),
  `decor_cover_id` (node file; tanpa foreign key supaya gambar bisa dihapus).
- `POST /api/nodes/decor {ids ≤ 100, color?, icon?, coverId?}`: bagian yang tidak dikirim tetap, `null` menghapus. Butuh
  izin edit di setiap folder; bukan folder root dan bukan folder di Sampah.
- **Sampul hanya dari space yang sama** (Drive Keluarga yang sama, atau Drive Saya pemilik yang sama), harus gambar
  `ready` yang punya thumbnail dan tidak dikarantina. Di setiap daftar, `decor.coverId` dihitung ulang di SQL
  (`COVER_SQL`): kalau gambar dipindah ke space lain, masuk Sampah, dihapus, atau dikarantina, nilainya `null` dan folder
  kembali ke ikon dan warna. Akses di satu space itu semua-atau-tidak (`access.ts`), jadi "satu space" sama dengan "boleh
  melihat". Thumbnail tetap dicek sendiri oleh `GET /api/files/:id/thumbnail`. Gambar tanpa thumbnail dibuatkan di
  browser saat dipilih (`makeAndUploadThumb`).
- Tampil di daftar/grid explorer, Sampah/Detail (lewat `FileIcon`), breadcrumb (ikon dan warna, desktop), dialog
  Pindahkan, hasil cari, dan banner tipis saat folder dibuka (sampul, atau pita warna dan ikon). Halaman share publik
  hanya menampilkan warna dan ikon (SVG lucide dari `lib/folder-icons.ts`), tidak pernah sampul.
- Ekspor data memuat tiga kolom dekorasi.

**Konsekuensi:** satu subquery per baris folder yang punya sampul. Test: `tests/integration/decor.test.ts`,
`tests/unit/folder-decor.test.ts`, `shares.test.ts` (badge share), `idor.test.ts`.


## ADR-059 — Logo Zeiko di tengah QR share
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap D15, "lanjut all in 12 fitur").

**Keputusan:**
- Satu rencana QR di `src/shared/qr.ts` (`qrPlan`): error correction H, quiet zone 2 modul, dan petak putih di tengah
  (sisi ganjil, ≤ 9% luas modul) tempat tanda Z Zeiko (kotak indigo `#4338ca` + Z putih, sama dengan favicon). Dari
  rencana yang sama keluar SVG (`qrSvg`, unduhan SVG) dan piksel RGBA (`qrRaster`, gambar di layar, unduhan PNG, salin
  gambar, layar penuh). Yang dites = yang diunduh orang.
- **9%, bukan 20%:** dengan petak 12–16% beberapa versi QR (13, 18) sudah tidak terbaca decoder (`jsqr`). Di 9%
  setiap panjang link 20–600 karakter terbaca (dicek satu per satu saat menyetel; test memakai beberapa panjang tetap).
- QR undangan keluarga ikut memakai logo (`src/web/lib/qr.ts`). **QRIS pembayaran iklan (`lib/qr-png.ts`) tetap tanpa
  logo**: kode bayar tidak diubah-ubah.

**Konsekuensi:** paket `qrcode` tetap dipakai untuk matriksnya; `jsqr` hanya devDependency untuk test
(`tests/unit/qr.test.ts`).

## ADR-060 — Zeiko S3: statistik per bucket dan log akses
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap S9).

**Keputusan:**
- **Tabel harian di D1, bukan Analytics Engine.** Membaca Analytics Engine dari Worker butuh API token akun lewat SQL API
  (secret baru dari pemilik), sedangkan D1 sudah ada. Satu UPSERT per request S3 ke `s3_bucket_days` (user, bucket,
  hari WIB: request, error, byte masuk, byte keluar), di **index D1 akun itu sendiri** (`MIGRATIONS` v3 di
  `s3-index.ts`), lewat `waitUntil` setelah respons. Akun yang punya index sendiri tidak memakai jatah tulis D1 utama.
  Workers Free membatasi 100 ribu baris tulis/hari per akun Cloudflare: kalau S3 ramai, index per akun dan Workers Paid
  yang jadi jalan keluarnya. Analytics Engine (`s3_request`) tetap ditulis untuk operator.
- Yang dihitung: request S3 API yang bucket-nya sudah diketahui dan boleh dialamatkan (pemilik, atau anonim ke bucket
  itu), termasuk yang gagal; link `/s3` (presigned) ikut, aksi halaman `/s3` yang lewat API app tidak. Byte keluar hanya
  untuk respons < 300. CreateBucket tidak dihitung (bucket belum ada), DeleteBucket yang berhasil tidak menulis baris.
- Jumlah objek dan byte dihitung dari index saat dialog Statistik dibuka (`COUNT`/`SUM` per bucket), tidak disimpan.
- **Log akses** (`PutBucketLogging`/`GetBucketLogging`, juga dari `/s3`): `s3_buckets.logging_json` (migrasi `0013`).
  Target harus bucket milik akun yang sama (`InvalidTargetBucketForLogging`); grant dan partitioned prefix →
  NotImplemented. Baris berformat server access log Amazon menunggu di `s3_log_lines` (index akun), lalu cron per jam
  (`deliverS3Logs`, maks `s3_log_buckets_per_run` bucket, `s3_log_lines_per_object` baris per objek) menulisnya sebagai
  objek `{prefix}YYYY-MM-DD-HH-MM-SS-{16 hex}` lewat `putObject` biasa (kuota, replika, scan). Akun yang tidak bisa menulis
  menyimpan barisnya sampai `s3_log_pending_days`. Target dihapus/pindah tangan → logging mati, baris dibuang.
- **IP tidak pernah mentah di log:** Kebijakan Privasi mengizinkan Zeiko mencatat IP, bukan memberikannya ke pemilik
  bucket. Kolom remote IP = `hashIp` dengan garam per pemilik per hari WIB. Signature presigned URL di request URI diganti
  `REDACTED`.
- Retensi: `s3_bucket_days` > `s3_stats_keep_days` dan baris log > `s3_log_pending_days` dibersihkan bersama rekonsiliasi
  malam per akun. Ekspor data memuat `cors_json`, `logging_json`, dan semua baris harian; hapus akun membersihkan keduanya.

**Konsekuensi:** satu tulis D1 per request S3 (dua kalau bucket mencatat log). Test: `tests/integration/s3-stats.test.ts`,
`idor.test.ts`.

## ADR-061 — Token akses untuk API publik (fondasi A2–A6, D9)
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap A1, "pick acak 3 API").

**Keputusan:**
- Tabel `api_tokens` (migrasi `0014`). Token = `zkd_` + id publik 8 karakter + rahasia 32 karakter (base62). Yang disimpan:
  `prefix` (`zkd_` + id, unik, tampil di daftar) dan SHA-256 seluruh token. Rahasia ditampilkan sekali saat dibuat.
  Baris dicari lewat prefix, hash dibandingkan dengan `timingSafeEqual` (juga saat prefix tidak ditemukan, supaya
  waktunya sama). Token salah, rusak, kedaluwarsa, dan dicabut semuanya 401 yang sama.
- Scope: `drive.read`, `drive.write`, `share`, `webdav`, `s3.manage`; dicek per route (`scope()` di
  `middleware/token.ts`). `kind`: `personal` (dibuat di Pengaturan) dan nanti `oauth_access`/`oauth_refresh` (A3).
- **Token hanya untuk `/api/v1/*`** (dan host WebDAV nanti). `/api/*` tetap cookie + Origin + CSRF; Bearer di sana
  dijawab 401 `token_not_accepted_here`. Token tidak bisa membuat atau melihat token (route `/api/tokens` cookie saja),
  dan tidak pernah membuka ops (bearer ops terpisah, ADR-057). `/api/v1` dipasang sebelum `/api` dengan 404 sendiri.
- Rate limit per token: binding baru `RL_API` (300/menit). `last_used_at` ditulis paling sering 5 menit sekali.
  Batas token aktif per user: `api_tokens_max_per_user` (20).
- Akun dibekukan/dihapus → 403 `ACCOUNT_SUSPENDED`; penghapusan akun menghapus semua barisnya. Ekspor data memuat
  nama, prefix, scope, dan tanggal (tidak pernah hash).
- **Hubungan dengan ADR-039:** keluar dari Akun Zeiko (sesi pintu) **tidak** mencabut token. Token dipakai skrip dan
  aplikasi yang berjalan tanpa browser, sama seperti personal access token di layanan lain; kalau ikut mati setiap
  logout, backup otomatis akan berhenti diam-diam. Pengaturan menulis ini terang-terangan dan token bisa dicabut di sana.
  Kalau pemilik ingin sebaliknya, cukup cabut token di jalur logout pintu.
- CORS untuk `/api/v1` dari situs lain belum dibuka (A2/A4 memutuskan).

**Konsekuensi:** satu baca D1 per request v1 (plus tulis paling sering 5 menit sekali). Test:
`tests/integration/tokens.test.ts`, `idor.test.ts`.

## ADR-062 — API publik v1 dan OpenAPI
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap A2, "pick acak 3 API").

**Keputusan:**
- `/api/v1` terpisah dari `/api` internal (yang boleh berubah kapan saja). **Aturan versi:** field baru di respons boleh
  ditambah; menghapus/mengganti arti field, mengubah tipe, atau mewajibkan input baru → `/api/v2`.
- **Satu daftar endpoint** (`ENDPOINTS` di `routes/v1.ts`, tipe `Endpoint` di `lib/openapi.ts`): method, path, scope,
  skema zod untuk path/query/body/respons, dan tanda `idempotent`. Router Hono dan `/api/v1/openapi.json` (OpenAPI 3.1
  dari `z.toJSONSchema`, tanpa token) dibangun dari daftar yang sama. Test gagal kalau router punya route yang tidak ada di
  daftar, atau respons tidak cocok dengan skemanya. Skema respons `strictObject`: field baru di service harus ditulis juga
  di `v1-schemas.ts`.
- Isi awal: akun (`/me`, `/account`: profil, kuota, paket); Drive (detail node + breadcrumb, isi folder dengan cursor,
  cari, URL unduh bertanda tangan absolut, Sampah, buat folder, ganti nama, pindah, salin, ke Sampah/pulihkan); upload
  multipart (init/part/status/complete/abort, protokol yang sama dengan app); link share (daftar/buat/cabut); Zeiko S3
  dengan `s3.manage` (ringkasan akun, key buat/cabut, bucket buat/publik/CORS/hapus). Key S3 berizin terbatas (S1) dan
  lifecycle (S3) menyusul saat fitur itu ada. Route tetap tipis: service yang sama dengan app, termasuk `requireNode`.
- Error = `{ error: { code, message, data } }` dari `lib/errors.ts`. Scope kurang → 403 `missing_scope` (dicek sebelum
  validasi input).
- **Idempotency-Key** (POST yang membuat sesuatu: folder, salin, upload, share, key S3, bucket): tabel `api_idempotency`
  (migrasi `0015`), per token + key, 24 jam. Request sama → jawaban pertama + `Idempotent-Replayed: true`; key sama dengan
  request lain → 409 `idempotency_key_reused`; masih berjalan → 409 `idempotency_in_progress`. Hanya jawaban sukses yang
  disimpan, jadi percobaan yang gagal boleh diulang. Dibersihkan cron malam.
- **Rate limit:** 300 request/menit per token (`RL_API`), ditambah batas upload/share yang sama dengan app. Header
  `X-RateLimit-Limit` dan `RateLimit-Policy`; **sisa kuota tidak dikirim**: binding rate limit Cloudflare tidak
  melaporkannya, dan menghitung sendiri berarti satu tulis KV/D1 per request (Workers Free: KV 1.000 tulis/hari).
  300/menit per token masuk akal di Workers Free (100 ribu request/hari per akun Cloudflare): satu skrip tidak bisa
  menghabiskan jatah harian dalam sejam tanpa terlihat di log.
- Dokumentasi ringan di app: `/developer` (dibangun dari `openapi.json`, tanpa skrip CDN), ditautkan dari Pengaturan →
  Token & aplikasi. Teks halaman dua bahasa; ringkasan per operasi berbahasa Inggris seperti dokumen API-nya.
- CORS untuk `/api/v1` dari situs lain belum dibuka (A4 memutuskan kalau SDK dipakai di browser).

**Konsekuensi:** `services/s3-app.ts` (error S3 → error app, akun aktif) dipakai `/api/s3` dan v1. Test:
`tests/integration/api-v1.test.ts` (dokumen, kontrak, pagination, idempotency, scope per endpoint, IDOR, S3).

## ADR-063 — Login aplikasi Zeiko: OAuth 2.0 + PKCE
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik: roadmap A3, "pick acak 3 API").

**Keputusan:**
- Drive menjadi authorization server untuk **aplikasi pihak pertama saja**, ditetapkan di kode (`OAUTH_CLIENTS` di
  `services/oauth.ts`, bukan tabel): `zeiko-android` (App Links `https://<APP_ORIGIN>/app/callback` dan skema sendiri
  `id.biz.zeiko.drive:/oauth/callback`), `zeiko-desktop` dan `zeiko-cli` (loopback `http://127.0.0.1` atau `[::1]`, port
  bebas, path `/callback`, RFC 8252 §7.3). Redirect URI dicocokkan persis; `localhost` tidak diterima (RFC 8252 §8.3).
- **Persetujuan** di SPA `/oauth/authorize` dengan sesi Drive biasa (login lewat pintu seperti sekarang; relay tidak
  berubah; `next` di `/masuk` sekarang boleh membawa query). API-nya cookie: `GET/POST /api/oauth/authorize`. Klien atau
  redirect yang salah ditampilkan sebagai error di halaman, tidak pernah diarahkan. PKCE `S256` dan `state` wajib;
  scope ⊆ scope klien. Tolak → `error=access_denied`.
- **Code**: 43 karakter acak, disimpan hash, 60 detik (`oauth_code_ttl_seconds`), sekali pakai. Klaim code dan pembuatan
  grant dalam satu batch D1 (`changes() = 1`), jadi dua penukaran bersamaan hanya satu yang menang. Code dipakai ulang →
  semua yang dibuat penukaran pertama dicabut.
- **Token** memakai tabel A1: access `zkd_…` (`oauth_access`, 1 jam, `oauth_access_ttl_seconds`), refresh `zkr_…`
  (`oauth_refresh`, 90 hari, `oauth_refresh_ttl_days`, tidak pernah diterima sebagai Bearer). Keduanya membawa
  `grant_id` (tabel `oauth_grants`, migrasi `0016`). Setiap refresh memberi pasangan baru dan mematikan refresh lama;
  **refresh lama dipakai lagi → seluruh grant dan tokennya dicabut** (ada yang menyalin). `POST /api/v1/oauth/token`
  (form atau JSON, error `{error, error_description}` RFC 6749, `Cache-Control: no-store`, rate limit `RL_AUTH` per IP) dan
  `POST /api/v1/oauth/revoke` (RFC 7009: access token mati sendiri, refresh token memutus grant) ada di daftar endpoint
  v1 sebagai endpoint publik.
- Pengaturan → Token & aplikasi: "Aplikasi tersambung" (scope, tersambung, terakhir dipakai, Putuskan). Ekspor data
  memuat grant; hapus akun menghapus grant, code, dan token.
- `/.well-known/assetlinks.json` dari `ANDROID_APP_PACKAGE` + `ANDROID_CERT_SHA256` (`deploy/<env>.json` →
  `androidPackage`, `androidCertSha256`); 404 sampai diisi. Terdaftar di readiness (`app_links`); sampai siap, aplikasi
  Android memakai skema sendiri.
- **Ditunda:** device flow (RFC 8628) untuk CLI/TV: CLI memakai loopback dulu. **Langkah berikutnya:** aplikasi pihak
  ketiga (pendaftaran klien, review, halaman developer, klien rahasia) belum didukung.

**Konsekuensi:** test `tests/integration/oauth.test.ts` (alur PKCE, redirect/klien/scope salah, code dua kali,
kedaluwarsa, rotasi + deteksi pemakaian ulang, revoke, putuskan dari Pengaturan, assetlinks).

## ADR-064 — Drive tanpa D1: satu index per user (dan per keluarga) di R2
**Tanggal:** 2026-10-26 · **Status:** diterima sebagai arah (pemilik); pertanyaan R0 dijawab 2026-10-26 (kecuali no. 3,
lihat di bawah); implementasi mulai di R1. Menggantikan ADR-002 ("Index D1 sebagai sumber kebenaran"). Bagian bertanda
*usul* menunggu konfirmasi pemilik.

**Konteks.** Diagram pemilik (`Zeiko drive x Zeiko S3`): Drive = "1 folder, 1 index.txt di satu R2"; S3 = "1 user, 1 D1
pengganti index.txt". Sejak ADR-002 Drive justru menyimpan pohon file di D1 bersama (`nodes`, `blobs`, …), dan cadangan
`u/{userId}/index.json` yang dijanjikan SPEC tidak pernah dibuat (hanya penanda `manifest_dirty` yang ditulis). Pemilik
(2026-10-26): D1 bersama mahal dan membengkak kalau user banyak; Drive harus seperti diagram.

**Keputusan pemilik:**
1. Satu user = satu folder R2 (`u/{userId}/`), berisi file-filenya dan **satu index** untuk akun itu: nama file dan
   struktur folder. Tidak lebih.
2. Satu index per user/akun (seluruh pohon dalam satu objek).
3. Paket keluarga: satu folder keluarga, satu index (`f/{familyId}/`): nama file, struktur folder, dan kepemilikan.
4. Dua penulisan bersamaan tidak boleh saling menimpa: tulis index dengan syarat versi R2 (etag); kalau bentrok, baca
   ulang dan ulangi.
5. Index adalah hal pertama yang ditarik web, aplikasi, dan software sebelum apa pun dimuat: formatnya harus seringan dan
   secepat mungkin.
6. **Drive tidak memakai D1.** D1 hanya untuk Zeiko S3 (yang tetap seperti ADR-044: 1 user, 1 D1 pengganti index.txt).
   Akun, paket, dan pembayaran ditangani relay. *Pengecualian (jawaban R0 no. 1):* satu **D1 khusus akses**, terpisah
   dari D1 S3, hanya untuk sesi login, token API/OAuth, dan link share. Tidak ada pohon file, nama file, atau data akun
   di sana.
7. S3 tidak berubah.

**Jawaban R0 (pemilik, 2026-10-26):**
1. Link share, token API (A1–A3), dan sesi login: **D1 khusus** untuk itu ("better handling pakai D1 daripada R2").
   Satu database D1 baru yang terpisah dari D1 S3 (usul nama `zeiko-access`, binding `ACCESS_DB`), dipakai bersama semua
   user; isinya tabel sesi, `api_tokens`, `oauth_grants`, `oauth_codes`, `api_idempotency`, `shares`, `share_items`,
   `share_sends`. Pindahnya di R5 (share) dan R6 (sesi/token/OAuth).
2. Data operator (laporan & takedown, legal hold, blocklist hash, audit, iklan): **relay**.
3. Notifikasi (lonceng + email), preferensi email per jenis, dan daftar berhenti berlangganan email share: **relay**.
   `telegram_links` (sisa bot Telegram yang dicabut ADR-041) dan `contacts` (tidak pernah dipakai kode): **dibuang**.
   Pemilik: "Ok kerjakan" (2026-10-26). Dibangun di ADR-065, migrasi `0017`.
4. Batas kuota/paket: relay sumber kebenarannya dan menulis salinan kecil ke `u/{userId}/` setiap kali berubah. **Ya.**
5. Index: `index.txt` berisi JSON tabel ringkas ter-gzip. **Ya.** Rincian format di bawah (R1).
6. Fitur Drive baru dibekukan sampai R3 selesai. **Ya** (fitur S3 tetap boleh jalan).

**Format index v1 (dibangun di R1, 2026-10-26; `src/shared/drive-index.ts`):** objek `u/{userId}/index.txt` (keluarga
`f/{familyId}/index.txt`), teks UTF-8. Baris 1 = header JSON `{"v":1,"rev":…,"next":…,"cols":[…]}` (keluarga juga
`members`). Setiap baris berikutnya = **satu entri**, sebuah array JSON dengan kolom sesuai `cols`; nilai bawaan di ekor
tidak ditulis. Contoh:

```text
{"v":1,"rev":7,"next":4,"cols":["id","p","k","n","s","m","b","st","c","u","cm","th","f","t","tr","d","o","e","tb"]}
[1,0,1,"Foto",0,"",0,0,1761447600]
[2,1,0,"IMG_20261026_101112.jpg",2481123,"image/jpeg",2,0,1761447610,0,1761440000,1]
```

- **Nomor entri kecil** (bukan ULID), tidak pernah dipakai ulang (`next`). Isi file disimpan di `u/{userId}/{b}`, dengan
  `b` = nomor entri upload aslinya (key lama tetap berupa teks). Salinan menunjuk `b` yang sama; isi dihapus saat tidak
  ada entri lain yang menunjuknya (tidak perlu kolom refcount). Waktu disimpan dalam detik.
- Index tidak memuat sha256, rincian pindai, atau data akun. Thumbnail cukup ditandai `th` (key tetap `…/t/{b}.webp`).
  Hash dan rincian pindai menempel di objek isi; diputuskan di R3.
- **Disimpan tanpa gzip** (berbeda dari usul awal). Production berjalan di Workers Free (ADR-035): CPU dibatasi 10 ms per
  request, sedangkan gzip di Worker memakan ±34 ms untuk 10.000 entri. Cloudflare mengompres respons Worker sendiri
  (brotli/gzip) sesuai kemampuan klien, jadi ukuran yang terkirim tetap kecil.
- **Satu baris per entri** (berbeda dari "satu array JSON"). Worker hanya mengganti baris yang berubah, tanpa mengurai
  dan menulis ulang semuanya. Klien tetap membaca semuanya dengan satu `JSON.parse`.
- **Tulis bersyarat:** `etagMatches` (index baru: `If-None-Match: *`). Kalau kalah balapan, index dibaca ulang dan
  perubahannya diulang, sampai 12 kali; setelah itu `INDEX_BUSY` (503). Index yang tidak terbaca **tidak pernah
  ditimpa**.
- **Batas R2: satu tulis per detik per key** (lebih dari itu 429, kode 10058). Pustaka menunggu ≥1 detik lalu mengulang.
  Akibatnya satu user (dan satu keluarga) kira-kira mendapat satu perubahan index per detik. Operasi massal harus
  menjadi satu tulis: pindah/hapus banyak file dalam satu request (sudah begitu), dan di R3 upload banyak file serta
  hasil pindai/thumbnail digabung per batch. Hal ini disampaikan ke pemilik 2026-10-26.

Ukuran dan CPU (`npm run bench:index`, diukur di HP pengembang dengan Node 22; server Cloudflare lebih cepat):

| Entri | Di R2 | Terkirim (gzip / brotli) | Klien: baca semua | Worker: ganti nama satu | Worker: bentuk pohon / pindah 100 |
|---|---|---|---|---|---|
| 1.000 | 91 KB | 26 / 27 KB | 2,6 ms | 0,1 ms | 0,5 / 0,6 ms |
| 10.000 | 952 KB | 268 / 282 KB | 21 ms | 0,9 ms | 2,7 / 2,7 ms |
| 50.000 | 4,9 MB | 1,4 / 1,4 MB | 143 ms | 4,6 ms | 18 / 19 ms |
| 100.000 | 9,8 MB | 2,8 / 2,8 MB | 305 ms | 8,7 ms | 31 / 38 ms |

Pembanding untuk 10.000 entri: format JSON satu array butuh 11,5 ms untuk mengurai dan menulis ulang demi satu ganti
nama, ditambah 34 ms kalau di-gzip di Worker. Batas praktis di Workers Free: operasi satu entri aman sampai sekitar
100.000 entri, sedangkan operasi yang butuh bentuk pohon (pindah/hapus folder) sekitar 20.000–25.000 entri. Di atas itu
perlu Workers Paid, atau index dipecah (index + jurnal perubahan). Pemecahan dicatat, belum dibuat.

**Pustaka (R1):** `src/worker/services/drive-index.ts`:
- `IndexDoc` mengedit per baris (`get`, `set`, `delete`, `allocate`, `parents`, `entries`, `toText`).
- `readIndex` membaca index; `changeIndex` membaca, mengubah, lalu menulis bersyarat sambil menunggu dan mengulang.
  Fungsi perubahan bisa berjalan lebih dari sekali, jadi tidak boleh punya efek samping di luar index.

Shim R2 dev ikut diperbaiki:
- `put` ke key yang sama berjalan berurutan, jadi tulis bersyarat atomik seperti R2.
- `If-Match` pada key yang belum ada gagal.
- Ada opsi `limitWritesPerKey` untuk test batas 1/detik.

Test: `tests/unit/drive-index.test.ts`, termasuk 10 penulis bersamaan tanpa kehilangan perubahan.

**Konsekuensi untuk pencarian:** cari nama/struktur di index milik user sendiri (di klien, atau di Worker untuk API).
D6 dan D8 dibangun di atas index ini, bukan di atas FTS5.

**Peta pindah data D1 Drive** (semua tabel non-S3 di `migrations/`):

| Data sekarang (D1) | Tujuan |
|---|---|
| `nodes`, `nodes_fts`, `blobs` (status pindai, ukuran, sha256, thumbnail, refcount), dekorasi folder (ADR-058), `storage_pools.used/reserved` | **Index R2** user/keluarga (keputusan 1–3) |
| `node_stars`, `node_recent` | *usul:* index user sendiri (bintang) dan klien saja (terbaru) |
| `uploads`, `upload_parts` | *usul:* objek kecil `u/{userId}/uploads/{id}` selama upload berjalan, lalu entri di index |
| `users`, `accounts`, `verifications` (Better Auth) | **Relay** (Akun Zeiko) |
| `sessions` | **D1 khusus akses** (R0 no. 1) |
| `passkeys`, `two_factors` | dibuang (tidak dipakai sejak ADR-057) |
| `plans`, `addons`, `compress_packs`, `app_config`, `subscriptions`, `subscription_addons`, `storage_pools.limit`, `payments`, `invoices`, `wallets`, `wallet_ledger`, `credit_ledger` | **Relay** (paket dan pembayaran). Relay menulis salinan batas kuota/paket ke `u/{userId}/` saat berubah, supaya upload tetap jalan walau relay sedang mati (R0 no. 4) |
| `families`, `family_members`, `family_invites` | *usul:* anggota di header index keluarga; undangan di relay |
| `shares`, `share_items`, `share_sends` | **D1 khusus akses** (R0 no. 1); item share menunjuk index pemilik + nomor entri |
| `api_tokens`, `oauth_grants`, `oauth_codes`, `api_idempotency` (A1–A3) | **D1 khusus akses** (R0 no. 1) |
| `abuse_reports`, `legal_holds`, `blocked_hashes`, `audit_logs`, `ad_*`, `advertisers` | **Relay** (data operator, R0 no. 2) |
| `notifications`, `notification_prefs`, `email_suppressions` | **Relay** (R0 no. 3, ADR-065); baris lama dipindah otomatis tiap jam |
| `telegram_links`, `contacts` | **dibuang** (migrasi `0017`) |
| `archive_jobs`, `compress_jobs`, `vt_verdicts`, `vt_budget`, `usage_counters`, `counters` | *usul:* objek R2/KV sementara atau Analytics Engine |
| `manifest_dirty`, `batch_guards` | dibuang |

**Gabung tulis (pemilik, 2026-10-26: "Ok kerjakan"):** karena R2 hanya menerima satu tulis per detik per key, R3
menggabungkan perubahan index, tanpa layanan Cloudflare tambahan: upload banyak file ditulis per gelombang (satu
`changeIndex` untuk semua yang selesai), hasil pindai dan thumbnail ditulis per batch antrean per index, dan operasi
massal tetap satu request = satu tulis. Belum ada kode yang menulis index (upload masih ke D1), jadi aturan ini dibangun
bersama R3.

**Fase (rinci di ROADMAP bagian R):** R1 format + pustaka index (CAS etag, benchmark) → R2 baca dari index (explorer,
detail, breadcrumb, cari, bintang, Sampah) → R3 tulis ke index (upload/kuota, pindai, ganti nama/pindah/salin/Sampah/hapus,
dekorasi) → R4 index keluarga → R5 link share ke D1 khusus akses → R6 sesi, token API, OAuth ke D1 khusus akses → R7 akun/paket/pembayaran/data
operator di relay (repo Relay) → R8 pindahkan data production, hapus tabel Drive dari D1 (D1 utama tinggal untuk S3).

**Dampak ke yang sudah ada:** ADR-002, ADR-058 (kolom dekorasi), ADR-061–063 (tabel token/OAuth) dan sebagian besar
`services/` Drive dibangun di atas D1 dan akan dipindah lewat fase di atas. Sampai fase itu selesai, kode yang ada tetap
jalan apa adanya (production saat ini: 6 node). Fitur Drive baru tidak boleh menambah tabel atau kolom D1 (D1 S3
maupun D1 khusus akses; yang terakhir hanya menerima tabel sesi, token, OAuth, dan share yang dipindah di R5/R6).

## ADR-065 — Notifikasi, saklar email, dan daftar berhenti berlangganan disimpan relay
**Tanggal:** 2026-10-26 · **Status:** diterima (pemilik, jawaban R0 no. 3 di ADR-064: "Ok kerjakan").

**Keputusan.** Lonceng di app, saklar "jangan kirim email untuk jenis X", dan alamat yang berhenti menerima email share
(sebagai hash) disimpan relay (Akun Zeiko), bukan di D1 Drive. Drive tetap yang menyusun kata-katanya dan memutuskan jenis
mana yang wajib (`MANDATORY_EMAIL`). `telegram_links` dan `contacts` dibuang (migrasi `0017`).

**Cara kerjanya:**
- **Relay** (repo `Relay`, `src/accounts/drive_notices.rs`): tabel `drive_notices`, `drive_notice_prefs`, dan
  `drive_email_suppressions` di `accounts.db`, dikunci dengan id user Drive. Route `/apps/v1/notices*` dan
  `/apps/v1/suppressions*` dijaga token yang sama dengan sign-in (`ZEIKO_APP_TOKEN`).
- **Drive** (`adapters/notices.ts`): `RelayNotices` dipakai kalau Akun Zeiko terpasang; `MockNotices` (KV) di dev dan
  test.
- **Alur notifikasi:**
  1. `notify()` mengantre pesan `notice` lengkap dengan isinya; tidak ada lagi baris D1.
  2. Consumer `notify` menyerahkannya ke relay (sekali per id; relay menjawab apakah emailnya dimatikan).
  3. Lalu consumer mengirim email, kecuali dimatikan.
- **Kalau relay mati:**
  - Antrean `notify` mengulang sampai 20 kali (±16 jam, sebelumnya 3 kali) sebelum masuk dead-letter.
  - Lonceng dan saklar menjawab `ACCOUNTS_UNAVAILABLE`.
  - Email share tidak dikirim (cek berhenti berlangganan gagal = tidak kirim, kuota harian tidak terpotong).
  - Halaman berhenti berlangganan tetap bilang "beres": penulisan ke relay dicoba langsung, dan kalau gagal dititipkan
    ke antrean.
  - Penghapusan akun menunggu putaran berikutnya.
  - Ekspor data menulis terang-terangan bahwa notifikasi belum bisa diambil.
- **Data lama:**
  - Cron tiap jam `move_notices_to_relay` memindahkan baris `notifications`, `notification_prefs`, dan
    `email_suppressions`, 100 per tabel sekali jalan dan tiga putaran per jam, lalu menghapus yang sudah sampai.
  - Saklar yang diubah di relay sejak itu tidak ditimpa.
  - Pesan antrean lama (`notification` + id baris D1) masih diantar lewat jalan baru.
  - Tabelnya dihapus di R8.
- **Perubahan kecil:** `renewal_failed` sekarang juga dikirim lewat email, sesuai `MANDATORY_EMAIL`. Dulu hanya masuk
  lonceng karena tidak pernah diantrekan; ini sebuah kelalaian.

**Urutan pasang:** Drive boleh dideploy lebih dulu. Selama relay belum di-update, route-nya masih 404, sehingga
notifikasi menunggu di antrean dan lonceng kosong. Setelah pemilik menekan update di dashboard relay (atau menjalankan
`bash install.sh`), antrean dan pemindah data jalan sendiri.

**Test:**
- Drive: `tests/unit/notices.test.ts` dan `tests/integration/notifications.test.ts` (pindah data lama, pesan antrean
  lama, tabel yang dibuang); semua test yang memeriksa notifikasi sekarang membaca penyimpanannya (`tests/helpers/notices.ts`).
- Relay: `tests/drive.rs` dan unit test di `drive_notices.rs`.

## ADR-066 — Kontak pelanggan lewat WhatsApp; spreadsheet di HP tidak bentrok dengan tarik-muat-ulang

**Keputusan pemilik (2026-10-28):** "Ganti semua kontak support jadi ke whatsapp +62 819-3241-6096, payment,
support, tanya langsung kesitu. Jam jawab 08.00 - 22.00."

- `SUPPORT_CONTACT` (`src/shared/constants.ts`) = WhatsApp +62 819-3241-6096 (08.00–22.00 WIB) dipakai untuk dukungan
  dan banding di ToS/Kebijakan Privasi (`legal/contacts.ts`), pemesanan iklan (`AD_CONTACT`, halaman `/iklan`, email
  iklan), dan S3 yang ditangguhkan. Tombol iklan membuka `wa.me` dengan judul sebagai pesan.
- Permintaan privasi dan laporan penyalahgunaan tetap ke email (`privacy`, `abuse`): itu bukan kontak dukungan.
  `OPERATOR_EMAIL` tetap alamat tujuan peringatan untuk operator dan tidak ditampilkan ke orang.
- Email keluar nanti lewat AWS SES (pemilik, 2026-10-28); belum diganti di sini.

**Spreadsheet di HP** (pemilik: "sulit untuk digeser ke atas, gelud dengan gestur reload"): FortuneSheet
menggulir gridnya dari handler sentuhnya sendiri, jadi browser juga ikut menggeser halaman dan menarik untuk memuat
ulang. Grid (`.zk-sheet .fortune-sheet-overlay`) diberi `touch-action: none`, dan selama editor apa pun terbuka
`html`/`body` diberi `overscroll-behavior: none` (`EditorFrame` memasang kelas `editor-open`).

## ADR-067 — Editor video lengkap, kompres lokal gratis, kolase, alat foto tambahan, dan JPEG XL

**Status:** diterima (pemilik, 2026-10-28). **Konteks:** pemilik: "Buat agar editor video lebih lengkap, dengan efek,
colour wheel, masukin musik, audio edit, dll … untuk export pastikan ada encode codec yang lengkap. … tools compressor
video lokal yang lengkap kek handbrake tapi videonya di pull dari drive atau lokal. Sekalian editor fotonya … tambahkan
fitur menambahkan teks, dekorasi dan lain lain, serta bikin tools kolase", lalu "Yang ada di plan sekarang itu cloud
kompress ya, yang ini lokal kompress full free" dan "tambahkan jpegxl support baik untuk compress dan view". Pembekuan
fitur Drive baru sampai R3 (ADR-064) dikecualikan pemilik untuk ini: semuanya jalan di browser, tanpa tabel, kolom, atau
route baru.

**Keputusan:**
- Aturan ADR-050 tetap: isi file tidak dikirim ke mana pun, hasil lewat antrean upload biasa, library dimuat saat alat
  dibuka. Library baru (versi dipatok): `@jsquash/jxl` 1.3.0 (libjxl, baca + tulis JPEG XL), `@jsquash/avif` 2.1.1
  (tulis AVIF kalau browser tidak bisa), `@mediabunny/mp3-encoder`, `aac-encoder`, `flac-encoder` 1.61.3 (sama dengan
  `mediabunny`; AAC/FLAC hanya dipakai kalau browser tidak punya encoder sendiri, MP3 selalu).
- **CSP:** `script-src` ditambah `'wasm-unsafe-eval'`. Ini hanya mengizinkan kompilasi WebAssembly, bukan `eval` JS
  (`new Function` tetap ditolak). Encoder audio jalan di worker `blob:` yang sudah diizinkan `worker-src`. Efek
  samping baik: decoder WASM pdf.js (JBIG2, OpenJPEG) sekarang benar-benar dipakai, bukan cadangan JS-nya.
- **Kompres lokal** (`editors/compress/`, alat `compress`, kartu di /alat, menu ⋮ "Kompres di perangkat (gratis)" untuk
  video/audio/foto): terpisah dari Kompres di server (ADR-031, pakai kredit), tidak memakai kredit atau API. Antrean
  banyak file diproses satu per satu dengan `mediabunny` `Conversion`. File Drive dibaca per rentang (Range) dari URL
  pratinjau lewat `UrlSource` dengan `fetchFn` yang meminta URL baru kalau token hampir habis atau dijawab 410, jadi
  file besar tidak perlu muat di memori; file perangkat dibaca dari disk. Batas `editor_*` tidak berlaku untuk video
  (foto tetap `editor_image_max_bytes`).
  - Pengaturan ala HandBrake: preset (Cepat 1080p, Kualitas tinggi 1080p, H.265 1080p, Cepat 720p, Kecil 480p, Kirim
    ≤ 25 MB, Kirim kecil ≤ 10 MB, AV1 WebM, VP9 WebM, Ambil audio MP3/M4A, Atur sendiri); container MP4, MOV, WebM, MKV,
    MPEG-TS, M4A, MP3, Ogg, Opus, FLAC, WAV, AAC; codec video H.264, H.265, VP9, AV1, VP8 atau salin; kontrol kualitas
    RF (quantizer WebCodecs, dengan bitrate cadangan kalau encoder tidak mendukung), bitrate rata-rata, atau ukuran
    target (bitrate dihitung dari durasi); resolusi (sisi pendek, tidak pernah diperbesar), frame rate, jarak
    keyframe, preferensi hardware/software; audio AAC, Opus, MP3, FLAC, PCM atau salin/tanpa suara, bitrate, sample
    rate, kanal; putar, cermin, dan potong durasi (satu file). Hanya codec yang bisa di-encode browser ini yang bisa
    dipilih. Selama berjalan layar dijaga menyala (Wake Lock).
  - Foto di antrean yang sama: JPEG, PNG, WebP, AVIF, JPEG XL; kualitas, lossless (JXL/WebP), usaha encoder, sisi
    terpanjang; kalau hasilnya tidak lebih kecil file asli dipakai (bisa dimatikan).
- **JPEG XL:** dikenali dari tanda tangan bytes (`sniff.ts`) dan ekstensi (OS sering tidak memberi tipe; upload
  `.jxl` tanpa tipe dikirim sebagai `image/jxl`). Pratinjau Drive menampilkan `<img>` dulu (Safari bisa sendiri) dan
  kalau gagal men-decode di WASM lalu menampilkan PNG-nya; thumbnail upload `.jxl` dibuat dengan cara yang sama. Editor
  foto bisa membuka dan menyimpan JXL dan AVIF. Kompres di server (ADR-031) tidak berubah.
- **Teks, stiker, bentuk** (`editors/decor/`): satu model dan satu cara menggambar untuk editor foto, kolase, dan
  video. Teks: 6 font sistem (tidak ada font yang diunduh, jadi tampilan = hasil), 6 gaya (biasa, tebal, kotak, garis
  tepi, bayangan, neon), rata kiri/tengah/kanan, warna. Stiker: emoji dalam 8 kelompok (digambar font emoji perangkat).
  Bentuk: 10 (kotak, kotak bulat, lingkaran, segitiga, bintang, hati, panah, garis, balon kata, ledakan), isi atau
  garis tepi. Semua bisa digeser, diubah ukuran dan diputar lewat pegangan di sudut (menempel ke sudut siku), diatur
  kepekatan, diduplikat, dan diatur urutan lapisannya. Posisi dalam pecahan gambar, ukuran dalam sisi pendek.
- **Editor foto, alat baru:** Warna (HSL selektif, 8 rentang warna: rona, saturasi, terang; abu-abu tidak berubah),
  Grading (tiga roda warna lift/gamma/gain + terang-gelap; per kanal, jadi masuk ke LUT yang sama), Teks & stiker
  (menggantikan Teks), Gambar (pena, spidol *multiply*, neon), Sensor (kotak piksel, blur, atau hitam; diterapkan
  sebelum warna supaya tidak bisa dimunculkan lagi).
- **Kolase** (`editors/collage/`, alat `collage`, kartu di /alat, menu ⋮ "Buat kolase" untuk 2+ foto): 1–9 foto dari
  Drive atau perangkat (batas `editor_image_max_bytes` per foto). 37 tata letak (petak menutup seluruh area tanpa
  tumpang tindih, dites), 8 rasio, jarak antar foto, tepi luar, sudut bulat, latar warna atau gradasi, teks/stiker/
  bentuk dari `decor/`. Kotak diketuk untuk dipilih, fotonya digeser di dalam kotak dan di-zoom (slider atau scroll),
  ditukar, diganti, atau dikeluarkan. Disimpan 1080–4096 px sisi terpanjang sebagai JPEG, PNG, WebP, AVIF, atau JXL.
  Supaya memori HP cukup, tiap foto disimpan paling besar 4096 px (1 foto) sampai 1800 px (5+ foto).
- **Belum:** editor video lengkap (efek, roda warna, musik, edit audio, transisi, teks berwaktu, export dengan pilihan
  codec dari `codecs/EncodeForm`) menyusul; pemilik menghentikan sesi setelah foto dan kolase (2026-10-28).

## ADR-068 — Zeiko S3: tulis bersyarat (If-None-Match / If-Match)
**Tanggal:** 2026-10-28 · **Status:** diterima (pemilik: roadmap S2).

**Konteks:** `writeObject` mengabaikan `If-None-Match`/`If-Match`. PutObject dengan `If-None-Match: *` menimpa objek
yang sudah ada dan menjawab 200, jadi klien yang memakainya sebagai kunci (Terraform `use_lockfile`, tool data lake)
mengira kuncinya aman padahal tidak.

**Keputusan:**
- **PutObject, CopyObject (tujuan), CompleteMultipartUpload:** `If-None-Match: *` → 412 `PreconditionFailed` kalau key
  sudah ada; `If-Match: "<etag>"` → 412 kalau key tidak ada atau ETag-nya beda (roadmap S2; untuk key yang tidak ada
  kami menjawab 412). Sama seperti Amazon, hanya `*` untuk If-None-Match dan satu ETag untuk If-Match. Nilai lain,
  keduanya sekaligus, atau `If-Modified-Since`/`If-Unmodified-Since` di operasi tulis → `NotImplemented` (501), tidak
  diabaikan.
- **Dicek dua kali.** Cek awal (satu baca index) sebelum byte apa pun dipindah, supaya kunci yang sudah ada gagal cepat.
  Cek yang menentukan ada **di batch D1 yang sama dengan commit index** (`replaceRow` di `services/s3-objects.ts`):
  `If-None-Match` = `INSERT … ON CONFLICT (bucket, key) DO NOTHING RETURNING`; `If-Match` = `SELECT` baris lama lalu
  `UPDATE … WHERE etag = ?` dalam satu transaksi (semua kolom diisi ulang, `replicated = 0`). Dari dua penulis
  bersamaan hanya satu yang bisa lolos. Penulis yang kalah: blob barunya dihapus dari R2 dan reservasi byte dilepas
  lewat jalur gagal yang sudah ada. Scan dan replika (ADR-047) hanya untuk pemenang, karena keduanya dimulai setelah
  commit.
- **PutObject/CopyObject yang kalah di commit → 412** (yang pertama selesai menang, seperti Amazon).
- **CompleteMultipartUpload:** gagal di cek awal → 412 dan upload **tetap ada** (bisa di-abort, atau di-complete
  tanpa syarat). Lolos cek awal tapi kalah di commit (ada tulis lain selama R2 menggabungkan part) → **409
  `ConditionalRequestConflict`**: R2 sudah memakai upload itu, jadi barisnya, blobnya, dan reservasinya dibuang. Ini
  arti 409 di Amazon ("re-initiate the multipart upload").
- CopyObject ke dirinya sendiri (hanya metadata): `If-None-Match: *` selalu 412 (sumbernya ada); `If-Match` dicek lagi
  di `UPDATE` yang sama.
- **Syarat sumber CopyObject/UploadPartCopy:** `x-amz-copy-source-if-modified-since` dan `-if-unmodified-since` dulu
  diabaikan; sekarang dihitung dengan aturan Amazon (ETag cocok mengalahkan tanggal unmodified, ETag tidak cocok
  mengalahkan tanggal modified).
- **Operasi tulis lain tanpa dukungan syarat** (UploadPart, UploadPartCopy, CreateMultipartUpload,
  AbortMultipartUpload, DeleteObject) → `NotImplemented` kalau membawa `If-Match`, `If-None-Match`,
  `If-(Un)Modified-Since`, atau `x-amz-if-match-*`. DeleteObjects: objek yang membawa `ETag`/`LastModifiedTime`/`Size`
  mendapat error `NotImplemented` di `DeleteResult` dan tidak dihapus.

**Tidak dibangun:** hapus bersyarat (DeleteObject `If-Match`, `x-amz-if-match-last-modified-time`/`-size`); kalau
diminta, cukup `DELETE … AND etag = ?`.

**Konsekuensi:** tulis bersyarat menambah satu baca D1 (cek awal). Tanpa header bersyarat jalurnya sama seperti dulu.
Kode error baru `ConditionalRequestConflict` (409). Test: `tests/integration/s3-conditional.test.ts` (dua penulis
ditahan sampai keduanya lolos cek awal → tepat satu 200 dan satu 412; If-Match benar/salah/tidak ada; multipart 412
lalu abort, 409 saat tulis lain masuk di tengah complete; copy tujuan dan sumber; syarat yang ditolak; `used_bytes`,
jumlah blob R2, dan pesan scan tetap benar).

## ADR-069 — Email dan lonceng dua bahasa (D14)

Tanggal: 2026-10-28. Status: diterima.

- Teks email (`email-templates.ts`) dan notifikasi (`notify.ts`, `renderNotice`) pindah ke bagian `mail` di
  `strings.id.ts` + `strings.en.ts`. Email notifikasi memakai `users.locale` penerima; lonceng memakai bahasa app
  (`requestLang`, cookie `zk_lang`); email share dan undangan keluarga memakai bahasa pengirim (penerima mungkin belum
  punya akun); email uji operator tetap Indonesia.
- Tidak ada tabel atau kolom D1 baru (ADR-064): `users.locale` sudah ada.
- Footer email sekarang "Zeiko Drive · drive.zeiko.biz.id" (dulu nama lama). `otpEmail` dihapus: tidak dipakai sejak
  login lewat Akun Zeiko.

## ADR-070 — Zeiko S3 bukan hosting website; S7 dibatalkan

Tanggal: 2026-10-28. Status: diterima.

- **Keputusan pemilik (2026-10-28):** "S3 jadi website melanggar ToS". Bucket Zeiko S3 tidak boleh dipakai untuk
  menyajikan situs. Website dijual sebagai produk Zeiko Hosting (situs statis dan paket sekolah/UMKM di repo Relay),
  bukan sebagai fitur S3.
- **ToS** (`src/web/legal/syarat.id.ts` + `.en.ts`), Kategori C bertambah satu butir: menjadikan Bucket Zeiko S3 sebagai
  hosting website (menyajikan halaman HTML, CSS, atau JavaScript untuk dibuka pengunjung sebagai situs), dengan arahan
  ke Zeiko Hosting. Teks lain tetap kata per kata.
- **S7 (website statis di domain sendiri) dibatalkan.** `website` tetap di `UNSUPPORTED_SUB` (`NotImplemented`), dan
  objek tetap dilayani dengan `Content-Security-Policy: sandbox` (ADR-044).

## ADR-071 — Zeiko S3: key dengan izin terbatas (S1)

Tanggal: 2026-10-28. Status: diterima.

**Yang dibangun.** Saat membuat key (halaman `/s3`, `POST /api/s3/keys`, `POST /api/v1/s3/keys`) bisa dipilih: semua
bucket atau daftar bucket tertentu, satu prefix opsional, izin baca+tulis / baca saja / tulis saja, dan tanggal
kedaluwarsa. Migrasi `0018_s3_key_scopes.sql` menambah `buckets_json`, `prefix`, `access`, `expires_at` di `s3_keys`;
nilai kosong (`NULL`, `'rw'`) = tanpa batas, jadi key lama tetap akses penuh.

**Aturan** (`permit`/`scopeAllows` di `routes/s3-api.ts`):

- Tiap operasi butuh `any` (bucket dalam cakupan: HeadBucket, GetBucketLocation/Versioning), `read` (Get/HeadObject,
  ListObjects, GetBucketAcl/Cors/Logging, sumber CopyObject/UploadPartCopy), `write` (Put, multipart termasuk ListParts
  dan ListMultipartUploads, Delete, DeleteObjects), atau `manage` (CreateBucket, DeleteBucket, PutBucketAcl,
  Put/DeleteBucketCors, PutBucketLogging). `manage` hanya untuk key tanpa batas apa pun.
- Di luar izin → `AccessDenied` (403). Bucket di luar cakupan ditolak sebelum dicek ada atau tidak, jadi key tidak bisa
  menebak nama bucket lain.
- ListBuckets hanya menampilkan bucket dalam cakupan. Key ber-prefix hanya boleh List dengan `prefix` yang diawali
  prefix key; DeleteObjects menolak per objek (error `AccessDenied` di `DeleteResult`) untuk key di luar prefix.
- Presigned URL lewat jalur autentikasi yang sama, jadi ikut aturan yang sama. Key kedaluwarsa → `InvalidAccessKeyId`
  (dicek tiap request; cache `lookupKey` 15 detik tidak menunda kedaluwarsa).
- Bucket di cakupan harus milik akun saat key dibuat (404 kalau bukan); prefix tidak boleh diawali `/`, maks 512 byte,
  tanpa karakter kontrol; tanggal harus di masa depan.

**Link di `/s3`** (`services/s3-browse.ts`) ditandatangani key yang boleh membaca objek itu: key tanpa kedaluwarsa
dulu, lalu yang paling lama berlaku, lalu yang terbaru. Umur link tidak melebihi sisa umur key-nya. Tidak ada key yang
cocok → 409 `s3_no_key`. Tidak dibuat key internal tersembunyi.

**Tidak dibangun:** kebijakan bucket (bucket policy) dan banyak prefix per key; mengubah cakupan key yang sudah ada
(cabut lalu buat baru).

Test: `tests/integration/s3-key-scope.test.ts`.

## ADR-072 — Zeiko S3: lifecycle bucket (S3)

Tanggal: 2026-10-28. Status: diterima.

**Yang dibangun.** `Put/Get/DeleteBucketLifecycleConfiguration` (`?lifecycle` keluar dari `UNSUPPORTED_SUB`),
`services/s3-lifecycle.ts`, dan editor "Hapus otomatis" per bucket di `/s3` (`PUT/DELETE /api/s3/buckets/:name/lifecycle`).
Aturan disimpan di `s3_buckets.lifecycle_json` (migrasi `0019_s3_lifecycle.sql`, plus `lifecycle_cursor` dan
`lifecycle_at`), seperti `cors_json`.

- **Yang didukung:** Rule dengan `ID` (dibuatkan `rule-n` kalau kosong; harus unik), `Status`, `Filter` berisi `Prefix`,
  `ObjectSizeGreaterThan`, `ObjectSizeLessThan` (sendiri atau dalam `And`), atau `Prefix` gaya lama langsung di Rule;
  aksi `Expiration` (`Days` atau `Date` tengah malam UTC) dan `AbortIncompleteMultipartUpload` (`DaysAfterInitiation`).
- **Ditolak dengan jelas, tidak diabaikan:** `Transition`, `NoncurrentVersion*`, `ExpiredObjectDeleteMarker`, dan filter
  `Tag` → `NotImplemented` (menunggu S5/S6/S8); elemen tak dikenal → `MalformedXML`; abort bersama filter ukuran,
  rule tanpa aksi, dan lebih dari `s3_lifecycle_max_rules` (100) → `InvalidRequest`; angka/tanggal salah →
  `InvalidArgument`. Konfigurasi kosong → `NoSuchLifecycleConfiguration` (404).
- **Izin (ADR-071):** Get butuh `read`, Put/Delete butuh key tanpa batas (`manage`).
- **Hitungan hari seperti Amazon:** objek yang ditulis pada `t` dengan `Days = n` kedaluwarsa di tengah malam UTC pertama
  setelah `t + n hari` (`expiryCutoff`). Dasarnya `modified_at` (menimpa = objek baru). `Date`: semua objek yang cocok
  sejak tanggal itu.
- **Pelaksana:** cron jam-an `s3_lifecycle` (`runS3Lifecycle`). Tiap jalan mengambil `s3_lifecycle_buckets_per_run` (2)
  bucket: yang sedang di tengah putaran dulu, lalu yang putaran terakhirnya selesai sebelum hari ini (UTC). Satu giliran
  bucket: (awal putaran) batalkan upload menggantung yang jatuh tempo, lalu lihat paling banyak `s3_lifecycle_scan_rows`
  (200) objek satu rule dari cursor dan hapus yang jatuh tempo lewat `deleteObjects` (jadi `used_bytes`, replika, dan
  index tetap benar). Cursor `{rule, after}` disimpan; satu putaran penuh per bucket per hari. Sekitar 6 query D1 per
  bucket, aman untuk Workers Free.
- **Dunning (ADR-047):** akun `readonly` tetap diproses (hapus boleh di readonly); akun `locked` dan akun yang tidak aktif
  dilewati sampai putaran berikutnya.
- **Mengganti aturan** mengulang putaran dari awal (`lifecycle_cursor = NULL`, `lifecycle_at = 0`).

**Tidak dibangun:** notifikasi saat objek dihapus lifecycle; header `x-amz-expiration` di GetObject/HeadObject.

Test: `tests/integration/s3-lifecycle.test.ts` (parse/serialize XML termasuk bentuk aws-cli, SDK Put/Get/Delete, editor
app, key terbatas, cron dengan jam palsu menghapus tepat yang jatuh tempo dan membatalkan upload, halaman demi halaman
dengan cursor, akun locked dilewati).

## ADR-073 — Subtitle di pratinjau video (D13)

Tanggal: 2026-10-29. Status: diterima (pemilik: "Kerjakan D13", walau fitur Drive baru dibekukan sampai R3; fitur ini
tidak menyentuh D1 dan tidak menambah data di server).

- **Sumber subtitle:** `.srt`/`.vtt` yang sudah lolos pindai di folder yang sama dengan video (dicari lewat
  `GET /api/nodes/:folder/children`, paling banyak 10 halaman). Nama dasar yang sama (`Film.srt` untuk `Film.mp4`) dipasang
  otomatis; `Film.id.srt`/`Film.en.forced.vtt` berlabel tag-nya. Bisa dipilih manual, dimatikan, atau diambil dari
  perangkat (file itu tidak diunggah).
- **Di browser saja** (`src/web/lib/subtitles.ts`, `components/explorer/VideoView.tsx`): bytes dari URL pratinjau yang
  sudah ada (USERCONTENT_ORIGIN, CORS sudah mengizinkan APP_ORIGIN), didekode sendiri (BOM UTF-8/UTF-16, UTF-8 ketat,
  lalu Windows-1252 untuk `.srt` lama), SRT diubah ke WebVTT, lalu dipasang sebagai `<track>` lewat URL `blob:`.
  CSP tidak berubah: `media-src` sudah mengizinkan `blob:`, dan track tidak pernah dimuat langsung dari USERCONTENT_ORIGIN.
- **Konversi SRT:** waktu `,`→`.` (jam boleh tidak ada, pecahan 1–3 digit), nomor cue dibuang, kotak `X1:…Y2:` dibuang,
  `<b>/<i>/<u>` tetap, tag lain (`<font>`) dan override ASS (`{\an8}`) dibuang, `&` dan `<` lepas di-escape, `-->` di
  teks diganti `→`. Blok yang rusak dilewati, bukan menggagalkan seluruh file.
- **Ukuran teks:** Kecil/Sedang/Besar lewat `video[data-subs]::cue`, disimpan per perangkat (`localStorage`).
- **Tidak dibangun:** subtitle di halaman share publik, subtitle yang tertanam di file video (mkv/mp4 text track),
  dan format lain (`.ass`, `.ssa`, `.sub`).

Test: `tests/unit/subtitles.test.ts` (waktu, encoding, BOM, tag, blok rusak, pencocokan nama).

## ADR-074 — R3: setiap perubahan Drive ditulis ke index R2 (write-through dari D1)

Tanggal: 2026-10-29. Status: diterima (pemilik: "Kerjakan D13 dan R3").

**Konteks.** Di roadmap, R2 (baca dari index) dijadwalkan sebelum R3 (tulis ke index). Masalahnya, sampai hari ini tidak ada
kode yang menulis index, jadi index yang mau dibaca R2 belum pernah ada. Karena itu R3 dikerjakan lebih dulu sebagai
tahap *expand*: setiap perubahan pohon pribadi ditulis ke `u/{userId}/index.txt`, sementara app tetap membaca D1. Setelah
itu R2 tinggal memindahkan pembacaan ke index yang sudah lengkap dan terkini, dan R8 menghapus tabel D1 (*contract*).

**Keputusan:**
- **Index = proyeksi pohon pribadi dari D1** (`services/drive-index-sync.ts`): node `space = 'personal'` milik user, tanpa
  upload yang masih berjalan (`status = 'uploading'`), tanpa node keluarga (R4). Header: `root` (id D1 folder akar) dan
  `used` (byte terpakai pool pribadi). Entri: kolom ADR-064 ditambah:
  - **`x`**: id node di D1, untuk menjaga nomor entri tetap sama dari satu tulis ke tulis berikutnya. Kolom ini hanya
    hidup selama masa pindah (R3–R8) dan berisi `""` untuk entri yang lahir langsung di index;
  - **`st = 2` (blocked)**: ditolak pemindai (`rejected`/`infected`) atau dikarantina takedown.

  Format v1 tetap (header `cols` mencatat urutan kolom). Perubahan ini aman karena belum ada index yang pernah ditulis.
- **Penanda + gabung tulis.** Setiap perubahan menandai user di `manifest_dirty` (tabel lama, tanpa kolom baru;
  `dirty_at > 0`), lalu meminta flush setelah respons (`ctx.defer` = `waitUntil`; queue dan cron menunggu
  `ctx.drain()`). Flush menunggu `INDEX_FLUSH_DELAY_MS` (bawaan 1000 ms; test 0) lalu **mengklaim** penanda
  (`dirty_at = -waktu`). Dari semua flush yang diminta selama satu gelombang, hanya satu yang jalan, jadi gelombang
  upload, satu batch antrean pindai, atau satu operasi massal menjadi satu tulis. Di satu isolate, permintaan flush untuk
  user yang sama digabung sampai klaim. Perubahan selama flush menandai lagi (`dirty_at > 0`), dan flush berikutnya
  menulisnya. Klaim yang lebih tua dari 5 menit dianggap milik flush yang mati dan boleh diambil alih.
- **Tidak pernah menulis pohon lama.** Flush membaca index lalu membaca pohon D1 di **dalam setiap percobaan**
  `changeIndex` (tulis bersyarat etag). Tulis yang berhasil pasti membaca index sesudah tulis sebelumnya, dan membaca D1
  sesudahnya. Jadi tulis yang kalah balapan tidak mungkin mengembalikan pohon yang lebih lama.
- **Yang menandai:** semua jalur yang dulu memanggil `markManifestDirty` (folder baru, ganti nama, pindah, salin,
  Sampah, pulihkan, hapus, upload, kompres), ditambah dekorasi, bintang (hanya pemilik pohon pribadi), thumbnail, hasil
  pindai, karantina/batal karantina/tolak laporan, serta paket keluarga (buat, gabung, keluar, bubar).
- **Cadangan:** cron jam-an `drive_index_flush` menulis `drive_index_flush_per_run` (20) user yang masih bertanda
  (flush yang gagal mengembalikan tandanya). **Backfill:** migrasi data `0020` menandai semua user yang punya pohon
  pribadi; tidak ada tabel atau kolom baru.
- **Hapus akun:** index ikut dihapus, dan flush yang datang belakangan juga menghapusnya (akun `deleted`). Ekspor data
  tidak berubah: index tidak memuat data yang belum ada di ekspor.

**Biaya.** Satu flush = 1 baca R2, 1 baca D1 berisi seluruh pohon user, dan 1 tulis R2 kalau ada yang berubah. CPU-nya
mengikuti tabel ADR-064 (urai semua entri): aman di Workers Free sampai beberapa ribu entri per user. Pohon yang jauh
lebih besar butuh Workers Paid atau flush bertahap (dicatat, belum dibuat).

**Belum:** pembacaan (R2), kuota dan reservasi upload di index, index keluarga (R4), dan membuang `x` saat D1 dihapus (R8).

Test: `tests/integration/drive-index-sync.test.ts` (semua jenis perubahan dengan nomor entri tetap, pindai →
scanning/ready/blocked, user lain dan node keluarga tidak masuk, gelombang 12 perubahan ≤ 2 tulis, klaim/klaim basi/
perubahan di tengah flush, flush gagal lalu cron, backfill, akun dihapus) dan `tests/unit/drive-index.test.ts`.

## ADR-075 — Zeiko S3: upload multipart dari halaman `/s3` (S4)

Tanggal: 2026-10-29. Status: diterima (pemilik: roadmap S4).

- **Lewat API app, bukan host S3.** Setiap part adalah satu request ke `/api/s3/buckets/:name/uploads/...` (sesi + CSRF
  seperti route `/s3` lain). Upload multipart-nya sama dengan yang dibuat klien S3 (`createUpload`/`uploadPart`/
  `completeUpload`/`abortUpload` di `services/s3-objects.ts`), jadi tidak butuh CORS bucket, tidak butuh access key, dan
  kuota (reservasi per part), scan, serta replika memakai jalur yang sama.
  - `POST …/uploads` `{key, size, contentType}` → `{uploadId, partSize, parts}`;
  - `PUT …/uploads/:id/parts/:n?key=` → `{etag}`;
  - `GET …/uploads/:id?key=` → part yang sudah tersimpan (untuk melanjutkan);
  - `POST …/uploads/:id/complete` `{key, parts}`;
  - `DELETE …/uploads/:id?key=`.
- **Ukuran part** dari config `s3_web_part_bytes` (32 MiB). Kalau file butuh lebih dari 10.000 part, ukurannya dinaikkan
  ke MiB utuh, paling besar `s3_web_upload_max_bytes` (95 MiB, batas body request Cloudflare). Semua part kecuali yang
  terakhir sama besar (aturan R2). Batas total per file: `s3_web_multipart_max_bytes` (50 GiB); kuota akun tetap
  berlaku per part.
- **Di halaman** (`src/web/lib/s3-upload.ts`): file yang lebih besar dari satu part dikirim per part. Jumlah part
  paralel memakai pilihan perangkat `uploadParts`, dan jumlah file paralel `uploadFiles` (ADR-053). Error jaringan, 429,
  dan 5xx dicoba ulang per part (5 kali: 1–16 detik). Jeda menghentikan request yang sedang berjalan. Lanjut dan Coba lagi
  menanyakan part yang tersimpan ke server dulu, karena server yang menentukan. Batal meng-abort upload, jadi
  reservasinya kembali. Progres, jeda/lanjut, coba lagi, dan batal tampil di baris upload `/s3`, bukan di panel upload
  Drive (antrean itu khusus file Drive).
- **Izin:** mulai, kirim part, dan selesai butuh akun yang boleh menulis (`readonly` → 403 `s3_readonly`). Melihat part
  dan batal tetap boleh saat `readonly`, karena batal membebaskan ruang. Upload dicari per akun, jadi ID upload milik
  orang lain menjawab 404.
- `NoSuchUpload` → 404; `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` → 400 di API app.

**Tidak dibangun:** melanjutkan setelah halaman dimuat ulang. ID upload hanya ada di memori tab; upload yang
ditinggalkan dibersihkan cron `s3_expire_uploads` setelah `s3_multipart_ttl_hours`.

Test: `tests/integration/s3-web-multipart.test.ts` (urutan bebas, part dikirim ulang, daftar part, objek utuh, urutan
salah, batal, kuota, batas ukuran, readonly, ukuran part) dan suite IDOR. Dicek di Chrome dev dengan file 230 MB (8 part):
jeda/lanjut, jaringan diputus 4 detik (12 request gagal lalu pulih, ETag sama), batal (reservasi 0), desktop gelap dan
360 px terang.

## ADR-076 — Zeiko S3: kompatibilitas tambahan (S8)

Tanggal: 2026-10-29. Status: diterima (pemilik: roadmap S8). Satu commit per bagian.

### 1. Object tagging
- `Put/Get/DeleteObjectTagging` (`?tagging` di objek), `x-amz-tagging` di PutObject dan CreateMultipartUpload (tag
  disimpan di upload, lalu diberikan ke objek saat complete), dan `x-amz-tagging-directive` di CopyObject. `COPY`
  (bawaan) membawa tag sumber; `REPLACE` memakai `x-amz-tagging`, atau kosong kalau header itu tidak ada. CopyObject ke
  dirinya sendiri boleh kalau hanya tag yang diganti.
- Disimpan di index per akun (langkah `v4` di `MIGRATIONS`, `services/s3-index.ts`): `s3_objects.tags_json` dan
  `s3_uploads.tags_json`, berisi `[[key, value], …]`. Tag tidak mengubah ETag maupun tanggal objek.
- Batas mengikuti Amazon (`services/s3-tags.ts`): paling banyak 10 tag, key 1–128 karakter, value 0–256, key unik,
  tanpa awalan `aws:`, dan karakter hanya huruf/angka/spasi (semua aksara) serta `+ - = . _ : / @`. Di luar itu →
  `InvalidTag` (400).
- GetObject (bukan HEAD) dengan tanda tangan mengirim `x-amz-tagging-count`. Pembaca anonim di bucket publik tidak
  melihat tag (`?tagging` → 403, tanpa header hitungan).
- Izin (ADR-071): GetObjectTagging butuh `read`; Put/DeleteObjectTagging butuh `write`. Tag bucket
  (`PutBucketTagging`) tetap `NotImplemented`.
- **Lifecycle** (ADR-072) mendapat filter `Tag` (sendiri) dan `Tag` di dalam `And` (bersama Prefix dan ukuran). Rule
  hanya mengenai objek yang punya **semua** tag-nya. `AbortIncompleteMultipartUpload` bersama Tag → `InvalidRequest`,
  seperti Amazon. Editor "Hapus otomatis" di `/s3` menampilkan rule bertag sebagai rule API, tanpa mengubahnya.

Test: `tests/integration/s3-tagging.test.ts`.

### 2. GetObject/HeadObject `?partNumber`
- Saat CompleteMultipartUpload, jumlah part dan ukuran part disimpan (langkah `v5`: `s3_objects.parts`, `part_size`).
  Semua part kecuali yang terakhir sama besar (aturan R2), jadi dua angka itu cukup untuk menghitung rentang part mana pun.
- `?partNumber=N` dilayani seperti Range: 206, `Content-Range` part itu, `Content-Length` part itu, ETag objek utuh,
  dan `x-amz-mp-parts-count` untuk objek multipart. Objek yang di-put sekali jalan = 1 part (part 1 = seluruh objek,
  tanpa hitungan part). Hasil CopyObject juga satu part.
- Error seperti Amazon: N di luar 1–10.000 → `InvalidArgument`; N lebih besar dari jumlah part → `InvalidPartNumber`
  (416); `Range` bersama `partNumber` → `InvalidRequest`. Objek multipart yang selesai sebelum langkah v5 (ETag `-N`,
  ukuran part tidak tercatat) → `InvalidRequest` dengan saran memakai Range.

Test: `tests/integration/s3-part-number.test.ts`.

### 3. Checksum
- **Diverifikasi:** `x-amz-checksum-crc32`, `-crc32c`, `-crc64nvme`, `-sha1`, `-sha256`. Nilainya boleh dikirim sebagai
  header, sebagai trailer aws-chunked yang disebut di `x-amz-trailer` (cara AWS SDK v3 terbaru mengirim CRC32 secara
  bawaan), atau cukup nama algoritmanya (`x-amz-sdk-checksum-algorithm`), lalu dihitung di sini. Berlaku untuk PutObject,
  UploadPart, dan body XML kecil. Nilai salah → `BadDigest` (400) dan tidak ada yang tersimpan; nilai yang bukan base64
  dengan panjang digest yang benar → `InvalidRequest`. Respons PutObject/UploadPart mengembalikan nilainya.
- **Cara menghitung** (`lib/checksums.ts`): CRC32/CRC32C slice-by-8 di JavaScript (±600 MB/s di HP pengembang), CRC64NVME
  dua tabel 32-bit, SHA-1/SHA-256 lewat `crypto.DigestStream` native di Workers (JS di dev). Vektor uji standar di
  `tests/unit/checksums.test.ts`.
- **Batas CPU:** Workers tidak punya CRC native. CRC memakan sekitar 1 ms CPU per MiB, sedangkan Workers Free memberi
  10 ms per request. Karena itu CRC pada body yang lebih besar dari `s3_checksum_crc_max_bytes` (8 MiB, cukup untuk part
  bawaan aws-cli/SDK) **tidak diperiksa dan tidak disimpan**: objek tetap tersimpan, hanya tanpa checksum. Di paket
  berbayar angka ini bisa dinaikkan. SHA-1/SHA-256 selalu diperiksa.
- **Disimpan** (langkah `v6`): `s3_objects.checksum_json` `{a, t, v, p?}`, `s3_uploads.checksum_json` `{a, t}`, dan
  `s3_upload_parts.checksum`. PutObject → `FULL_OBJECT`. Multipart memakai `x-amz-checksum-algorithm` dan `-type` saat
  dibuat, dengan bawaan dan pasangan seperti Amazon (CRC64NVME hanya FULL_OBJECT; SHA hanya COMPOSITE). Saat complete:
  COMPOSITE = checksum dari gabungan checksum part + `-N`; FULL_OBJECT = CRC part digabung secara matematis
  (crc_combine ala zlib, tanpa membaca ulang byte). Checksum part yang disebut di XML complete harus sama dengan yang
  diperiksa (`InvalidPart`), dan `x-amz-checksum-<alg>` di request complete dibandingkan dengan nilai utuhnya
  (`BadDigest`). Kalau ada part yang tidak diperiksa (CRC melewati batas), objeknya tidak punya checksum.
- **Dikembalikan** dengan `x-amz-checksum-mode: ENABLED` di GetObject/HeadObject: untuk objek utuh, atau part N dari
  objek COMPOSITE (nilai part itu). Range biasa tidak membawa checksum. ListParts menampilkan checksum tiap part.
- **GetObjectAttributes** (`?attributes`, keluar dari `UNSUPPORTED_SUB`): `ETag`, `Checksum`, `ObjectParts` (jumlah
  part, ukuran, dan checksum part kalau COMPOSITE; `x-amz-max-parts` / `x-amz-part-number-marker`), `StorageClass`,
  `ObjectSize`. Butuh izin `read`; anonim ditolak.
- **CopyObject** membawa checksum FULL_OBJECT sumber (byte-nya sama), membuang COMPOSITE (salinan = satu part), dan
  `x-amz-checksum-algorithm` di CopyObject → `NotImplemented` (perlu membaca ulang seluruh byte).
- Objek tanpa checksum dari klien tidak diberi checksum. Berbeda dari Amazon, yang sekarang menghitung CRC64NVME untuk
  semua objek; di sini itu terlalu mahal CPU.

Test: `tests/unit/checksums.test.ts`, `tests/integration/s3-checksums.test.ts`.

## ADR-077 — R2: Drive pribadi dibaca dari index R2; app menarik index dulu

Tanggal: 2026-10-29. Status: diterima (pemilik: "Kerjakan roadmap yang sangat dibutuhkan oleh plan lain"). R2 adalah
langkah fase R berikutnya, dan D6, D11, R8 menunggunya (D7, D8, dan D10 lewat D6/D8).

**Konteks.** Sejak R3 (ADR-074) setiap perubahan pohon pribadi ditulis ke `u/{userId}/index.txt`, tapi app, API v1, dan
semua klien masih membaca D1. R2 memindahkan bacaan ke index: explorer, detail, breadcrumb, cari, bintang, Sampah, dan
klien menarik index lebih dulu (ADR-064 keputusan 5).

**Keputusan:**
- **Satu implementasi tampilan untuk Worker dan app** (`src/shared/drive-tree.ts`, `DriveTree`): isi folder (folder
  dulu, urut nama/diubah/ukuran/jenis, naik/turun, id sebagai pemecah seri seperti D1), halaman dengan cursor (format
  cursor sama dengan D1), node dan jalur dari akar, cari, berbintang, Sampah. `NodeDto`/`Crumb` Worker dan app sekarang
  alias tipe `DriveNode`/`DriveCrumb` di sana, dan `nameKey` dipindah ke sana. Id yang dipakai app dan API tetap id D1
  (kolom `x`) sampai R8; nomor entri tidak pernah keluar.
- **`GET /api/drive/index` dan `GET /api/v1/drive/index`** (scope `drive.read`, OpenAPI `text/plain`): index pribadi apa
  adanya. Kalau index tidak tertinggal, ini R2 yang di-stream ke klien (CPU Worker hampir nol, Cloudflare yang
  mengompres) dengan `ETag` R2; `If-None-Match` yang cocok → 304. Header `X-Drive-Owner` dan `X-Drive-Trash-Days`
  memberi klien yang dibutuhkan untuk membaca index seperti API membacanya. Akun yang ditangguhkan (SPEC §12.5) ditolak
  `ACCOUNT_SUSPENDED`, sama seperti `requireNode`.
- **Tidak pernah tertinggal dari perubahan orang itu sendiri.** Index menyusul D1 sedetik kemudian (R3), jadi setiap
  bacaan mengecek tanda user di `manifest_dirty` (satu query D1 bersama status langganan). Tanpa tanda: index di R2
  dipakai. Ada tanda (menunggu atau sedang di-flush): index dibaca, pohon D1 diproyeksikan ke atasnya di memori
  (`project` yang sama dengan flush), dan hasilnya dipakai untuk jawaban ini saja, **tanpa ETag dan tanpa tulis**.
  Tulisnya tetap oleh flush perubahan itu, jadi batas 1 tulis/detik per key tidak terpakai oleh bacaan. Pengecekan ini
  hilang di R8, saat perubahan langsung menulis index.
- **Route yang membaca index** (`services/drive-read.ts`): `GET /nodes/:id` dan `/nodes/:id/children` (app dan v1)
  memakai index bila node itu ada di index orang itu sendiri, jadi akses tidak perlu dicek ke D1 (index ada di
  `u/{userId}/`). Selain itu (folder keluarga, upload yang masih berjalan, id orang lain) jalan lewat D1 seperti dulu,
  termasuk 404 untuk id orang lain. Cari, Berbintang, dan Sampah menggabungkan hasil pribadi dari index dengan hasil
  keluarga dari D1 (keluarga = R4). Terbaru tetap di D1 (ADR-064 mengusulkan pindah ke klien; belum diputuskan).
  Mengosongkan Sampah dan semua tulis tetap di D1; jawaban tulis (DTO setelah perubahan) tetap dari D1.
- **App menarik index dulu** (`src/web/lib/drive-index.ts`): `listChildren` di app menjawab folder pribadi dari index
  (satu request, 304 kalau tidak berubah, permintaan bersamaan digabung), dipakai explorer, dialog pindah, dekorasi, dan
  video. Folder keluarga, halaman berikutnya, dan index yang gagal dibaca jatuh ke API. Detail (panel Info) dan Sampah
  tetap lewat API, yang juga membaca index.
- **Rincian pindai menempel di isi, bukan di index** (ADR-064): index hanya tahu siap/dipindai/diblokir. Daftar memakai
  `clean`/`pending`/`infected` dari situ; detail satu file (`/nodes/:id`) mengambil `scan_status` blob-nya, supaya label
  "Tidak dipindai penuh" atau "Gagal dipindai" tetap benar. Di R8 ini pindah ke metadata objek isi.
- **Header index mendapat `rootAt`** (detik folder akar dibuat): akar bukan entri, dan detail/akar di API v1 perlu
  tanggalnya. Nama akar tetap `PERSONAL_ROOT_NAME` (app menampilkan kata-katanya sendiri).

**Yang berubah bagi klien (sengaja):**
- Waktu (`createdAt`, `updatedAt`, `trashedAt`, …) dari index dalam detik penuh (format ADR-064), bukan milidetik.
- `purgeAt` = dibuang + masa simpan Sampah yang berlaku sekarang (index tidak menyimpan tanggal hapusnya sendiri).
- Berbintang diurutkan dari yang terakhir berubah (index tidak menyimpan kapan bintang diberi).
- File yang dikarantina takedown tampil `rejected` di daftar (dulu `ready` dengan `scanStatus` `quarantined`), sama
  seperti di index (`st = 2`).
- Cari meniru FTS5 `unicode61 remove_diacritics 2` di JavaScript: setiap kata query harus jadi awalan salah satu kata
  nama, aksen diabaikan, paling banyak 8 kata.

**Shim R2 dev diperbaiki.** Dulu `put` mengganti file data lalu file meta, jadi pembaca di tengahnya mendapat isi baru
dengan ukuran lama ("drive index: truncated"). Bacaan index yang berbarengan dengan flush memunculkannya. Sekarang setiap
versi punya file data sendiri, meta diganti dengan satu `rename`, dan data lama dihapus 30 detik kemudian. Sama seperti
R2: pembaca mendapat objek lama atau baru, tidak pernah campuran.

**Biaya.** Index tidak tertinggal: satu batch D1 kecil + satu baca R2 (304 tanpa body). Tertinggal: ditambah baca pohon
D1, seperti flush tanpa tulis. Route API di Worker mengurai seluruh index (angka ADR-064: ±2,6 ms per 1.000 entri di HP
pengembang); app mengurai di browser. Pohon yang sangat besar di Workers Free tetap dicatat di ADR-064.

**Belum:** index keluarga (R4); Terbaru; menghapus pembacaan D1 yang tersisa dan pengecekan `manifest_dirty` (R8).

Test: `tests/unit/drive-tree.test.ts`, `tests/integration/drive-read.test.ts` (sama dengan D1 untuk setiap urutan dan
arah, cursor, ETag/304, bacaan saat tertinggal lalu sesudah flush, user tanpa index, id orang lain, akun ditangguhkan,
API v1 + OpenAPI), `tests/integration/idor.test.ts` (index orang lain), `tests/integration/shims.test.ts` (baca saat
ditimpa).

## ADR-078 — R4: index keluarga `f/{familyId}/index.txt`, dan ruang keluarga dibaca dari situ

Tanggal: 2026-10-29. Status: diterima (pemilik: "Langsung kerjain roadmap yang dependencynya udah dikerjakan"). R4
membuka D2 dan R8.

**Keputusan:**
- **Proyeksi D1 seperti R3** (`drive-index-sync.ts`, `readFamilyTree`, `writeFamilyIndex`): node `space = 'family'`
  milik keluarga itu, tanpa upload yang masih berjalan. Header: `root` (folder akar keluarga), `rootAt`, `used` (pool
  keluarga), dan **`members`**: user id anggota, pemilik keluarga di urutan pertama. Posisi dihitung dari 1 (0 = tidak
  ada). Anggota tidak pernah pindah posisi; yang keluar menjadi `null`, anggota baru ditambah di belakang
  (`memberSlots`). Entri memakai kolom ADR-064: `o` pemilik node, `e` anggota lain boleh mengedit, `tb` siapa yang
  membuangnya ke Sampah. Bintang tidak ada di index keluarga: bintang milik tiap anggota (tetap di D1 sampai pindah ke
  index anggota itu).
- **Tanpa tabel atau kolom D1 baru.** `manifest_dirty` hanya menerima user id (FK ke `users`), jadi index keluarga tidak
  punya tanda sendiri: **flush seorang anggota juga menulis index keluarganya**. Setiap perubahan di ruang keluarga
  sudah menandai seorang anggota (pemilik node, yang bertindak, atau pemilik keluarga): node keluarga selalu dimiliki
  anggota (yang keluar menyerahkan miliknya ke pemilik keluarga). Yang ditambah: `markBlobOwnersDirty` dan dekorasi
  folder kini menandai pemilik node keluarga juga, anggota yang keluar menandai pemilik keluarga (flush yang keluar tidak
  lagi mencapai index keluarga), dan keluarga yang bubar menghapus indexnya. Dua anggota yang flush bersamaan aman lewat
  tulis bersyarat etag. Migrasi data `0021` menandai pemilik setiap keluarga supaya index pertamanya ditulis.
- **Dibaca dari index** (`drive-read.ts`): detail dan isi folder mencari node di index pribadi, lalu di index keluarga.
  Satu query D1 memberi keanggotaan, peran, kunci pool keluarga (SPEC §12.5), dan "tertinggal" (ada anggota yang
  bertanda). Hak akses dihitung seperti `nodeAccess`: pemilik keluarga atau pembuat node boleh semua; anggota lain boleh
  melihat dan menambah, mengedit hanya kalau `e`. Index hanya menyimpan pemilik node, dan di ruang keluarga pemilik =
  pembuatnya (upload dan pindah ke keluarga), kecuali file anggota yang keluar, yang pindah ke pemilik keluarga; di sana
  hasil hak aksesnya tetap sama karena pemilik keluarga memang boleh semua. Test membandingkan setiap hak dengan
  `nodeAccess` untuk setiap anggota.
- **Cari** membaca index pribadi dan index keluarga (FTS5 D1 tidak dipakai lagi; `ftsQuery` dibuang, tabel `nodes_fts`
  dihapus di R8). **Sampah** keluarga dari index: hanya yang dibuang anggota itu sendiri (`tb`), seperti dulu.
  **Berbintang** keluarga tetap D1.
- **`GET /api/drive/index?space=family`** (dan `/api/v1/drive/index?space=family`): index keluarga orang itu, 404 kalau
  bukan anggota keluarga mana pun. App menarik index keluarga hanya saat folder yang dibuka tidak ada di index pribadi
  (`treeHolding`), dengan ETag/304 yang sama.

**Belum:** bintang keluarga dan Terbaru (masih D1); tanggal hapus otomatis dan riwayat versi (D12, D1) akan memakai index
ini; R8 menghapus pengecekan `manifest_dirty` dan tabel D1.

Test: `tests/integration/drive-family-index.test.ts` (urutan anggota, ditulis oleh anggota mana pun, pemilik/izin
edit/pembuang, sama dengan D1 termasuk hak akses tiap anggota, cari, Sampah per anggota, 304, orang luar 404, anggota
keluar, keluarga bubar), `tests/integration/browse.test.ts`.
