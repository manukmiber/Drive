# Checklist peluncuran (non-kode, untuk pemilik)

Centang sebelum production dibuka untuk umum (SPEC §14.6).

## Legal & kepatuhan
- [ ] Daftar **PSE Lingkup Privat** di Komdigi (OSS RBA) atas nama badan usaha/perorangan pemilik.
- [ ] Review hukum: Syarat & Ketentuan, Kebijakan Privasi, Kebijakan Konten, Kebijakan Iklan
      (`/kebijakan/*`). Label "DRAF" sudah dihapus atas permintaan pemilik (2026-10-26).
- [ ] Tetapkan alamat kontak abuse resmi (default di draf: `abuse@zeiko.biz.id`) dan pastikan kotak masuknya dipantau.
- [ ] Konfirmasi isian ToS/Kebijakan Privasi (ADR-045, `src/web/legal/contacts.ts`): dukungan & privasi
      `admin@zeiko.biz.id`, retensi log akses 90 hari, enkripsi saat disimpan (R2).
- [x] VirusTotal: dipakai dengan key pemilik (ADR-046), cek hash + kirim program yang belum dikenal.
- [ ] Ganti key VirusTotal gratis dengan lisensi Premium/komersial (rencana pemilik): ketentuan VirusTotal melarang
      Public API dipakai di layanan komersial, dan key gratis hanya 500 request/hari. Cukup ganti secret
      `VIRUSTOTAL_API_KEY` lalu naikkan `virustotal.per_minute`/`per_day` di config.
- [ ] Hive dan Thorn (Kebijakan Privasi §4, rencana pemilik): belum ada perjanjian/kode; teksnya menyebut keduanya.
- [x] Zeiko S3: paket dibayar di awal, minimal 3 GB, Rp500/GB (1 salinan) atau Rp1.250/GB (3 salinan sungguhan) per
      bulan, egress gratis 500 GB lalu Rp5.000/500 GB ditagih saat perpanjangan (ADR-047).
- [x] Zeiko S3: alamat sendiri, subdomain Zeiko Rp3.000 atau domain sendiri Rp5.000, sekali bayar (ADR-048).
- [ ] Zeiko S3: DNS `s3.zeiko.biz.id`, bucket replika lewat `cf-setup`, tombol relay, dan harga S3 di website.
- [ ] Zeiko S3 alamat sendiri: `CF_HOSTNAMES_TOKEN`, `zoneId`, Cloudflare for SaaS + fallback origin
      `custom-s3.zeiko.biz.id` (pemilik).
- [ ] Prosedur takedown: siapa yang piket untuk SLA 4 jam (CSAM/terorisme) dan 24 jam (lainnya).
- [ ] Runbook kebocoran data: siapa memutuskan, template email pemberitahuan 3×24 jam.
- [ ] Perjanjian vendor deteksi CSAM (Hive/Thorn Safer/PhotoDNA) bila ingin mengaktifkan `features.csam_scan`.
- [ ] Aktifkan **Cloudflare CSAM Scanning Tool** di zona `zeiko.biz.id` (Dashboard → Caching → Configuration).

## Cloudflare
- [ ] Upgrade ke **Workers Paid** (Containers + kirim email ke alamat bebas).
- [ ] Domain email: SPF, DKIM, DMARC untuk `zeiko.biz.id`; verifikasi sender di Email Service.
- [ ] R2 diaktifkan; bucket tetap privat (jangan aktifkan r2.dev / public access).
- [ ] Jalankan `node scripts/cf-setup.mjs staging`, uji, lalu `production` (lihat `DEPLOY.md`).
- [ ] Aktifkan ClamAV (deploy container dari CI) sebelum production.
- [ ] Jadikan akun sendiri admin + daftarkan passkey/TOTP.

## Pembayaran
- [ ] Pilih payment gateway (Midtrans/Xendit/Tripay/Duitku) dan selesaikan verifikasi bisnis.
- [ ] Beri tahu aku untuk memasang adapter-nya (sekarang `mock`; production menolak pembayaran mock).
- [ ] Putuskan `payment_fee_paid_by` (default Zeiko menanggung biaya gateway) dan `tax_rate_pct`.
- [ ] Setelah yakin, ganti `dunning_delete_mode` dari `dry_run` ke `live`.

## Opsional
- [ ] Bot Telegram (@BotFather) → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, set webhook ke
      `https://zeiko.biz.id/api/integrations/telegram` dengan `secret_token` = `TELEGRAM_WEBHOOK_SECRET`.
- [ ] OAuth Google → `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (redirect `https://zeiko.biz.id/api/auth/callback/google`).
- [ ] Turnstile → `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`.
- [ ] WhatsApp Cloud API (butuh verifikasi bisnis Meta) — sekarang hanya deeplink.
- [ ] Harga paket keluarga & slot iklan (masih placeholder, §16 #3 dan #7).
