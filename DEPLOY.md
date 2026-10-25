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
| `ZEIKO_APP_TOKEN`, `ZEIKO_OPS_TOKEN` | relay, lewat **Zeiko Drive → Setup → Save and connect Drive**: isi account ID Cloudflare, token API dengan izin **Workers Scripts: Edit**, dan nama Worker (`zeiko-production`); relay membuat kedua secret dan memasangnya langsung ke Worker ini. Worker-nya harus sudah di-deploy. |
| `CF_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID` | untuk tab R2 storage di relay (ADR-037): token API Cloudflare dengan izin **Account Analytics: Read**. Isi di kolom "R2 analytics token" pada Setup yang sama; relay memasangnya ke Worker ini bersama account id, tanpa menyimpannya. Tanpa keduanya, tab itu memakai hitungan Drive sendiri dan operasi A/B tidak diketahui. |

| `S3_KEYS_ENC_KEY` | otomatis (acak, `cf-setup`): menyegel secret key Zeiko S3 (ADR-044). Mengganti nilainya membuat **semua** key S3 tidak bisa dipakai. |
| `CF_HOSTNAMES_TOKEN` | kamu (ADR-048): token API dengan *Zone → Workers Routes Edit, SSL and Certificates Edit, DNS Edit* untuk `zeiko.biz.id` dan *Account → Workers Scripts Edit*. Butuh juga `CF_ACCOUNT_ID` dan `"zoneId"` di `deploy/<env>.json`. Tanpa ini alamat S3 sendiri tidak ditawarkan. |
| `VIRUSTOTAL_API_KEY` | kamu (ADR-046): `npx wrangler secret put VIRUSTOTAL_API_KEY --env <env>`. Tanpa secret ini pemindaian berjalan tanpa VirusTotal. Key gratis: 4 request/menit, 500/hari; atur di config `virustotal`. |

Mengganti `SHARE_LINK_SECRET` membuat semua link share lama mati, kecuali nilai lamanya dipindah ke
`SHARE_LINK_SECRET_PREV` dulu.

## Zeiko S3 (ADR-044)

- Host-nya custom domain Worker ini: `s3.zeiko.biz.id` (production) dan `s3-staging.zeiko.biz.id` (staging),
  ganti lewat `s3Origin` di `deploy/{env}.json`. Subdomain satu tingkat saja (sertifikat universal). Alamat
  virtual-hosted (`bucket.s3.zeiko.biz.id`) butuh sertifikat wildcard tingkat dua, jadi klien memakai path-style.
- Sebelum dipakai: `node scripts/cf-setup.mjs <env>` (membuat `S3_KEYS_ENC_KEY` yang belum ada dan dua bucket
  replika `zeiko-s3-replica-a-<env>` di `weur` dan `-b-<env>` di `wnam`, lalu menulis `"s3Replicas": true` ke
  `deploy/<env>.json`), migrasi `0007` dan `0008` (`npm run db:migrate:<env>`), lalu deploy. Tanpa bucket replika,
  paket 3 salinan tidak ditawarkan.
- **Paket** (ADR-047): dibayar di awal di `/s3`, minimal 3 GB. Harga di config `s3_price_idr_per_gb_month` (1
  salinan), `s3_price_idr_per_gb_month_3x` (3 salinan), `s3_min_gb`, `s3_max_gb`, `s3_egress_*`, dan `s3_dunning`;
  penghapusan karena tidak diperpanjang ikut `dunning_delete_mode` (default `dry_run`).
- **Alamat sendiri** (ADR-048, opsional; semua langkah di zone oleh pemilik):
  1. subdomain Zeiko (`s3.<nama>.zeiko.biz.id`, Rp3.000): cukup `CF_HOSTNAMES_TOKEN`, `CF_ACCOUNT_ID`, dan
     `"zoneId": "<zone id zeiko.biz.id>"` di `deploy/<env>.json`, lalu `node scripts/gen-wrangler.mjs > wrangler.jsonc`
     dan deploy. Worker membuat custom domain-nya sendiri.
  2. domain sendiri (Rp5.000), tambahan: nyalakan **Cloudflare for SaaS** di zone `zeiko.biz.id`, buat record
     `custom-s3.zeiko.biz.id AAAA 100::` (proxied), jadikan *fallback origin*. Jangan pasang route `*/*`: Worker
     membuat route per domain sendiri. Setelah itu tambahkan `"s3CnameTarget": "custom-s3.zeiko.biz.id"` ke
     `deploy/<env>.json`, buat ulang `wrangler.jsonc`, dan deploy. Sebelum itu pilihan domain sendiri tidak muncul.
  Harga di config `s3_url_zeiko_idr`, `s3_url_custom_idr`, `s3_url_release_days`.
- Menyalakan akun tanpa paket (gratis, diberi operator): `POST /api/ops/s3/accounts {"zeikoId" | "email",
  "limitBytes", "reason"}` dengan bearer ops (tombol relay nanti). Orangnya harus sudah pernah masuk Drive.
- **Index sendiri per akun** (opsional, butuh kuota D1: Free 10 database per akun Cloudflare):
  1. `npx wrangler d1 create zeiko-s3-<env>-<nama>`;
  2. tambahkan `{"binding": "S3_DB_<NAMA>", "id": "<database_id>", "name": "zeiko-s3-<env>-<nama>"}` ke
     `s3Indexes` di `deploy/<env>.json`, lalu `node scripts/gen-wrangler.mjs > wrangler.jsonc` dan deploy;
  3. `PUT /api/ops/s3/accounts/<userId>/index {"binding": "S3_DB_<NAMA>", "reason": "…"}` selagi akunnya kosong.
  Jangan hapus entri `s3Indexes` yang masih dipakai: deploy tanpa binding itu membuat akunnya `ServiceUnavailable`.
