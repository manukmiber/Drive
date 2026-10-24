// Kebijakan Privasi (Zeiko Drive dan Zeiko S3): the owner's text of 2026-10-25, word for word. The contacts
// and the two blanks the owner left are filled from ./contacts.ts (ADR-045).
import { LEGAL_CONTACTS_ID as C } from './contacts';

export const title = 'Kebijakan Privasi Zeiko Drive dan Zeiko S3';

export const body = `## 1. Ringkasan

Tim Zeiko tidak membuka atau melihat isi file Anda secara manual. Setiap file yang diunggah diperiksa oleh sistem pemindaian otomatis untuk mendeteksi malware dan materi eksploitasi seksual anak (CSAM), tanpa melibatkan manusia selama tidak ada temuan.

Kebijakan ini menjelaskan data apa yang Zeiko kumpulkan, bagaimana data itu digunakan dan dilindungi, kapan data dapat dibagikan, serta hak Anda sesuai Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP). Kebijakan ini berlaku untuk Zeiko Drive dan Zeiko S3, dan merupakan bagian dari Syarat & Ketentuan Layanan Zeiko.

## 2. Data yang Kami Kumpulkan

| Jenis data | Contoh | Sumber |
| --- | --- | --- |
| Data akun | Nama, email, username, nomor telepon (jika diisi), kata sandi dalam bentuk hash | Diberikan saat pendaftaran |
| Data pembayaran | Nama paket, riwayat transaksi, metode pembayaran. Nomor kartu lengkap diproses oleh penyedia pembayaran, bukan disimpan Zeiko | Saat berlangganan paket berbayar |
| Data teknis | Alamat IP, waktu login, user agent/perangkat, log request API dan akses file | Tercatat otomatis saat menggunakan Layanan |
| Konten | File dan objek yang Anda unggah ke Zeiko Drive atau Zeiko S3 | Diunggah oleh Anda |
| Metadata Konten | Nama file, ukuran, tipe, waktu unggah, hash file, pengaturan Link Publik atau Bucket | Dibuat otomatis oleh sistem |
| Komunikasi | Isi email ke support, laporan penyalahgunaan, pengajuan banding | Dikirim oleh Anda |

## 3. Akses terhadap File Anda

Tim Zeiko tidak membuka, membaca, atau melihat isi file Anda dalam kegiatan operasional sehari-hari. File hanya diproses oleh sistem otomatis (lihat Bagian 4).

Akses manual oleh staf Zeiko yang berwenang hanya dilakukan dalam kondisi berikut, dan terbatas pada file yang bersangkutan:

1. Sistem pemindaian otomatis menandai file sebagai kemungkinan malware atau CSAM dan perlu dikonfirmasi.
2. Ada laporan penyalahgunaan atau laporan hak cipta (termasuk DMCA) terhadap file tersebut.
3. Anda sendiri meminta bantuan teknis yang memerlukan akses ke file tertentu.
4. Ada permintaan resmi dari aparat penegak hukum atau perintah pengadilan.

Setiap akses manual dicatat dalam log internal yang mencakup siapa yang mengakses, kapan, dan alasannya.

## 4. Pemindaian Otomatis

Setiap file yang diunggah ke Zeiko Drive maupun Zeiko S3 langsung dipindai secara otomatis menggunakan layanan berikut.

| Layanan | Yang diperiksa | Data yang dikirim |
| --- | --- | --- |
| VirusTotal | Malware, virus, dan file berbahaya | Hash (sidik jari) file. File yang belum dikenal oleh VirusTotal dapat diunggah utuh untuk dianalisis |
| Cloudflare CSAM Scanning Tool | Gambar yang cocok dengan database hash CSAM yang sudah dikenal | Diproses di jaringan Cloudflare |
| Hive dan Thorn | CSAM yang sudah dikenal (pencocokan hash) maupun yang belum dikenal (klasifikasi berbasis AI) pada gambar dan video | Gambar/video atau representasinya, sesuai layanan |

Hal yang perlu Anda ketahui:

- File yang diunggah utuh ke VirusTotal dapat dibagikan oleh VirusTotal kepada komunitas keamanan dan pelanggannya. Jangan menyimpan file yang berisi informasi rahasia dalam format yang dapat dieksekusi (misalnya .exe, .apk, atau dokumen dengan macro) jika Anda tidak ingin file tersebut dianalisis pihak ketiga.
- Jika file terdeteksi sebagai malware, file dapat dikarantina dan Link Publiknya dinonaktifkan sambil menunggu tindak lanjut sesuai Syarat & Ketentuan.
- Jika file cocok dengan CSAM, file langsung diblokir dan dilaporkan sesuai Bagian 6.
- Sistem otomatis dapat keliru. Jika Anda merasa file Anda salah terdeteksi, ajukan banding sesuai Syarat & Ketentuan Bagian 8.

## 5. Penggunaan Data

Zeiko menggunakan data Anda hanya untuk tujuan berikut:

1. Menyediakan, menjalankan, dan memelihara Layanan, termasuk menyimpan dan menyajikan file Anda.
2. Mengelola akun, tagihan, dan pembayaran.
3. Menjaga keamanan Layanan, termasuk mendeteksi malware, CSAM, akses tidak sah, dan penyalahgunaan.
4. Menegakkan Syarat & Ketentuan Layanan dan memproses laporan, banding, serta permintaan takedown.
5. Mengirim pemberitahuan penting terkait akun, keamanan, dan perubahan kebijakan.
6. Memenuhi kewajiban hukum.

Zeiko **tidak** menjual data Anda, tidak menggunakan isi file Anda untuk iklan, dan tidak menggunakan isi file Anda untuk melatih model AI.

## 6. Pembagian Data kepada Pihak Ketiga

Zeiko hanya membagikan data kepada pihak berikut, sebatas yang diperlukan:

- **Penyedia pemindaian keamanan**: VirusTotal, Cloudflare, Hive, dan Thorn, untuk keperluan pemindaian sebagaimana dijelaskan di Bagian 4.
- **Penyedia infrastruktur dan pembayaran**: penyedia server, jaringan, dan pemrosesan pembayaran yang bekerja atas nama Zeiko.
- **NCMEC dan Kepolisian Negara Republik Indonesia**: jika ditemukan CSAM, Zeiko melaporkan dan menyerahkan informasi akun, alamat IP, log akses, dan Konten yang terbukti melanggar, tanpa pemberitahuan terlebih dahulu kepada Anda.
- **Aparat penegak hukum dan otoritas berwenang lainnya**: untuk pelanggaran hukum lain atau berdasarkan permintaan resmi dan perintah pengadilan.
- **Pelapor hak cipta**: hanya informasi bahwa laporan telah ditindaklanjuti. Data pribadi Anda tidak diberikan kepada pelapor tanpa dasar hukum.

**Transfer data ke luar negeri.** Sebagian penyedia di atas, termasuk VirusTotal, Cloudflare, Hive, Thorn, dan NCMEC, berada atau memproses data di luar Indonesia. Zeiko memastikan transfer tersebut dilakukan sesuai ketentuan UU PDP dan hanya kepada pihak dengan standar pelindungan data yang memadai.

## 7. Penyimpanan, Retensi, dan Keamanan

| Data | Lama disimpan |
| --- | --- |
| Konten dan metadata | Selama akun aktif. Dihapus permanen paling lama 30 hari setelah Anda menghapusnya atau menghapus akun |
| Data akun | Selama akun aktif, lalu dihapus paling lama 30 hari setelah akun dihapus |
| Log akses dan alamat IP | ${C.logRetention} |
| Data transaksi | Sesuai kewajiban hukum perpajakan dan akuntansi |
| Data terkait pelanggaran Kategori A | Selama diperlukan untuk proses hukum |

**Keamanan.** Zeiko melindungi data dengan enkripsi saat transit (HTTPS/TLS), ${C.atRest}, pembatasan akses internal berdasarkan peran, serta pencatatan setiap akses manual. Tidak ada sistem yang sepenuhnya aman, jadi Zeiko akan memberi tahu Anda dan otoritas terkait paling lambat 3x24 jam jika terjadi kegagalan pelindungan data pribadi, sesuai UU PDP.

## 8. Hak Anda

Sesuai UU PDP, Anda berhak untuk:

1. Mengetahui dan mendapatkan salinan data pribadi Anda yang Zeiko simpan.
2. Memperbarui atau memperbaiki data yang tidak akurat.
3. Menghapus data pribadi dan akun Anda.
4. Menarik kembali persetujuan atas pemrosesan data, dengan konsekuensi Layanan mungkin tidak dapat digunakan.
5. Mengajukan keberatan atas pemrosesan data tertentu.

Ajukan permintaan melalui ${C.privacy}. Zeiko akan menanggapi paling lama 3x24 jam. Hak di atas dapat dibatasi jika data diperlukan untuk proses hukum, termasuk data terkait pelanggaran Kategori A.

## 9. Ketentuan Lain

1. **Cookies.** Zeiko menggunakan cookies yang diperlukan untuk login dan keamanan sesi. Zeiko tidak menggunakan cookies iklan atau pelacak pihak ketiga.
2. **Anak-anak.** Layanan tidak ditujukan untuk anak di bawah 13 tahun. Pengguna berusia 13 sampai 17 tahun wajib mendapat izin orang tua/wali. Jika Zeiko mengetahui ada data anak yang dikumpulkan tanpa izin tersebut, data akan dihapus.
3. **Perubahan kebijakan.** Perubahan penting akan diumumkan melalui email atau dashboard minimal 7 hari sebelum berlaku.

**Kontak**

- Pertanyaan dan permintaan terkait privasi: ${C.privacy}
- Dukungan umum: ${C.support}
- Laporan penyalahgunaan: ${C.abuse}
`;
