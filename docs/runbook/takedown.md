# Runbook: laporan & takedown

SLA (Permenkominfo 5/2020): **4 jam** untuk konten mendesak (CSAM, terorisme, konten yang meresahkan),
**1×24 jam** untuk lainnya. Timer tampil di dashboard relay → Zeiko Drive → Reports (ADR-057; Drive tidak punya
panel admin).

## Alur
1. Laporan masuk dari `/lapor` (surat resmi: operator mengisi `/lapor` sendiri, sambil login).
2. Triage di relay → Zeiko Drive → Reports. Kalau perlu melihat isi, pakai tombol tinjau (token 5 menit, tercatat di
   audit log). Tidak ada akses "lihat file user" di luar laporan.
3. Pilih tindakan: matikan link, karantina, legal hold, hapus, blokir pengunggah, masukkan hash ke
   blocklist. Selalu isi alasan.

## CSAM
- Sistem otomatis (pelapor login atau lolos Turnstile): link mati, file dikarantina + legal hold. Akun pengunggah
  dibekukan operator setelah memeriksa (aksi "blokir pengunggah"), tidak otomatis (ADR-056).
- **Jangan hapus** dan jangan unduh/teruskan file. Minimalkan siapa yang melihat.
- Laporkan ke aparat (Bareskrim Polri / Komdigi) sesuai prosedur yang berlaku, dan simpan nomor laporannya
  di catatan laporan.
- Hash masuk blocklist sehingga upload ulang langsung ditolak pemindai.

## Iklan
Laporan iklan masuk dengan target `ad`. Hentikan dari relay → Zeiko Drive → Ads → Hentikan. Untuk pelanggaran berat
sisa hari tidak dikembalikan; untuk kasus lain dikembalikan ke Saldo (config `ad_refund_on_suspend`).
