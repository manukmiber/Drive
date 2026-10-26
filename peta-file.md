# Peta file — Zeiko Drive, relay, dan website (per 2026-10-22)

Pendamping `handover.md`. Tanda **★** berarti baru atau berubah besar karena ADR-036: login lewat Akun Zeiko,
pembayaran lewat relay, app di `/dashboard`, dan EN/ID. Semua halaman dan komponen web juga pindah import string ke
`src/web/lib/i18n.ts`. Itu tidak ditandai satu per satu.

## A. Cari cepat: alur → file

| Alur | Drive | Relay | Website |
|---|---|---|---|
| Login (tiket SSO) | `src/web/lib/zeiko.ts`, `src/web/pages/SignIn.tsx`, `src/worker/auth.ts`, `src/worker/adapters/zeiko.ts`, `src/worker/routes/public-auth.ts` | `src/server/auth.rs` (`/v1/ticket`), `src/server/drive.rs` (`/apps/v1/tickets/redeem`) | `public/js/account/app.js` (`safeNext`) |
| Pintu tiruan di dev | `src/worker/routes/dev.ts` (`/__dev/door/*`) | — | — |
| Top-up Saldo / bayar | `src/worker/services/billing.ts`, `src/worker/routes/billing.ts`, `src/worker/routes/payments.ts`, `src/worker/adapters/zeiko.ts` | `src/server/drive.rs` (`/apps/v1/payments`, `tell`), `src/accounts/mod.rs` (`new_drive_payment`) | `public/js/account/{app,views}.js` (halaman QRIS, `driveBack`) |
| Callback pembayaran | `src/worker/routes/payments.ts` (`/api/payments/webhook/zeiko`) | `src/server/drive.rs` (`signature`, `tell`), `src/server/accounts.rs` (`notify_payment`) | — |
| Rekonsiliasi pembayaran | `src/worker/services/billing.ts` (`reconcilePayments`), `src/worker/cron/tasks.ts` | `GET /apps/v1/payments/{id}` di `drive.rs` | — |
| Layar Zeiko Drive di dashboard relay (semua kerja operator, ADR-057) | `src/worker/routes/ops.ts`, `src/worker/services/{admin,reports,ads}.ts` | `src/server/drive.rs` (`dashboard_routes`), `public/js/views/zeikodrive.js`, `public/js/api.js` | — |
| App di `drive.zeiko.biz.id` (ADR-038; dulu `/dashboard`) | `vite.config.ts`, `src/web/router.tsx`, `src/worker/app.ts`, `src/worker/lib/paths.ts`, `scripts/gen-wrangler.mjs`, `src/web/public/{sw.js,manifest.webmanifest}`, `src/web/lib/zeiko.ts` (`SITE_WAY_BACK`) | `drive.url`, `drive.returnPath` di `src/config.rs` | `src/worker.js`, `src/drive.js` (`isDrivePath`), `wrangler.jsonc` |
| Produk lain di sidebar | `src/web/components/AppShell.tsx`, `src/web/pages/AiDecision.tsx` | `/v1/account`, `/v1/key` di `src/server/auth.rs` + `site.rs` | — |
| EN/ID | `src/shared/strings.{id,en}.ts`, `src/web/lib/i18n.ts`, `src/worker/lib/lang.ts`, `src/worker/routes/me.ts` (`locale`), `migrations/0004_*` | — | `public/js/main.js` (cookie `zk_lang`), `public/id/drive.html` |
| Harga di website | `src/worker/routes/catalog.ts` (`/api/public/catalog`) | — | `src/drive.js` (`renderPlans`), `public/drive.html` |
| Upload | `src/web/upload/*`, `src/worker/routes/uploads.ts`, `src/worker/services/uploads.ts` | — | — |
| Batas transfer per perangkat (ADR-053) | `src/web/lib/{transfer,transfer-rules,transfer-guard}.ts`, `components/TransferSettings.tsx`, panel `components/UploadPanel.tsx` | — | — |
| Unduh file terpisah (ADR-053) | `src/web/download/{manager,sinks,names,browser,useDownloads}.ts`, `components/explorer/ArchiveDialog.tsx`, `POST /api/files/download-plan` (`routes/nodes.ts`, `services/download.ts`, `collectFiles` di `services/archive.ts`) | — | — |
| Download / share | `src/worker/routes/{download,share-public,shares,archive-download}.ts`, `src/worker/services/{download,shares,share-send}.ts`, `components/explorer/{ShareDialog,ShareSettings,ShareQr}.tsx` (ADR-054) | — | link share diteruskan oleh `src/worker.js` |
| Zeiko S3: CORS dan isi bucket (ADR-055) | `services/{s3-cors,s3-browse}.ts`, `routes/s3-api.ts` (`corsOp`, `preflight`), `routes/s3.ts`, `lib/s3-sigv4.ts` (`presignUrl`), `pages/{S3,S3Browser}.tsx` | — | — |
| Zeiko S3: statistik bucket dan log akses (ADR-060) | `services/s3-stats.ts` (`recordS3Request`, `deliverS3Logs`), `services/s3-index.ts` (v3), `routes/s3-api.ts` (`loggingOp`, akhir `handleS3`), `routes/s3.ts`, `pages/S3Stats.tsx`, `migrations/0013_s3_bucket_logging.sql` | — | — |
| Token akses + API v1 (ADR-061) | `services/tokens.ts`, `middleware/token.ts` (`tokenAuth`, `scope`), `routes/v1.ts`, `routes/tokens.ts`, `components/AccessTokens.tsx`, `migrations/0014_api_tokens.sql` | — | — |
| Editor foto/video/PDF (ADR-050, di browser) | `src/web/editors/*`, `src/web/pages/Tools.tsx` (`/alat`), menu di `components/explorer/useNodeActions.tsx`, tombol Edit + pdf.js di `Preview.tsx`, aset pdf.js di `vite.config.ts` | — | — |
| Editor teks/kode, dokumen, file baru (ADR-051) | `src/web/editors/{text,doc}/*`, `editors/sanitize.ts`, `editors/prose.css`, Baru → Dokumen / File teks di `components/NewMenu.tsx`, pratinjau `.docx` di `Preview.tsx` | — | — |

## B. Zeiko Drive — `/root/zeiko-cloud-storage`

### Akar repo
| File | Isi |
|---|---|
| `handover.md` ★ | Serah terima untuk sesi baru (baca pertama). |
| `peta-file.md` ★ | Dokumen ini. |
| `CLAUDE.md` ★ | Aturan proyek, perintah, konvensi (dua bahasa, `appPath`), larangan. |
| `docs/SPEC.md` | Sumber kebenaran fitur (Bahasa Indonesia, per bagian §). |
| `docs/ROADMAP.md` | Fitur Drive, Zeiko S3, dan API/SDK yang belum ada, dengan satu prompt per ID (`Kerjakan S1 dari docs/ROADMAP.md`). |
| `PLAN.md` | Rencana per fase. |
| `PROGRESS.md` ★ | Checklist fase + bagian "Zeiko Drive di Akun Zeiko". |
| `DECISIONS.md` ★ | ADR-001…036; ADR-036 = Akun Zeiko, dengan tambahan nama, `/dashboard`, dan EN/ID di bawahnya. |
| `DEPLOY.md` | Cara deploy (staging Free). Belum diperbarui untuk ADR-036. |
| `docs/SECURITY.md` | Audit keamanan §14. Belum diperbarui untuk login baru. |
| `docs/LAUNCH-CHECKLIST.md`, `docs/runbook/{kebocoran-data,rotasi-secret,takedown}.md` | Persiapan rilis dan runbook insiden. |
| `.dev.vars.example` ★ | Contoh var/secret dev, termasuk blok Zeiko (dikomentari). `.dev.vars` sendiri di-ignore. |
| `package.json` ★ | Skrip `dev`, `build` (menghapus `dist/web` dulu), `check`, `deploy:*`, `db:migrate:*`. |
| `vite.config.ts` ★ | `base: '/'`, outDir `dist/web`, proxy ke API 8790 (termasuk `/dashboard`, jalan pulang lama). |
| `wrangler.jsonc` | **Hasil generate**: `node scripts/gen-wrangler.mjs > wrangler.jsonc`. Jangan diedit langsung. |
| `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `drizzle.config.ts`, `tsconfig*.json` | Konfigurasi alat. |

### `scripts/`
| File | Isi |
|---|---|
| `gen-wrangler.mjs` ★ | Membuat `wrangler.jsonc` per env: var Zeiko (`ADAPTER_PAYMENT/ACCOUNTS`, `ZEIKO_DOOR_URL`, `ZEIKO_SITE_URL`, `APP_BASE_PATH`) dan aset `not_found_handling: 'none'`. |
| `cf-setup.mjs` | Setup Cloudflare idempoten (D1/KV/R2/Queue, secret acak). **Perlu diperbarui:** `OWNER_SECRETS` masih memuat Google dan belum memuat `ZEIKO_*`. |
| `dev.mjs`, `dev-reset.mjs` | Menjalankan API + Vite; menghapus data `.dev/`. |

### `migrations/` (append-only)
`0001_init.sql` skema awal · `0002_seed_catalog.sql` paket (Keluarga **nonaktif**) · `0003_seed_ad_areas.sql`
wilayah iklan · `0004_zeiko_accounts_locale.sql` ★ kolom `users.locale`.

### `src/shared/` (dipakai Worker dan web)
| File | Isi |
|---|---|
| `strings.id.ts` ★ / `strings.en.ts` ★ | **Semua teks UI.** Kuncinya sama dan dicek oleh tipe `Strings`. |
| `config-defaults.ts` ★ | Semua angka bisnis (metode bayar QRIS + crypto, biaya tetap, dst.). |
| `format.ts` ★ | Format angka, rupiah, tanggal; `setDateLocale`. |
| `qr.ts` | QR share dengan logo di tengah: `qrPlan`, `qrSvg`, `qrRaster` (ADR-059). Kanvasnya di web `lib/qr.ts`. |
| `constants.ts`, `enums.ts`, `time.ts`, `preview.ts`, `ad-policy.ts`, `legal.id.ts` | Konstanta, enum, waktu WIB, jenis pratinjau, kebijakan iklan, draf kebijakan. |

### `src/worker/` — inti
| File | Isi |
|---|---|
| `entry.ts`, `index.ts` | Entry wrangler: handler fetch/queue/scheduled + kelas Container. |
| `app.ts` ★ | Router Hono. Mount `/api/ops` sebelum `/api`, fallback SPA di root, `/dashboard/…` → `/…` (301). |
| `auth.ts` ★ | Better Auth + plugin `zeikoSignIn` (`/api/auth/zeiko/exchange`). Tanpa passkey/TOTP (ADR-057). |
| `env.ts` ★ | Tipe binding, var, dan secret (`ZEIKO_*`, `APP_BASE_PATH`). |
| `context.ts`, `types.ts`, `containers.ts` | Konteks per request, tipe Hono, Container DO. |
| `db/schema.ts` ★, `db/client.ts` | Mirror Drizzle dari SQL (+`locale`). |

### `src/worker/adapters/` (pihak ketiga, selalu ada mock)
| File | Isi |
|---|---|
| `zeiko.ts` ★ | `RelayZeikoAccounts`/`MockZeikoAccounts` (tiket) dan `ZeikoPaymentProvider` (charge, status, verifikasi HMAC). |
| `index.ts` ★ | Memilih adapter dari env; `zeikoReady`. |
| `payment.ts` ★ | Interface `PaymentProvider` + mock. |
| `email.ts`, `telegram.ts`, `scanner.ts`, `csam.ts`, `media.ts`, `archiver.ts`, `clock.ts` | Email, Telegram, rantai scanner, CSAM, kompres media, arsip, sumber waktu. |

### `src/worker/routes/` (route tipis, logika di services)
| File | Isi |
|---|---|
| `ops.ts` ★ | Ops API untuk relay (bearer `ZEIKO_OPS_TOKEN`, minimal 32 karakter, selain itu 404): overview, catalog, config, users (saldo/bonus/suspend/plan), payments, laporan + pratinjau, pemindai, iklan (gambar base64), audit. Satu-satunya pintu operator (ADR-057). |
| `public-auth.ts` ★ | `{doorUrl, siteUrl, basePath, chatUrl, turnstileSiteKey, dev}` untuk browser. |
| `dev.ts` ★ | Hanya dev: pintu tiruan `/__dev/door/*`, mailbox, cron, pembayaran mock. |
| `me.ts` ★ | Profil (`name`, `adCityCode`, `locale`), ekspor data, hapus akun. |
| `payments.ts` ★ | Webhook gateway (termasuk `zeiko`) + halaman checkout mock. |
| `share-public.ts` ★ | Link share publik `/{r64}/{s32}/{nama}` (halaman password/mati, dua bahasa). |
| `billing.ts`, `catalog.ts`, `nodes.ts`, `uploads.ts`, `download.ts`, `archive-download.ts`, `archives.ts`, `preview.ts`, `shares.ts`, `family.ts`, `compress.ts`, `ads.ts` ★, `reports.ts`, `notifications.ts`, `integrations.ts`, `health.ts` | Paket & Saldo, katalog publik, pohon file, upload, `/d/`, `/z/`, arsip async, `/p/`, share, keluarga, kompres, iklan, laporan, notifikasi, webhook Telegram/unsubscribe, health. |

### `src/worker/services/` (logika bisnis, bisa dites tanpa HTTP)
| File | Isi |
|---|---|
| `billing.ts` ★ | Ledger Saldo, top-up lewat adapter, `applyPaymentEvent`, `reconcilePayments`, langganan, dunning. |
| `admin.ts` ★ | Data untuk ops API (`grantPlan`, `dashboard()` + `costs.fixedIdr` + `assumptions`, pemindai, audit). |
| `notify.ts` ★, `share-send.ts` ★, `family.ts` ★, `ads.ts` ★ | Notifikasi, kirim link share, keluarga, iklan. URL lewat `appUrl`. |
| `email-templates.ts` | Isi email. **Masih Bahasa Indonesia saja** (tugas tersisa: ikuti `users.locale`). |
| `access.ts`, `accounts.ts`, `account.ts`, `nodes.ts`, `uploads.ts`, `download.ts`, `shares.ts`, `archive.ts`, `archives.ts`, `browse.ts`, `quota.ts`, `storage.ts`, `scan.ts`, `compress.ts`, `credits.ts`, `reports.ts`, `config.ts` | Izin node, bootstrap pool, hak UU PDP, pohon file, upload multipart, URL unduh, share, ZIP/TAR, pencarian, kuota atomik, info pool, scan, kompres, kredit, laporan, config bisnis. |

### `src/worker/lib/`, `middleware/`, `queues/`, `cron/`
| File | Isi |
|---|---|
| `lib/paths.ts` ★ | `basePath`, `appPath`, `appUrl`: semua path halaman app. |
| `lib/lang.ts` ★ | `requestLang(req)` + `strings(lang)` untuk halaman yang dirender Worker. |
| `lib/pages.ts` ★ | Halaman HTML kecil (share, password), dua bahasa. |
| `lib/errors.ts` ★ | Kode error, termasuk `SIGN_IN_EXPIRED`, `EMAIL_UNVERIFIED`, `ACCOUNTS_UNAVAILABLE`. |
| `middleware/base.ts` ★ | Header keamanan + CSP app (`connect-src` termasuk pintu Zeiko). |
| `lib/{crypto,http,serve,zip,tar,crc32,sha256,sniff,mp4,names,ids,r2-put,validate,turnstile,analytics,log}.ts` | Helper kripto, Range, streaming R2, arsip, hash, sniff MIME, nama file, ULID, log. |
| `lib/batch-guard.ts` | `guardStmt`: syarat yang membatalkan seluruh batch D1 bila tidak lagi benar (tabel `batch_guards`, ADR-056). |
| `middleware/{auth,errors,ratelimit}.ts` | Sesi, format error, rate limit. |
| `queues/{index,handlers,messages}.ts` | Konsumer queue (scan, compress, notify, …); payload berisi ID saja. |
| `cron/{index,tasks}.ts` ★ | Satu cron gabungan; tugas per jam/malam, termasuk `reconcile_payments`. |

### `src/web/` (SPA React)
| File | Isi |
|---|---|
| `router.tsx` ★ | TanStack Router `basepath: '/'`; `/` = Drive Saya, `/ai` = AI Decision, `/masuk`, `/paket`, dst. |
| `main.tsx` ★, `index.html` ★ | Bootstrap, pendaftaran service worker di `${BASE_URL}sw.js`. |
| `public/sw.js` ★, `public/manifest.webmanifest` ★ | PWA dengan scope `/`, Web Share Target; SW melewati halaman milik Worker. |
| `lib/zeiko.ts` ★ | `zeikoConfig`, `door()`, `signInSilently`, `sitePage`, `signOutOfDoor`. |
| `lib/i18n.ts` ★ | `lang`, `t`, `setLang` (cookie `zk_lang` + reload). |
| `lib/auth-client.ts` ★ | Klien Better Auth (passkey + twoFactor; OTP dihapus). |
| `lib/{api,session,types ★,catalog,files,ads,compress,explorer-store,cn}.ts` | Fetch API, `useMe`, tipe respons, katalog, unduh, iklan, kompres, state explorer. |
| `pages/SignIn.tsx` ★ | Login senyap lewat pintu; kalau belum masuk, tautan ke signin/signup situs. |
| `pages/AiDecision.tsx` ★ | Paket, sisa request, balance, dan key Pranata V1 dari pintu; kartu Zeiko Chat. |
| `pages/Settings.tsx` ★ | Akun Zeiko, pilihan bahasa, profil, notifikasi, lokasi iklan, data akun. |
| `pages/{Drive,Lists,Trash,Billing,Family,Compress,Downloads,Advertiser,Report,Legal,NotFound}.tsx` | Halaman lain (sudah dua bahasa). `Landing.tsx` **dihapus** (pindah ke website). |
| `components/AppShell.tsx` ★ | Sidebar (navigasi + "Produk Zeiko"), tombol bahasa, keluar (Better Auth + pintu). |
| `components/explorer/*`, `components/ui/*`, `components/*.tsx` | Explorer file, dialog, menu, toast, panel upload, meter, TOTP, Turnstile, iklan. |
| `upload/*` | Antrean upload multipart + resume (IndexedDB), folder, thumbnail, share target. |
| `editors/{files,ui,EditorHost}.ts(x)` | Editor (ADR-050): ambil bytes lewat URL pratinjau, simpan lewat antrean upload (baru / ganti asli → Sampah) atau unduh; bingkai layar penuh, dialog simpan; editor dimuat saat dibuka. |
| `editors/photo/*` | `adjust.ts` (atur gambar, white balance, kurva, looks), `effects.ts` (struktur, ketajaman, glow, blur lensa, vinyet, butiran, perbaiki), `geometry.ts` (potong/putar/balik/luruskan, matriks foto↔layar), `render.ts` (kanvas, teks, bingkai), `CurveEditor.tsx`, `overlays.tsx`, `panels.tsx`, `PhotoEditor.tsx` (ADR-052). |
| `editors/video/*` | `engine.ts` (mediabunny: cepat = salin paket, tepat = encode ulang WebCodecs), `timeline.ts`, `VideoEditor.tsx`. |
| `editors/text/*` | `codec.ts` (UTF-8, BOM, CRLF), `markdown.ts` (marked + DOMPurify), `TextEditor.tsx` (CodeMirror 6, bahasa dimuat saat dipakai), `text.css` (warna kode). `editors/sanitize.ts`: DOMPurify untuk HTML dari file orang. |
| `editors/doc/*` | `read.ts` (mammoth → HTML bersih), `write.ts` (docx/html → .docx; halaman HTML), `DocEditor.tsx` (TipTap), `DocxPreview.tsx` (docx-preview, dibersihkan, muat lebar layar), `picture.ts` (gambar → PNG/JPEG ≤1600 px). |
| `editors/sheet/*` | `csv.ts` (CSV/TSV: pemisah, kutip, angka yang aman), `xlsx.ts` (FortuneExcel + exceljs, angka tetap angka), `SheetEditor.tsx` (FortuneSheet), `locale.ts` + `fortune-id.ts` (teks FortuneSheet dalam bahasa Indonesia). Plugin `fortuneSheetFixes` di `vite.config.ts` membuang `new Function`. |
| `editors/zip/*` | `zip.ts` (daftar isi ZIP/ZIP64, path aman, CRC-32, inflate lewat fflate), `tree.ts` (folder dari path), `ZipViewer.tsx` (lihat, unduh satu, bongkar ke Drive lewat antrean upload). |
| `editors/pdf/*` | `ops.ts` (pdf-lib: halaman, stempel, stabilo/tutup putih, tanda air, nomor halaman, formulir, halaman kosong, gambar→PDF, kompres JPEG), `pdfjs.ts` (build legacy; halaman → gambar/teks), `PdfView.tsx` (juga pratinjau), `PdfEditor.tsx` (tab Lihat/Halaman/Isi & TTD), `PdfTools.tsx` (tab Formulir dan Alat, ADR-052), `SignaturePad.tsx`, `stamps.ts` (tanda tangan, teks, ✓/✗, gambar). |
| `pages/Tools.tsx` | `/alat`: editor untuk file dari perangkat. |

### `dev/` (menjalankan Worker asli di Node, ADR-001)
`server.ts` API dev · `env.ts` merakit Env dari shim · `vars.ts` default + `.dev.vars` · `migrate.ts` ·
`seed-demo.ts` akun demo · `shims/{d1,kv,r2,queue,misc ★}.ts` (`ShimAssets` = file atau 404, seperti
`not_found_handling: none`).

### `containers/`
`scanner/` ClamAV + hasher · `media/` ffmpeg · `archiver/` zstd + tar→zip. Ketiganya butuh Workers Paid untuk jalan
di Cloudflare.

### `tests/`
| File | Isi |
|---|---|
| `helpers/session.ts` ★ | Cookie jar, `zeikoAccountFor`, `exchange`, `signIn` lewat tiket. |
| `components/FolderGlyph.tsx`, `components/explorer/DecorDialog.tsx` | Ikon/warna folder dan dialog Dekorasi (ADR-058). |
| `helpers/ops.ts` | `OPS_KEY`, `opsCall`, `operator(rt)` (relay di test), `imageBody` (gambar iklan base64). |
| `helpers/{runtime,files,zip}.ts` | Runtime in-memory per test, beri paket, verifikasi ZIP. |
| `integration/auth.test.ts` ★, `billing.test.ts` ★, `ops.test.ts` ★ | Login tiket, pembayaran zeiko + rekonsiliasi, ops API. |
| `integration/*.test.ts` (lainnya) | Semua fitur, termasuk suite IDOR. |
| `unit/{adapters ★,lib,shared}.test.ts` | Adapter (termasuk Zeiko), helper, shared. |
| `unit/{video-engine,pdf-ops,photo-editor}.test.ts` | Editor (ADR-050): potong/gabung video dengan fixture di `tests/fixtures/video`, operasi PDF dan letak stempel, matematika foto. |
| `e2e/{auth.setup,helpers,journey.spec}.ts` | Playwright. **Rusak**: masih login lewat OTP (tugas tersisa #1). |
| `load/download.js` | k6. Belum dijalankan (kuota Workers Free). |

## C. Relay — `/root/Chtting-relay-worker` (Rust; live: `/data/data/com.termux/files/home/Chtting-relay-worker`, jangan disentuh)

Yang berkaitan dengan Drive:

| File | Isi |
|---|---|
| `CLAUDE.md` ★ | Bagian "Zeiko Drive: the third product on Zeiko Accounts" (desain lengkap). |
| `src/server/drive.rs` ★ | Tiket (`issue_ticket`), app routes `/apps/v1/*` (gate `drive.token`), pembayaran rupiah, `signature`, `tell` (callback + retry), `dashboard_routes` (`/api/zeikodrive/*` + forward ops). |
| `src/config.rs` ★ | `DriveConfig` (`url`, `token`, `apiKey`, `service`, `returnPath`, `cryptoMinIdr`) + validasi. |
| `src/accounts/mod.rs` ★ | Kolom `order_ref`/`description`, index `payments_order`, `new_drive_payment`, `DRIVE_KIND`, `fulfil` berhenti lebih awal untuk Drive. |
| `src/server/accounts.rs` ★ | `notify_payment` → `drive::tell`; tolak QRIS → `failed`; `qris_view` (`product`, `back`). |
| `src/server/auth.rs` ★ | Pintu browser: `/v1/ticket`, merge `app_routes`, `safe_next` menerima `/dashboard`. |
| `src/server/site.rs` ★ | `paid`/`my_qris` menerima service Drive. |
| `src/server/{mod,dashboard}.rs` ★ | Registrasi modul dan route dashboard. |
| `public/js/views/zeikodrive.js` ★ | Layar Zeiko Drive: Profit, Plans, Business numbers, People, Payments, Setup. |
| `public/js/{api,app}.js` ★ | Method `zeikoDrive` dan tab `zeikodrive`. |
| `tests/drive.rs` ★ | 6 test integrasi Drive. |
| `docs/CONFIG.md` ★, `config/config.example.json` ★ | Dokumentasi dan contoh blok `drive`. |

Orientasi bagian lain: `src/accounts/{logins,qris,nowpayments,referrals}.rs` (identitas, QRIS, NOWPayments,
referral) · `src/server/{zeikoaccounts,zeikochat,decision_sales,playground,provision,public,openrouter}.rs` (layar
dan pintu produk lain) · `src/decision/` (jalur Pranata V1) · `src/relay/` (jalur chat) · `src/store/` (SQLite
relay) · `public/js/views/*.js` (layar dashboard lain) · `tests/*.rs`.

## D. Website — `/root/proxychat` (statis + satu Worker; jangan sebut relay/backend di repo ini)

| File | Isi |
|---|---|
| `CLAUDE.md` ★ | Aturan larangan kata + pengecualian Drive, bagian "Zeiko Drive (`/drive`, `/dashboard`)". |
| `wrangler.jsonc` ★ | Aset `not_found_handling: "none"`, `run_worker_first` (`/models`, `/drive`, `/id/drive`, `/account*`), R2 `MODELS`; binding `DRIVE` masih komentar. |
| `src/worker.js` ★ | Meneruskan path Drive ke `DRIVE`, mengisi `/drive` dari katalog, shell `/account`, mengisi `/models` dari snapshot, `404.html`. |
| `src/drive.js` ★ | `isDrivePath`, `renderPlans`, `cheapest`, `hasFamily`. |
| `src/render.js` | Snapshot → HTML `/models` (angka saja). |
| `public/drive.html` ★, `public/id/drive.html` ★ | Halaman produk Zeiko Drive EN dan ID. |
| `public/index.html` ★ | Beranda + bagian `#drive` (blok `drive:start/end`) + kolom footer Drive. |
| `public/models.html` ★, `public/docs/*.html` ★ | Hanya ditambah link "Drive" di navigasi. |
| `public/account/index.html`, `public/js/account/app.js` ★, `views.js` ★, `payguide.js` | Area Akun Zeiko; `safeNext` (+`/dashboard`), `driveBack`, halaman QRIS untuk Drive. |
| `public/js/main.js` ★ | Tema, menu, estimator, dan cookie bahasa `zk_lang` (`[data-lang]`). |
| `public/js/try.js` | Playground Pranata V1 di beranda. |
| `public/css/style.css` ★ | Satu stylesheet; tambahan `.lang-switch`, `.drive-facts`, `.plan-price small`. |
| `scripts/check-site.mjs` ★ | Pemindai kebocoran + konsistensi harga; pengecualian Drive (`DRIVE_PAGES`, blok bertanda, path `/dashboard`). |
| `dev/sample-stats.mjs`, `public/404.html`, `public/_redirects`, `README.md` | Data contoh, 404, redirect lama, readme. |
