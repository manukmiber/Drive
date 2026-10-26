# PLAN — Zeiko Cloud Storage

Rencana teknis per fase. Detail fitur ada di `docs/SPEC.md` (nomor bagian ditulis "§").
Status harian ada di `PROGRESS.md`, keputusan arsitektur di `DECISIONS.md`.

## Arsitektur singkat

```
Browser (React SPA, PWA) ──► Worker utama (Hono)
                              ├─ fetch:   /api/*, /d/:token/:name, /{r64}/{s32}/{name}, /ad/*, host uc.* (pratinjau)
                              ├─ queue:   scan, archive, compress, notify, cleanup
                              └─ scheduled: 17:05 UTC (00:05 WIB), tiap jam, 19:00 UTC (02:00 WIB)
Binding: D1 (DB) · R2 (BUCKET) · KV (CONFIG_KV) · Queues · Analytics Engine · Rate Limiting ·
         Images · Media · Email · Containers (scanner/media/archiver) · Static Assets
```

> **Arah baru (ADR-064, pemilik 2026-10-26):** Drive tidak memakai D1. Pohon file = satu index per user/keluarga di R2
> (`u/{userId}/index.txt`, `f/{familyId}/index.txt`); akun, paket, pembayaran di relay; binding D1 tinggal untuk Zeiko S3.
> Diagram di atas menggambarkan kode sekarang; pindahnya lewat fase R di `docs/ROADMAP.md`.

Lapisan kode Worker:
- `routes/` — HTTP (validasi Zod, auth, mapping error) → memanggil `services/`.
- `services/` — logika bisnis murni di atas D1/R2 (tanpa Hono), mudah dites.
- `adapters/` — semua pihak ketiga di balik interface + implementasi `mock`
  (EmailSender, PaymentProvider, Scanner, CsamDetector, TelegramClient, WhatsAppClient, Clock).
- `queues/`, `cron/` — consumer & job terjadwal, memanggil `services/`.
- `db/schema.ts` — skema Drizzle; `migrations/*.sql` — DDL.

Lokal: `dev/` berisi shim binding (ADR-001). `npm run dev` menjalankan API Node + Vite.

## Fase

### Fase 0 — Fondasi
- Tooling: TS strict, ESLint, Prettier, Vitest, Vite + React + Tailwind.
- `wrangler.jsonc` dengan env `staging` & `production` (dev = lokal), semua binding & cron.
- Migrasi awal seluruh model §4 + FTS5 + trigger; seed katalog Lampiran A/B (migrasi) + seed demo (dev).
- Shim binding + dev server; adapter interface + mock; config loader (`app_config` → KV cache).
- Kerangka Worker (health, config publik, error handler, host routing USERCONTENT) dan kerangka SPA.
- CI GitHub Actions: lint, typecheck, test, build, `wrangler deploy --dry-run`; deploy staging manual/branch.
- **Risiko:** shim ≠ produksi → test kontrak shim + dry-run di CI.

### Fase 1 — Auth & akun
- Better Auth (D1 via Drizzle adapter): email OTP/magic link, Google OAuth, passkey, TOTP.
  Fallback: sesi sendiri + `arctic` (catat ADR kalau dipakai).
- Cookie `__Host-`, CSRF + cek Origin, role user/moderator/admin, admin wajib passkey/TOTP (diganti ADR-057: tidak ada admin di Drive).
- Storage pool pribadi dibuat saat user pertama login (limit 0 sampai beli paket, §16 #9).
- Halaman Masuk, Profil, Pengaturan dasar.
- **Risiko:** Better Auth + passkey di Workers (WebAuthn butuh `crypto.subtle`; cek kompatibilitas).

### Fase 2 — Upload & download inti
- Reservasi kuota atomik (§4), protokol multipart (§5.2), simple upload, abort, resume (GET status).
- Download bertanda tangan `/d/:token/:filename`: HEAD, Range, ETag, If-None-Match, If-Range,
  Content-Disposition RFC 6266/5987.
- Explorer dasar: folder root per ruang, CRUD folder, grid/list, Sampah (pulihkan/hapus permanen).
- Klien: panel upload (paralel 4 part, 3 file), retry backoff+jitter, resume via IndexedDB, thumbnail browser.
- **Risiko:** konkurensi part di R2; stream body tanpa buffer; test konkurensi kuota.

### Fase 3 — Pipeline scan
- Queue `scan` → adapter `Scanner` (mock: SHA-256 + CRC32 streaming, deteksi EICAR; `container`:
  ClamAV di Container `scanner`). Blocklist hash, infected → hapus + lepas kuota + notifikasi.
- **Risiko:** file besar → streaming hashing di container, retry 3× + alert.

### Fase 4 — Explorer lengkap
- FTS5 search, pratinjau via USERCONTENT_ORIGIN (URL bertanda tangan pendek), bintang, Terbaru,
  shortcut, drag-drop, panel detail, virtualisasi 10.000 item, PWA + Web Share Target.

### Fase 5 — Share
- Link `/{r64}/{s32}/{nama}` (verifikasi HMAC sebelum D1, rotasi secret), bot preview OG,
  password + cookie path, statistik, QR, deeplink WA/TG, bot Telegram, email via Queue `notify`.

### Fase 6 — Download banyak file
- ZIP store streaming deterministik + Range (ZIP64, UTF-8), ZIP deflate stream ≤ 2 GB,
  job async `archive` → Container `archiver` (tar.zst/zip besar), hasil di `tmp/archives/`.

### Fase 7 — Billing
- Saldo (wallet ledger append-only), PaymentProvider mock, langganan + pro-rata, add-on, invoice,
  siklus tunggakan (fake clock), dry-run job hapus.

### Fase 8 — Paket keluarga
- Pool bersama, ruang Pribadi/Keluarga, izin (§9.2), undangan, keluar/dikeluarkan, matriks test izin.

### Fase 9 — Kompres media
- Kredit (ledger, FIFO kedaluwarsa), Images binding (≤ 20 MB), Media binding (≤ 60 s, < 100 MB),
  Container `media` (sisanya), standalone `tmp/compress/`, batch.

### Fase 10 — Iklan lokal
- Area Kemendagri + alias CF, inventori harian (cron), hold 15 menit, booking, moderasi, penayangan
  adil + cache 60 s, impresi/klik tanpa ID user, dashboard pengiklan.

### Fase 11 — Admin & moderasi
- Dashboard biaya vs pendapatan (Lampiran B + tarif komponen), pengguna, laporan & takedown + SLA,
  pemindai, iklan, config editor, audit log viewer.

### Fase 12 — Hardening & rilis
- E2E Playwright, k6 download, audit keamanan §14, Lighthouse mobile ≥ 90, draf kebijakan,
  `docs/LAUNCH-CHECKLIST.md`, deploy staging. Production hanya setelah pemilik setuju.

## Risiko lintas fase
| Risiko | Mitigasi |
|---|---|
| Tidak bisa menjalankan workerd lokal | Shim + dry-run di CI (ADR-001) |
| Batas D1 10 GB per database | ID ULID, query selalu ber-scope `pool_id`/`user_id` agar bisa di-shard per pool |
| Biaya Container | Hanya untuk kasus di luar batas binding; dicatat per job |
| Kepatuhan (UU PDP, PSE, CSAM) | Draf kebijakan + LAUNCH-CHECKLIST, adapter CSAM mock dulu |
| Secret | Hanya `wrangler secret` / `.dev.vars` (di-ignore) |
