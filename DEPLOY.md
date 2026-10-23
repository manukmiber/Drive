# Deploy Zeiko ke Cloudflare

Ringkasnya: **kamu login, aku yang setup.** Semua resource dibuat oleh satu skrip yang aman diulang.

## 1. Yang perlu kamu siapkan (sekali saja)

| | Kenapa |
|---|---|
| Akun Cloudflare dengan **Workers Paid** ($5/bulan) | Pengiriman email OTP ke alamat siapa pun dan Containers (ClamAV) hanya ada di paket ini. |
| Domain **zeiko.biz.id** aktif di akun itu | App dipasang di `drive.zeiko.biz.id` (production, ADR-038; root `zeiko.biz.id` milik website) / `staging.zeiko.biz.id`, plus `uc.` / `uc-staging.` untuk pratinjau file (origin terpisah demi keamanan). |
| **Email Service**: domain pengirim `zeiko.biz.id` terverifikasi | Untuk mengirim kode masuk dari `no-reply@zeiko.biz.id`. Ikuti panduan di dashboard → Email. |
| R2 diaktifkan (dashboard → R2 → Enable) | Tempat file disimpan (bucket privat, tidak pernah publik). |

Opsional (bisa menyusul): OAuth Google (login "Lanjut dengan Google"), bot Telegram (kirim file &
notifikasi), Turnstile (anti-spam form email), payment gateway sungguhan (sekarang masih **mock**).

## 2. Login

Jalankan di terminal proyek (pakai `!` di depan supaya hasilnya muncul di percakapan):

```bash
! export PATH=/opt/node22/bin:$PATH && npx wrangler login --browser=false
```

Buka link yang muncul, setujui, selesai. Alternatif: buat API token (template "Edit Cloudflare
Workers" + izin D1, R2, Queues, KV, Email) lalu `export CLOUDFLARE_API_TOKEN=…`.

## 3. Setup + deploy (aku yang jalankan)

```bash
node scripts/cf-setup.mjs staging --dry-run   # lihat dulu apa yang akan dibuat
node scripts/cf-setup.mjs staging             # buat resource, migrasi, deploy, isi secret
```

Skrip ini:
1. membuat D1 `zeiko-staging`, KV `zeiko-config-staging`, R2 `zeiko-staging`, Queues `zeiko-*-staging`;
2. menulis ID-nya ke `deploy/staging.json` lalu meregenerasi `wrangler.jsonc`;
3. menerapkan migrasi database;
4. build + deploy Worker;
5. mengisi secret yang belum ada dengan nilai acak (tidak pernah ditampilkan).

Production sama persis (`production`), tapi **hanya setelah kamu bilang oke** dan staging sudah dicoba.

### Tanpa Docker (HP ini)
Image ClamAV butuh Docker untuk di-build. Dari HP, skrip otomatis memakai **scanner bawaan**
(hash + file uji EICAR + daftar blokir). Untuk ClamAV penuh: push repo ke GitHub, isi secret
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` dan variable `STAGING_DEPLOY_ENABLED=true`; CI akan
mem-build dan deploy container. Setelah itu: `node scripts/cf-setup.mjs staging --containers-ready`.

Container `archiver` (zstd, `standard-2`) juga ikut. Tanpa container itu, opsi TAR.ZST dan ZIP terkompres
> 2 GB disembunyikan otomatis. Disarankan menambah lifecycle R2 sebagai cadangan pembersihan file sementara:
`npx wrangler r2 bucket lifecycle add zeiko-staging tmp-1d tmp/ --expire-days 1`.

Container `media` (ffmpeg, `standard-2`) ikut ter-build bersama scanner. Selama belum ada, kompres foto
≤ 20 MB dan video ≤ 60 detik tetap jalan lewat Images/Media Transformations; file yang lebih besar
ditolak dengan alasan "terlalu besar" tanpa memotong kredit. Images dan Media Transformations perlu
diaktifkan sekali di dashboard (Images → Transformations, Stream → Media Transformations).

### Domain lain
Production sudah memakai `drive.zeiko.biz.id` (ADR-038). Alamat lain bisa diberikan dengan
`--app-origin https://… --uc-origin https://…`; pakai subdomain satu tingkat saja (sertifikat universal
Cloudflare tidak mencakup `a.b.zeiko.biz.id`). Setelah alamat berubah, ganti juga URL Drive di relay
(Zeiko Drive → Setup) supaya callback pembayaran dan layar ops sampai.

## 4. Setelah deploy

- Buka app, masuk dengan email kamu, lalu jadikan admin:
  `npx wrangler d1 execute zeiko-staging --remote --env staging --command "UPDATE users SET role='admin' WHERE email='EMAIL_KAMU'"`
- Panel admin `/admin` wajib passkey atau TOTP (atur di Pengaturan).
- Pembayaran masih **simulasi** (`/dev/pay/…`, hanya di staging). Untuk production, pilih gateway
  (Midtrans/Xendit/Tripay/Duitku) lalu aku pasang adapternya.
- Hapus akun menunggak (H+37) default **dry-run**: hanya dicatat. Ganti `dunning_delete_mode` ke `live`
  dari admin kalau sudah yakin.

## Secret

| Nama | Diisi oleh |
|---|---|
| `BETTER_AUTH_SECRET`, `DOWNLOAD_SECRET`, `SHARE_LINK_SECRET`, `PREVIEW_SECRET`, `CONTACTS_ENC_KEY`, `IP_HASH_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET` | otomatis (acak) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | kamu, kalau mau login Google |
| `TELEGRAM_BOT_TOKEN` (+ var `TELEGRAM_BOT_USERNAME`) | kamu, dari @BotFather |
| `TURNSTILE_SECRET_KEY` (+ var `TURNSTILE_SITE_KEY`) | kamu, dari dashboard Turnstile |
| `SHARE_LINK_SECRET_PREV` | hanya saat rotasi secret link share |
| `CF_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID` | kamu, untuk tab R2 storage di relay (ADR-037): token API Cloudflare dengan izin **Account Analytics: Read**, plus account id-nya. Tanpa keduanya, tab itu memakai hitungan Drive sendiri dan operasi A/B tidak diketahui. |

Mengganti `SHARE_LINK_SECRET` membuat semua link share lama mati, kecuali nilai lamanya dipindah ke
`SHARE_LINK_SECRET_PREV` dulu.
