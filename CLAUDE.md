# CLAUDE.md — aturan proyek Zeiko Cloud Storage

Baca dulu: `docs/SPEC.md` (sumber kebenaran), `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`.

## Mesin ini
- HP Android (PRoot, aarch64). **workerd tidak bisa jalan** → jangan pakai `wrangler dev`,
  Miniflare, atau `vitest-pool-workers` lokal (ADR-001).
- Pakai Node Linux: `export PATH=/opt/node22/bin:$PATH` sebelum `npm`. Node Termux (`/data/data/com.termux/...`)
  melaporkan platform `android` dan merusak paket native.
- Wrangler remote (deploy, d1 remote, secret): `cfwrangler ...` atau `npx wrangler ...` dengan PATH di atas.
- Port 8787 dipakai layanan lain di mesin ini — jangan dimatikan. Dev API memakai 8790, Vite 5173.

## Perintah
| Tujuan | Perintah |
|---|---|
| Dev lokal (API + web, semua adapter mock) | `npm run dev` |
| Reset data lokal (DB, R2, KV) | `npm run dev:reset` |
| Lint / typecheck / test | `npm run lint` · `npm run typecheck` · `npm test` |
| Semua cek | `npm run check` |
| Build SPA | `npm run build` |
| Bundle check (seperti CI) | `npm run deploy:dry` |
| Deploy staging | `npm run deploy:staging` (butuh izin pemilik untuk pertama kali) |
| Migrasi remote | `npm run db:migrate:staging` |

Buka app lewat **http://localhost:5173** (bukan IP LAN): cookie `__Host-` butuh origin aman, dan
browser hanya menganggap `localhost` aman tanpa HTTPS. Akun demo: `demo@zeiko.local` (Plus),
`admin@zeiko.local` (admin, Max), `baru@zeiko.local` (tanpa paket); kode OTP muncul di log API.

Data dev ada di `.dev/` (di-ignore git). Mailbox mock: `GET http://localhost:8790/__dev/mail`.
Picu cron lokal: `POST http://localhost:8790/__dev/cron?cron=0%20*%20*%20*%20*`.

## Konvensi
- TypeScript strict. Tidak ada `any` tanpa komentar alasan.
- Kode/komentar English; **teks UI Bahasa Indonesia** santai & sopan, semua string UI di
  `src/shared/strings.id.ts`.
- Waktu = integer ms UTC (ADR-008). Uang = integer Rupiah. Ukuran = integer byte, GB = 2^30.
- Angka bisnis (harga, kuota, limit, masa tenggang) **tidak di-hardcode**: baca dari
  `app_config`/tabel katalog via `services/config.ts`. Default ada di `src/shared/config-defaults.ts`.
- Pihak ketiga selalu lewat `src/worker/adapters/*` dengan implementasi `mock`.
- Route tipis; logika di `services/` (bisa dites tanpa HTTP).
- Kode Worker hanya Web API — tidak boleh import `node:*` di `src/worker` atau `src/shared`.
- Setiap query data user di-scope `pool_id`/`owner_id`; cek izin node di service, bukan di route.
- Commit: Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`), per fase/sub-fase.
- Migrasi: sebelum deploy remote pertama boleh diubah; setelahnya **append-only** (file baru).
- Fitur di luar spec → catat dulu di `DECISIONS.md`.

## Larangan
- Jangan commit secret. Pakai `wrangler secret put` dan `.dev.vars` (di-ignore).
- Jangan kirim isi file user ke VirusTotal atau layanan luar mana pun.
- Jangan beri klien kredensial S3 atau presigned URL R2.
- Jangan dedup blob lintas pool/user.
- Jangan pasang iklan di jalur upload/download.
- Jangan deploy production, hapus resource remote, atau kirim pesan ke nomor/email sungguhan tanpa
  persetujuan pemilik.
