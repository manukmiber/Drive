# PROGRESS — Zeiko Cloud Storage

Centang item yang sudah selesai (kode + test hijau + commit). Lihat `PLAN.md` untuk detail tiap fase.

## Fase 0 — Fondasi
- [x] Dokumen: `docs/SPEC.md`, `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `CLAUDE.md`
- [x] Tooling: TypeScript strict, ESLint, Prettier, Vitest
- [x] `wrangler.jsonc` (staging/production) + semua binding + cron
- [x] Skema Drizzle + migrasi awal (§4) + FTS5
- [x] Seed katalog Lampiran A/B + seed demo dev
- [x] Shim binding lokal (D1, R2, KV, Queues, RL, AE, Images, Media, Email)
- [x] Adapter interface + mock (Email, Payment, Scanner, CSAM, Clock)
- [x] Config loader (`app_config` + cache KV)
- [x] Kerangka Worker (fetch/queue/scheduled, error handler, host USERCONTENT)
- [x] Kerangka SPA (React + Router + Query + Tailwind, string UI terpusat)
- [x] `npm run dev` jalan lokal dengan semua adapter mock
- [x] CI GitHub Actions

## Fase 1 — Auth & akun
- [x] Better Auth: email OTP (magic link tidak dipakai; OTP cukup)
- [x] Google OAuth (aktif otomatis kalau `GOOGLE_CLIENT_ID/SECRET` diisi — belum dites dengan kredensial asli)
- [x] Passkey (daftar/hapus di Pengaturan, masuk dengan passkey — perlu dites manual di browser)
- [x] TOTP + admin wajib 2FA (level akun, ADR-019)
- [x] Cookie `__Host-`, cek Origin + CSRF
- [x] Storage pool pribadi saat daftar
- [x] Halaman Masuk, Profil, Pengaturan

## Fase 2 — Upload & download inti
- [x] Reservasi kuota atomik + test konkurensi
- [x] API multipart (init/part/status/complete/abort) + simple upload
- [x] Cron bersihkan upload kedaluwarsa
- [x] Download bertanda tangan (HEAD, Range, ETag, If-Range, Content-Disposition)
- [x] Explorer dasar: folder, CRUD, grid/list, Sampah
- [x] Panel upload klien (paralel, retry, resume IndexedDB, thumbnail) — **belum diuji di browser sungguhan**

### Sisa Fase 2 / catatan untuk sesi berikutnya
- Uji manual di Chrome desktop + Android: upload 5 GB, jeda/lanjut, refresh, putus jaringan, IDM/aria2c 8 koneksi (DoD §5.4).
- Thumbnail saat ini disajikan dari APP_ORIGIN (WebP tervalidasi + nosniff); pindahkan ke USERCONTENT_ORIGIN bertanda tangan di Fase 4.
- Cache edge (Cache API) untuk download belum dibuat (config default OFF, ADR-007).
- Satu warning lint `react-hooks/exhaustive-deps` di `Drive.tsx` (dependensi tipe saja).

## Fase 3 — Pipeline scan
- [x] Queue `scan` + adapter Scanner (mock + Container `scanner` Go/ClamAV — image belum di-build, butuh Docker di CI)
- [x] SHA-256 + CRC32 tersimpan, blocklist hash
- [x] Infected → hapus, kuota kembali, notifikasi (baris `notifications`; kirim email/Telegram di Fase 5)

## Fase 4 — Explorer lengkap
- [ ] Pencarian FTS5
- [ ] Pratinjau USERCONTENT_ORIGIN
- [ ] Bintang, Terbaru, panel detail, shortcut, drag-drop
- [ ] Virtualisasi 10.000 item
- [ ] PWA + Web Share Target

## Fase 5 — Share
- [ ] Link r64/s32 + verifikasi tanpa D1
- [ ] Bot preview OG, password, statistik
- [ ] QR, deeplink WA/TG
- [ ] Bot Telegram
- [ ] Email share via Queue `notify`

## Fase 6 — Download banyak file
- [ ] ZIP store streaming + Range
- [ ] ZIP deflate stream
- [ ] Job async + Container `archiver`

## Fase 7 — Billing
- [ ] Saldo + ledger
- [ ] PaymentProvider mock + webhook idempoten
- [ ] Langganan, upgrade/downgrade, add-on
- [ ] Invoice
- [ ] Siklus tunggakan + dry-run hapus

## Fase 8 — Paket keluarga
- [ ] Pool bersama + ruang Keluarga
- [ ] Izin + matriks test
- [ ] Undangan, keluar/dikeluarkan

## Fase 9 — Kompres media
- [ ] Kredit + ledger
- [ ] Images binding / Media binding / Container media
- [ ] Standalone + batch

## Fase 10 — Iklan lokal
- [ ] Area + alias CF, inventori harian
- [ ] Booking + hold + pembayaran
- [ ] Moderasi, penayangan, impresi/klik
- [ ] Dashboard pengiklan

## Fase 11 — Admin & moderasi
- [ ] Dashboard biaya vs pendapatan
- [ ] Pengguna, config editor, audit log
- [ ] Laporan & takedown + SLA

## Fase 12 — Hardening & rilis
- [ ] E2E, k6, audit keamanan, Lighthouse
- [ ] Draf kebijakan + LAUNCH-CHECKLIST
- [ ] Deploy staging
