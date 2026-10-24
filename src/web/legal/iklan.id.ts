// Kebijakan Iklan (SPEC §10.8, ADR-043). Rules and prices come from shared/ad-policy.ts and config.

export const title = 'Kebijakan Iklan';

export const body = `## Format

Iklan lokal berupa kartu kecil yang diberi label "Iklan", tidak pernah muncul di jalur upload atau download, tanpa suara, tanpa pop-up.

Jumlah iklan tidak dibatasi. Di kartu itu iklan bergantian: tiap iklan tampil beberapa detik (lihat halaman Iklan), lalu berganti ke iklan lain.

## Konten yang dilarang

- SARA dan politik; judi, slot, dan togel; penipuan dan phishing; apa pun yang membahayakan orang.
- Pinjol ilegal atau tidak terdaftar OJK; investasi atau robot trading bodong; skema ponzi/MLM; kripto spekulatif.
- Obat keras/terlarang dan klaim kesehatan menyesatkan; rokok, vape, dan alkohol; konten dewasa; senjata; barang palsu atau bajakan; joki tugas/ujian.

## Cara memasang

Kirim email ke admin@zeiko.biz.id berisi usahamu, materi iklan, kota atau Nasional, dan tanggal tayang. Kamu perlu sudah pernah masuk ke Zeiko Drive dengan Akun Zeiko, karena statistik iklanmu ada di sana.

Setiap iklan dicek manual oleh tim Zeiko, tidak otomatis. UMKM, usaha kecil, dan mahasiswa dicek lebih dulu dan tampil lebih sering dalam pergantian iklan.

Setelah disetujui, kami mengirim QRIS-nya ke emailmu. Bayar dari email itu paling lambat di hari mulai tayang; yang belum dibayar sampai hari itu lewat batal dengan sendirinya.

## Harga

Harga dihitung per hari: per kota, per paket beberapa kota, atau Nasional. Angkanya ada di halaman Iklan di Zeiko Drive, dan harga yang kamu bayar adalah harga saat iklanmu dimasukkan. Satu pengiklan boleh tayang di beberapa kota sekaligus.

## Penghentian

Iklan yang ternyata melanggar saat tayang dihentikan. Untuk pelanggaran berat sisa hari tidak dikembalikan; untuk kasus lain sisa hari dikembalikan sebagai kredit yang dipotong dari pembayaran berikutnya.

## Penargetan & data

Iklan hanya ditargetkan per kota/kabupaten atau nasional, memakai kota di Akun Zeiko penonton. Tidak ada cookie atau pelacak pihak ketiga, dan pengiklan tidak menerima data pribadi pengguna, hanya berapa kali iklannya dilihat dan diklik, per hari dan per kota.
`;
