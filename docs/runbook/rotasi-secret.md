# Runbook: rotasi secret

Semua secret hanya lewat `npx wrangler secret put NAMA --env <staging|production>`. Jangan pernah ditaruh di
repo, chat, atau log. Isi nilai acak: `openssl rand -base64 48`.

| Secret | Efek rotasi | Cara aman |
|---|---|---|
| `SHARE_LINK_SECRET` | Semua link share lama mati | Pindahkan nilai lama ke `SHARE_LINK_SECRET_PREV`, pasang nilai baru, biarkan beberapa minggu, lalu hapus `_PREV` |
| `DOWNLOAD_SECRET` | Link unduh `/d/`, `/z/`, token iklan, dan cookie password share yang sedang berlaku jadi tidak valid | Langsung ganti; link itu memang berumur pendek |
| `PREVIEW_SECRET` | Pratinjau yang sedang dibuka gagal dimuat | Langsung ganti |
| `BETTER_AUTH_SECRET` | Semua pengguna logout | Ganti di jam sepi; umumkan kalau perlu |
| `IP_HASH_SECRET` | Hash IP berganti (dedupe hitungan unduhan hari itu reset) | Langsung ganti |
| `PAYMENT_WEBHOOK_SECRET` | Webhook gateway ditolak | Ganti di dashboard gateway dan di Worker dalam satu waktu; event yang terlewat dikirim ulang oleh gateway |
| `TELEGRAM_WEBHOOK_SECRET` | Update bot ditolak | Ganti, lalu daftarkan ulang webhook (`setWebhook` dengan `secret_token` baru) |
| `TELEGRAM_BOT_TOKEN` | Bot berhenti | `/revoke` di @BotFather, pasang token baru, daftarkan ulang webhook |
| `CONTACTS_ENC_KEY` | Kontak terenkripsi yang tersimpan tidak bisa dibaca | **Jangan dirotasi tanpa migrasi re-enkripsi.** Kalau bocor: hapus kontak tersimpan, lalu ganti kunci |
| `GOOGLE_CLIENT_SECRET` | Login Google gagal sampai diganti | Buat secret baru di Google Cloud Console, pasang, hapus yang lama |
| `TURNSTILE_SECRET_KEY` | Login/laporan gagal sampai diganti | Rotasi di dashboard Turnstile, pasang nilai baru |

Setelah rotasi: cek `/api/health`, coba login, buat link share, dan unduh satu file.
