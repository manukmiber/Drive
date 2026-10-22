# Runbook: laporan & takedown

SLA (Permenkominfo 5/2020): **4 jam** untuk konten mendesak (CSAM, terorisme, konten yang meresahkan),
**1×24 jam** untuk lainnya. Timer tampil di Admin → Laporan.

## Alur
1. Laporan masuk dari `/lapor` (atau surat resmi → buat laporan manual di Admin).
2. Triage di Admin → Laporan. Kalau perlu melihat isi, pakai tombol tinjau (token 5 menit, tercatat di
   audit log). Tidak ada akses "lihat file user" di luar laporan.
3. Pilih tindakan: matikan link, karantina, legal hold, hapus, blokir pengunggah, masukkan hash ke
   blocklist. Selalu isi alasan.

## CSAM
- Sistem otomatis: link mati, file dikarantina + legal hold, akun pengunggah dibekukan.
- **Jangan hapus** dan jangan unduh/teruskan file. Minimalkan siapa yang melihat.
- Laporkan ke aparat (Bareskrim Polri / Komdigi) sesuai prosedur yang berlaku, dan simpan nomor laporannya
  di catatan laporan.
- Hash masuk blocklist sehingga upload ulang langsung ditolak pemindai.

## Iklan
Laporan iklan masuk dengan target `ad`. Hentikan dari Admin → Iklan → Hentikan. Untuk pelanggaran berat
sisa hari tidak dikembalikan; untuk kasus lain dikembalikan ke Saldo (config `ad_refund_on_suspend`).
