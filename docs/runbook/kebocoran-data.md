# Runbook: dugaan kebocoran data pribadi

Dasar: UU PDP No. 27/2022 Pasal 46. Pemberitahuan tertulis ke subjek data dan lembaga pengawas
**paling lambat 3×24 jam** sejak kebocoran diketahui.

## 0. Catat waktu
Tulis jam saat pertama kali tahu (WIB). Hitungan 72 jam mulai dari sini.

## 1. Bendung (≤ 1 jam)
- Putuskan sumbernya: cabut token/API key yang bocor, matikan endpoint yang bermasalah (deploy
  revert atau `features.*` di Admin → Config), blokir akun penyerang (Admin → Pengguna → Bekukan).
- Logout semua sesi kalau sesi ikut terdampak:
  `npx wrangler d1 execute zeiko-production --remote --command "DELETE FROM sessions"`.
- Rotasi secret yang terdampak sesuai `rotasi-secret.md`.
- **Jangan hapus** log, audit log, atau objek R2 yang jadi bukti.

## 2. Nilai dampak (≤ 24 jam)
- Data apa: email, nama, nomor WA, isi file, metadata file, data pembayaran (Zeiko tidak menyimpan
  data kartu; pembayaran ada di gateway).
- Siapa dan berapa orang (query D1 + `audit_logs`), dan sejak kapan.
- Simpan hasil di dokumen insiden (tanggal, kronologi, keputusan, siapa yang memutuskan).

## 3. Beri tahu (≤ 72 jam)
- **Subjek data**: email ke pengguna terdampak berisi data apa yang bocor, kapan, dan langkah yang
  sudah kami ambil serta yang perlu mereka lakukan (mis. waspada phishing).
- **Lembaga pengawas PDP / Komdigi** sesuai prosedur yang berlaku saat itu.
- Kalau ada unsur pidana: lapor ke kepolisian (Direktorat Tindak Pidana Siber).

## 4. Pulihkan & cegah
- Perbaiki akar masalah, tambah tes regresinya, dan jalankan ulang audit keamanan (`docs/SECURITY.md`).
- Tulis postmortem tanpa menyalahkan individu.
