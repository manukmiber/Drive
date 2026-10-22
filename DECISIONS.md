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
