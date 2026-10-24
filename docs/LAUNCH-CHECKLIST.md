# Checklist peluncuran (non-kode, untuk pemilik)

Centang sebelum production dibuka untuk umum (SPEC §14.6).

## Legal & kepatuhan
- [ ] Daftar **PSE Lingkup Privat** di Komdigi (OSS RBA) atas nama badan usaha/perorangan pemilik.
- [ ] Review hukum: Syarat & Ketentuan, Kebijakan Privasi, Kebijakan Konten, Kebijakan Iklan
      (`/kebijakan/*`, sekarang berlabel "DRAF, perlu review hukum"). Hapus label setelah disetujui.
- [ ] Tetapkan alamat kontak abuse resmi (default di draf: `abuse@zeiko.biz.id`) dan pastikan kotak masuknya dipantau.
- [ ] Konfirmasi isian ToS/Kebijakan Privasi (ADR-045, `src/web/legal/contacts.ts`): dukungan & privasi
      `admin@zeiko.biz.id`, retensi log akses 90 hari, enkripsi saat disimpan (R2).
- [ ] Putuskan pemindaian pihak ketiga: Kebijakan Privasi menyebut VirusTotal (unggah file utuh), Hive, dan Thorn,
      sedangkan kode sekarang tidak mengirim isi file ke mana pun (aturan SPEC §14.2). Samakan teks atau aturannya.
- [ ] Zeiko S3: harga/batas paket (ToS §5), DNS `s3.zeiko.biz.id`, dan tombol relay untuk menambah akun.
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
