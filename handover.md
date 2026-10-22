# Handover — Zeiko Drive di Akun Zeiko (per 2026-10-22)

Dokumen ini untuk sesi baru yang melanjutkan pekerjaan. Baca seluruhnya dulu, lalu `CLAUDE.md` di tiap repo
yang akan disentuh. Jangan mengulang pekerjaan yang ditandai selesai di sini. Peta lengkap semua file ketiga repo
ada di **`peta-file.md`**.

## 1. Konteks singkat

Zeiko Cloud Storage sekarang bernama **Zeiko Drive**. Semua fase SPEC sudah selesai, dan staging sudah jalan di
Workers Free (https://staging.zeiko.biz.id, ADR-035). Sesi terakhir menyambungkan Drive ke **Zeiko Accounts**,
sistem akun dan pembayaran yang sama dengan ZeikoAI/Zeiko Chat (ADR-036). Keputusan pemilik:

- Login Drive **sepenuhnya** lewat Akun Zeiko. OTP email dan Google di Drive dihapus.
- Harga dan Saldo Drive **tetap Rupiah**. Saldo Drive terpisah dari balance USD ZeikoAI.
- Boleh mengubah kode relay dan proxychat. Pemilik juga minta **layar Zeiko Drive di dashboard relay** untuk
  menghitung profit, mengubah paket, dan lain-lain "tanpa perlu ngoding lagi".
- Harga dan deskripsi produk pindah ke **zeiko.biz.id** (proxychat). App-nya ada di **zeiko.biz.id/dashboard**
  dan dibuka di storage; AI Decision dan produk lain ada di sidebar.
- Nama produk: **"Zeiko Drive"**. Larangan kata di proxychat berlaku untuk proyek AI; untuk Drive boleh dikecualikan.
- **Semua UI dua bahasa EN/ID**, dengan terjemahan yang sangat mudah dipahami.

## 2. Tiga repo dan statusnya

| Repo | Path | Branch | Commit terakhir | Push |
|---|---|---|---|---|
| Drive | `/root/zeiko-cloud-storage` | `main` | `c56f361` feat: Zeiko Drive on Zeiko Accounts… | tidak ada remote |
| Relay (checkout dev) | `/root/Chtting-relay-worker` | `main` | `dda5229` Zeiko Drive on Zeiko Accounts… | sudah di-push ke `origin/main` |
| Website | `/root/proxychat` | `main` | `8fbabf6` Add Zeiko Drive… | sudah di-push ke `origin/main` (deploy tetap manual: `npm run deploy`) |

Ketiga working tree bersih. **Belum ada yang di-deploy** dari pekerjaan ADR-036. Repo Drive tidak punya remote,
jadi commit-nya hanya ada di mesin ini.

**Relay live** jalan dari `/data/data/com.termux/files/home/Chtting-relay-worker` (commit lama `ac43e07`), lengkap
dengan cloudflared. **Jangan disentuh**: update, restart, edit config, atau push relay live adalah tugas pemilik,
atau harus seizinnya. `/root/Chtting-relay-worker` hanyalah checkout dev.

## 3. Arsitektur sekarang

```
Browser ── zeiko.biz.id (proxychat Worker)
            ├─ /, /models, /docs, /drive, /id/drive   halaman situs (kartu paket /drive diisi dari katalog Drive)
            ├─ /account/*                              Akun Zeiko (script bicara ke pintu auth.zeiko.biz.id)
            └─ /dashboard*, /api/*, /d/*, /z/*, /ad/*, /share-target, /<64>/<32>/…
                    └─(service binding DRIVE, BELUM dipasang)→ Worker Drive
Worker Drive ──server-to-server──> pintu relay (auth.zeiko.biz.id)
   POST /apps/v1/tickets/redeem, GET /apps/v1/accounts/{id},
   POST /apps/v1/payments, GET /apps/v1/payments/{id}        (bearer drive.token = ZEIKO_APP_TOKEN)
Relay ──callback──> {drive.url}/api/payments/webhook/zeiko
   x-zeiko-timestamp + x-zeiko-signature = hex(HMAC-SHA256(drive.apiKey, "{ts}.{body}"))
Dashboard relay (layar "Zeiko Drive") ──> {drive.url}/api/ops/*  (bearer drive.apiKey = ZEIKO_OPS_TOKEN)
```

**Alur login:**
1. Halaman Drive memanggil pintu `POST /v1/ticket {app:"drive"}` dengan cookie `zk_auth` milik browser. Ini
   mensyaratkan origin halaman ada di CORS pintu: `site.url` atau `site.auth.origins`.
2. Halaman mengirim tiket ke `POST /api/auth/zeiko/exchange`.
3. Worker Drive me-redeem tiket ke relay, lalu membuat sesi Better Auth.

Kodenya ada di `src/worker/auth.ts` (plugin `zeikoSignIn`) dan `src/web/lib/zeiko.ts`.

**Pembayaran:** adapter `zeiko` (`src/worker/adapters/zeiko.ts`) menangani QRIS dan crypto dalam rupiah, termasuk
kode unik QRIS yang ikut masuk Saldo. Konfirmasi lewat callback HMAC. Cron per jam `reconcile_payments` menanyakan
ulang pembayaran yang masih terbuka.

**Dev:** semua adapter mock. Pintu tiruan ada di `/__dev/door` (pilih akun demo di
`/__dev/door/account/signin`). Mock **ditolak di luar dev** (503).

## 4. Aturan yang wajib diikuti (dari pemilik)

- Jangan commit secret. Pakai `wrangler secret put` dan `.dev.vars` (di-ignore).
- Jangan kirim isi file user ke VirusTotal atau layanan luar mana pun.
- Jangan beri klien kredensial S3 atau presigned URL R2.
- Jangan dedup blob lintas pool/user.
- Jangan pasang iklan di jalur upload/download.
- Jangan deploy production, hapus resource remote, atau kirim pesan ke nomor/email sungguhan tanpa persetujuan
  pemilik. **Tanyakan dulu sebelum push atau deploy apa pun**, staging juga, karena perubahan ini mengganti login.
- Fitur di luar spec → catat dulu di `DECISIONS.md`.
- Pembelian butuh konfirmasi. Workers Paid sudah ditolak ("Jangan dulu"): tetap di Workers Free.
- Jangan mengubah setelan keamanan zone (Bot Fight Mode, HSTS) sendiri.
- Secret Worker Drive (`ZEIKO_APP_TOKEN`, `ZEIKO_OPS_TOKEN`, `MAIL_RELAY_TOKEN`) dipasang pemilik sendiri.
- **proxychat:** jangan pernah menyebut atau menjelaskan relay/backend di repo itu, termasuk di copy, komentar,
  dan pesan commit. Jalankan `npm run check` sebelum commit, dan perbaiki halamannya, bukan check-nya.
- **Relay:** kode dan dashboard dalam English. Desain dicatat di bagian-bagian `CLAUDE.md`. Wajib lolos
  `cargo fmt`, `clippy -D warnings`, dan test.
- **Drive:** TypeScript strict, tidak ada `node:*` di `src/worker`/`src/shared`, pihak ketiga lewat adapter + mock,
  migrasi **append-only**, dan Conventional Commits.
- Akhiri setiap pesan commit dengan:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LM6TxJnkjUNugzR5zWhUw5
  ```

## 5. Mesin ini (HP Android, PRoot aarch64)

- Jalankan `export PATH=/opt/node22/bin:$PATH` dulu. Node Termux merusak paket native.
- **workerd tidak bisa jalan**: jangan pakai `wrangler dev`, Miniflare, atau vitest-pool-workers (ADR-001).
- Port **8787** milik relay live: jangan dimatikan atau dipakai. Dev Drive memakai 8790 (API) dan 5173 (Vite).
- Disk tinggal sekitar 23 GB (90% terpakai). Cache build relay (`target/debug/incremental`) pernah dihapus karena
  disk penuh. Jangan menyalakan incremental lagi.
- Jangan merangkai `sleep` panjang. Pakai perintah background dan tunggu notifikasinya.
- **Build relay dari PRoot** butuh wrapper berikut. Wrapper lama ada di scratchpad sesi sebelumnya dan sudah
  hilang, jadi buat lagi, misalnya di scratchpad sesi baru:
  ```sh
  #!/bin/sh
  export PATH=/data/data/com.termux/files/usr/bin:$PATH
  export CC=/data/data/com.termux/files/usr/bin/clang CXX=/data/data/com.termux/files/usr/bin/clang++ AR=/data/data/com.termux/files/usr/bin/llvm-ar
  export CFLAGS="--target=aarch64-linux-android24" CXXFLAGS="--target=aarch64-linux-android24"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=/data/data/com.termux/files/usr/bin/clang
  export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
  cd /root/Chtting-relay-worker && exec nice -n 10 cargo "$@"
  ```
  Pakai `-j1`/`-j2`; `-j3` kena "Bus error" saat linking. Contoh: `relay-cargo.sh test -j2 --test drive`.

## 6. Cara verifikasi (hasil terakhir)

| Repo | Perintah | Hasil terakhir |
|---|---|---|
| Drive | `npm run typecheck && npm run lint && npx vitest run && npm run build` | bersih, **149/149** test, SPA di `dist/web/dashboard` |
| Relay | `relay-cargo.sh clippy -j2 --all-targets -- -D warnings`, `cargo fmt --all --check` | bersih |
| Relay | `relay-cargo.sh test -j2` | 856 lolos, 4 gagal (lihat di bawah); `tests/drive.rs` 6/6 |
| proxychat | `npm run check` | bersih (25 file) |

Empat test relay yang gagal bukan dari perubahan ini:
- `rotate::tests::the_pidfile_is_a_hint…`, `system::tests::only_the_two_named_packages_may_be_installed` ("Cannot
  run 'pkg' command as root"), dan `relay::hundreds_of_concurrent_callers…` juga **gagal di commit asli `ac43e07`**
  (lingkungan PRoot/HP sibuk).
- `playground_setup::the_settings_refuse…` flaky di kedua versi: gagal 1 dari 4 kali di commit asli, 2 dari 3 kali
  di cabang baru.

**Belum dicoba di browser:** UI Drive di bawah `/dashboard` (login lewat pintu tiruan, AI Decision, sidebar,
ganti bahasa) dan layar Zeiko Drive di dashboard relay. Yang sudah dicek baru test unit/integrasi dan uji routing
Worker situs di Node.

## 7. Pekerjaan tersisa (urut prioritas)

### Drive (`/root/zeiko-cloud-storage`)
1. **E2E Playwright rusak**: `tests/e2e/helpers.ts` dan `auth.setup.ts` masih login lewat form OTP yang sudah
   dihapus. Ganti ke pintu tiruan `/__dev/door/account/signin`, dan sesuaikan URL ke `/dashboard/...`.
2. **Coba UI di browser** (dev: `npm run dev`, buka http://localhost:5173/dashboard/):
   - login dengan akun demo;
   - upload dan share;
   - top-up yang memakai payment mock;
   - halaman `/dashboard/ai`;
   - tombol bahasa;
   - keluar.

   Perbaiki yang rusak.
3. **Email dua bahasa** menurut `users.locale` (kolom sudah ada lewat migrasi `0004`). Template email dan halaman
   pembayaran dev masih Bahasa Indonesia saja.
4. **Skrip deploy:**
   - Di `scripts/cf-setup.mjs`, `OWNER_SECRETS` masih memuat `GOOGLE_CLIENT_ID/SECRET` (sudah tidak dipakai) dan
     belum memuat `ZEIKO_APP_TOKEN`, `ZEIKO_OPS_TOKEN`.
   - Tinjau apakah `TURNSTILE_SECRET_KEY` masih dipakai, karena captcha login sudah dihapus.
   - Perbarui `DEPLOY.md` dan `docs/SECURITY.md` untuk model login baru: tiket, mock ditolak di luar dev,
     HMAC callback, ops bearer, dan CSP `connect-src` ke pintu.
5. Sisa teks UI yang mungkin masih tertulis langsung di komponen. Cari dengan
   `grep -rnE "aria-label=\"[A-Z]|placeholder=\"[A-Za-z]" src/web`.
   Setiap string baru wajib ada di **`strings.id.ts` dan `strings.en.ts`**.

### Relay (`/root/Chtting-relay-worker`)
6. Coba layar **Zeiko Drive** (`public/js/views/zeikodrive.js`) di browser terhadap Drive dev, dengan
   `drive.url` = `http://localhost:8790` dan ops key di `.dev.vars` Drive.
7. (Selesai: `dda5229` sudah di-push. Push berikutnya tetap minta izin dulu.)

### Website (`/root/proxychat`)
8. **EN/ID untuk seluruh situs**: baru `/drive` ↔ `/id/drive` yang dua bahasa. Beranda, `/models`, `/docs/*`, dan
   area `/account` masih English.
   - Pola yang dipakai: halaman statis `public/id/…`, link `.lang-switch` dengan `data-lang`, dan cookie `zk_lang`
     yang diset `main.js`, dibaca bersama dengan Drive.
   - Halaman `/id/…` yang perlu diisi worker harus ditambahkan ke `run_worker_first`.
9. Setelah Worker Drive production ada (dan diizinkan): pasang
   `"services": [{ "binding": "DRIVE", "service": "zeiko-production" }]` di `wrangler.jsonc`. Sampai itu,
   `/dashboard` mengarah ke `/drive`.
10. (Selesai: `8fbabf6` sudah di-push, tapi **belum di-deploy**. Deploy ke zeiko.biz.id = production, minta izin.)

## 8. Menunggu pemilik (jangan dikerjakan sendiri)

1. Perbarui relay live ke `dda5229` (sudah ada di GitHub, `git pull` atau `bash install.sh`) dan restart.
2. Di dashboard relay → **Zeiko Drive → Setup**:
   - isi url `https://staging.zeiko.biz.id`;
   - mint `token` dan `apiKey`;
   - jalankan `wrangler secret put ZEIKO_APP_TOKEN --env staging` dan
     `wrangler secret put ZEIKO_OPS_TOKEN --env staging`.
3. Tambahkan `https://staging.zeiko.biz.id` ke `site.auth.origins` relay.
4. Setelah tiga langkah di atas (dan izin pemilik), deploy staging Drive:
   - `npm run db:migrate:staging` (migrasi `0004`);
   - `npm run deploy:staging`.

   Lalu smoke test: login lewat Akun Zeiko, top-up QRIS yang dibayar manual di relay, dan Saldo bertambah.
5. Production Drive dan deploy proxychat ke zeiko.biz.id: **menunggu persetujuan**. Apex zeiko.biz.id adalah situs
   proxychat; Drive akan masuk lewat service binding.
6. Pengingat untuk pemilik: pindahkan isi `/root/zeiko-mailboxes.txt` ke password manager lalu hapus filenya.
   Sebagian isinya pernah tampil di sesi sebelumnya. **Jangan dibuka atau ditampilkan.**

## 9. Jebakan yang perlu diingat

- **Staging Drive berdiri sendiri** di `staging.zeiko.biz.id` dengan custom domain miliknya. Di sana Worker Drive
  sendiri mengalihkan `/` → `/dashboard/`.
  - Jangan pasang route proxychat ke hostname yang sama; dua custom domain akan bentrok.
  - SSO tetap jalan di staging karena `auth.zeiko.biz.id` dan `staging.zeiko.biz.id` masih satu *site*
    (zeiko.biz.id), sehingga cookie `SameSite=Lax` ikut terkirim. Syaratnya origin staging ada di
    `site.auth.origins`.
- **Routing aset di proxychat:** `not_found_handling: "none"` disengaja. Dengan `404-page` atau SPA, request
  navigasi ke path yang tidak ada **tidak** sampai ke Worker, sehingga link share dan `/dashboard` akan dapat 404.
  Worker menjawab `404.html` sendiri.
- **Worker Drive:** `not_found_handling: 'none'`. `app.ts` menyajikan `${APP_BASE_PATH}/index.html` untuk navigasi
  di bawah `/dashboard/*` dan mengalihkan `/` → `/dashboard/`. Build bersih `dist/web` dulu (skrip `build` sudah
  menghapusnya).
- **Path app** selalu lewat `appPath`/`appUrl` (`src/worker/lib/paths.ts`). URL di email, link share, notifikasi,
  dan iklan harus menyertakan `/dashboard`.
- **i18n:**
  - Web: `t` dari `src/web/lib/i18n.ts`. Bahasa dibaca sekali saat start; mengganti bahasa memanggil `setLang`,
    yang menyimpan cookie dan me-reload halaman.
  - Halaman yang dirender Worker: `requestLang` + `strings()` (`src/worker/lib/lang.ts`).
  - Bahasa juga disimpan di `users.locale` lewat `PATCH /api/me {locale}`.
- **check-site proxychat:**
  - Kata storage, rupiah, dan pay/paid hanya boleh di `drive.html`, `id/drive.html`, dan blok
    `<!-- drive:start -->…<!-- drive:end -->`.
  - `/dashboard` boleh sebagai path di mana saja, tapi kata "dashboard" sendirian tetap dilarang.
  - "worker" juga dilarang, termasuk di komentar HTML.
- **Area akun proxychat:**
  - `safeNext` mengizinkan `/dashboard…`, termasuk `%` di query karena halaman masuk Drive membawa `next` yang
    di-encode.
  - `driveBack` hanya menerima `back` dari pintu kalau origin-nya sama atau subdomain situs dan path-nya di bawah
    `/dashboard`.
- **Kartu paket di `/drive`** dirender `src/drive.js` dari `GET /api/public/catalog` Drive lewat binding. Nama
  paket di-escape, angka diformat di sana. Paket Keluarga masih **nonaktif** di katalog, jadi bagian keluarga
  disembunyikan otomatis (`data-drive-family`).
- **Relay:**
  - Kolom baru `accounts.db` masuk `ADDED_COLUMNS` dan `CREATE_SQL`. Unique index `payments_order` dibuat setelah
    kolomnya ada.
  - `fulfil` untuk `kind = drive` tidak menyentuh plan atau credit.
  - Rupiah persis disimpan di `local_amount` untuk QRIS maupun crypto. Jangan hitung ulang dari dolar: dulu itu bug
    yang membuat jumlah tidak cocok dengan pengecekan di Drive.
- **Halaman AI Decision** (`src/web/pages/AiDecision.tsx`) membaca pintu `/v1/account` (plan, `usage`
  `{used, amount, resetsAt}`, balance, key, chat) dan `/v1/key` → `{key}`. Bentuk datanya sudah dicocokkan dengan
  `site.rs`/`auth.rs`, tapi belum dicoba di browser.

## 10. Peta file penting (versi lengkap: `peta-file.md`)

**Drive**
- `DECISIONS.md` ADR-036, beserta catatan tambahan di bawahnya.
- `PROGRESS.md` bagian "Zeiko Drive di Akun Zeiko".
- `src/worker/auth.ts`: login tiket.
- `src/worker/adapters/zeiko.ts`: akun dan pembayaran lewat relay.
- `src/worker/routes/ops.ts`: ops API untuk relay.
- `src/worker/routes/dev.ts`: pintu tiruan.
- `src/worker/services/billing.ts`: `reconcilePayments`.
- `src/worker/app.ts`: fallback SPA `/dashboard`.
- `src/worker/lib/{paths,lang}.ts`.
- `src/web/router.tsx`: basepath `/dashboard`, route `/ai`.
- `src/web/components/AppShell.tsx`: sidebar produk, bahasa, keluar.
- `src/web/pages/{SignIn,AiDecision,Settings}.tsx`.
- `src/web/lib/{zeiko,i18n}.ts`.
- `src/shared/strings.{id,en}.ts`.
- `migrations/0004_zeiko_accounts_locale.sql`.
- `scripts/gen-wrangler.mjs`: variabel Zeiko dan `not_found_handling`.
- Test: `tests/integration/{auth,billing,ops}.test.ts`, `tests/unit/adapters.test.ts`.

**Relay**
- `CLAUDE.md` bagian "Zeiko Drive: the third product on Zeiko Accounts".
- `src/server/drive.rs`, `src/config.rs` (`DriveConfig`), `src/accounts/mod.rs`.
- `src/server/{accounts,auth,site,dashboard}.rs`.
- `public/js/views/zeikodrive.js`.
- `tests/drive.rs`.
- `docs/CONFIG.md`, `config/config.example.json`.

**proxychat**
- `CLAUDE.md` bagian "Zeiko Drive (`/drive`, `/dashboard`)".
- `src/worker.js`, `src/drive.js`.
- `public/drive.html`, `public/id/drive.html`.
- `public/js/account/{app,views}.js`: `safeNext`, `driveBack`.
- `public/js/main.js`: cookie bahasa.
- `scripts/check-site.mjs`: pengecualian Drive.
- `wrangler.jsonc`.
