// Syarat & Ketentuan (Zeiko Drive dan Zeiko S3): the owner's text of 2026-10-25, word for word. The contacts
// and the two blanks the owner left are filled from ./contacts.ts (ADR-045).
import { LEGAL_CONTACTS_ID as C } from './contacts';

export const title = 'Syarat & Ketentuan Layanan Zeiko Drive dan Zeiko S3';

export const body = `## 1. Pendahuluan dan Definisi

Dengan mendaftar atau menggunakan Zeiko Drive maupun Zeiko S3, Anda setuju untuk terikat pada Syarat & Ketentuan ini. Jika Anda tidak setuju, mohon untuk tidak menggunakan Layanan.

Dalam dokumen ini, istilah berikut memiliki arti sebagai berikut:

- **Zeiko** atau **Kami**: pengelola dan penyedia layanan Zeiko Drive dan Zeiko S3.
- **Layanan**: Zeiko Drive (penyimpanan file berbasis web/aplikasi) dan Zeiko S3 (penyimpanan objek yang kompatibel dengan API S3), termasuk seluruh fitur, API, dan dashboard terkait.
- **Pengguna** atau **Anda**: setiap orang atau badan yang mendaftar dan/atau menggunakan Layanan.
- **Konten**: semua file, objek, data, teks, gambar, video, aplikasi, atau materi lain yang diunggah, disimpan, atau dibagikan melalui Layanan.
- **Bucket**: wadah penyimpanan objek di Zeiko S3.
- **Kredensial**: kata sandi akun, Access Key, Secret Key, token API, dan sarana autentikasi lain yang terhubung dengan akun Anda.
- **Link Publik**: tautan berbagi atau Bucket yang dapat diakses tanpa login oleh pihak lain.

## 2. Akun Pengguna

1. Anda harus berusia minimal 18 tahun, atau minimal 13 tahun dengan izin dan pengawasan orang tua/wali.
2. Data pendaftaran yang Anda berikan harus benar dan diperbarui jika berubah.
3. Satu orang boleh memiliki lebih dari satu akun, tetapi tidak boleh membuat akun baru untuk menghindari suspensi atau penghapusan akun sebelumnya.
4. Anda bertanggung jawab penuh menjaga kerahasiaan Kredensial. Seluruh aktivitas yang terjadi melalui akun atau Kredensial Anda dianggap sebagai tindakan Anda.
5. Segera hubungi Kami dan buat ulang (rotate) Access Key jika Anda menduga Kredensial bocor atau akun diakses pihak lain.
6. Akun tidak boleh dijual, disewakan, atau dipindahtangankan tanpa persetujuan tertulis dari Zeiko.

## 3. Konten dan Aktivitas yang Dilarang

Anda dilarang mengunggah, menyimpan, membagikan, atau menautkan Konten berikut melalui Layanan, dalam format apa pun dan baik bersifat privat maupun publik.

**Kategori A: Pelanggaran berat (tanpa toleransi)**

- Materi eksploitasi atau pelecehan seksual anak (CSAM), termasuk gambar buatan AI, ilustrasi, atau animasi yang menggambarkan anak secara seksual.
- Konten terorisme, ekstremisme kekerasan, atau ajakan melakukan kekerasan.
- Malware, virus, ransomware, trojan, spyware, keylogger, stealer, atau software berbahaya lain, termasuk APK yang telah dimodifikasi untuk mencuri data atau merusak perangkat.
- Halaman atau file phishing, serta materi untuk penipuan dan pencurian akun.
- Konten intim yang disebarkan tanpa persetujuan orang yang ada di dalamnya.

**Kategori B: Pelanggaran serius**

- Aplikasi, situs, atau materi promosi perjudian online dalam bentuk apa pun.
- Pornografi sebagaimana dilarang oleh peraturan perundang-undangan di Indonesia.
- Konten yang berkaitan dengan jual beli narkotika, senjata ilegal, atau barang terlarang lainnya.
- Data pribadi orang lain yang diperoleh secara tidak sah, seperti hasil kebocoran database, data KTP/KK, atau materi doxxing.
- Ujaran kebencian berbasis SARA, ancaman, atau perundungan terhadap pihak tertentu.

**Kategori C: Pelanggaran hak cipta dan penyalahgunaan layanan**

- Konten bajakan atau yang melanggar hak kekayaan intelektual, seperti film, anime, serial, musik, buku, game, atau software berbayar yang dibagikan tanpa izin pemegang hak.
- Crack, keygen, atau alat untuk membobol perlindungan lisensi software.
- Menggunakan Layanan untuk spam, hotlinking massal, atau sebagai CDN gratis bagi situs pihak ketiga yang melanggar ketentuan ini.
- Upaya meretas, menguji celah keamanan tanpa izin, membebani sistem secara sengaja, atau mengakses akun dan data pengguna lain.

Daftar di atas bukan daftar lengkap. Konten atau aktivitas lain yang melanggar hukum Republik Indonesia juga dilarang, dan Zeiko berhak menilai apakah suatu Konten termasuk pelanggaran.

## 4. Berbagi File dan Bucket Publik

1. Anda bertanggung jawab atas setiap Konten yang dibagikan melalui Link Publik atau Bucket publik, termasuk siapa saja yang mengaksesnya.
2. Link Publik dan Bucket publik yang terbukti menyebarkan Konten terlarang dapat langsung dinonaktifkan oleh Zeiko tanpa pemberitahuan terlebih dahulu.
3. Zeiko dapat membatasi bandwidth, jumlah unduhan, atau fitur Link Publik pada akun yang menunjukkan pola penyalahgunaan.
4. Jangan menyimpan data sensitif di Bucket publik. Kebocoran data akibat pengaturan akses yang Anda buat sendiri adalah tanggung jawab Anda.

## 5. Batas Penggunaan Wajar (Fair Use)

1. Setiap paket memiliki batas kapasitas penyimpanan, bandwidth, dan jumlah request API sesuai yang tercantum di halaman harga.
2. Penggunaan yang secara signifikan melebihi batas paket atau mengganggu stabilitas sistem dapat dikenai pembatasan kecepatan (throttling) sementara.
3. Jika penggunaan berlebihan terus berlanjut, Zeiko akan menghubungi Anda untuk menawarkan peningkatan paket sebelum mengambil tindakan lebih lanjut.
4. Akun gratis yang tidak aktif (tidak login dan tidak ada aktivitas API) selama 12 bulan dapat dihapus setelah diberikan pemberitahuan minimal 30 hari sebelumnya.

## 6. Prosedur Pemberitahuan dan Penghapusan Konten

Untuk pelanggaran Kategori B dan C, Zeiko akan memberi kesempatan kepada Anda untuk menghapus Konten sendiri. Pelanggaran Kategori A tidak melalui prosedur ini dan langsung ditindak sesuai Bagian 7.

1. Zeiko mengirimkan pemberitahuan ke email terdaftar dan dashboard akun Anda. Pemberitahuan memuat nama atau path file, alasan pelanggaran, dan batas waktu penghapusan.
2. Anda wajib menghapus Konten tersebut dalam waktu **24 jam** sejak pemberitahuan dikirim.
3. Selama menunggu, Zeiko dapat menonaktifkan akses publik ke Konten tersebut.
4. Jika Konten tidak dihapus dalam batas waktu, akun akan **disuspensi** sampai Konten dihapus. Selama suspensi, Anda hanya dapat login untuk menghapus Konten yang dimaksud.
5. Jika suspensi berlangsung lebih dari 14 hari tanpa tindak lanjut, Zeiko berhak menghapus Konten tersebut sendiri atau menghapus akun.

Ketidaktahuan atas pemberitahuan karena email tidak aktif atau tidak diperiksa bukan alasan yang dapat diterima. Pastikan email akun Anda selalu aktif.

## 7. Sanksi

Zeiko berhak menjatuhkan sanksi secara sepihak sesuai tingkat pelanggaran berikut.

| Kategori | Pelanggaran pertama | Pelanggaran berulang |
| --- | --- | --- |
| A (berat) | Penghapusan akun permanen tanpa peringatan, pemblokiran pendaftaran ulang, dan pelaporan ke aparat penegak hukum | Tidak berlaku (akun sudah dihapus) |
| B (serius) | Pemberitahuan dan penghapusan Konten (Bagian 6), atau suspensi langsung jika pelanggaran jelas dan disengaja | Penghapusan akun permanen |
| C (hak cipta dan penyalahgunaan) | Peringatan dan penghapusan Konten (Bagian 6) | Peringatan ke-2: suspensi 7 hari. Peringatan ke-3: penghapusan akun |

**Pelaporan ke pihak berwajib.** Untuk pelanggaran Kategori A, Zeiko akan langsung melapor tanpa pemberitahuan terlebih dahulu kepada Pengguna. Temuan CSAM dilaporkan ke National Center for Missing & Exploited Children (NCMEC) dan Kepolisian Negara Republik Indonesia, sedangkan pelanggaran Kategori A lainnya dilaporkan ke Kepolisian dan otoritas berwenang. Data yang diserahkan meliputi seluruh informasi akun (nama, email, nomor telepon, dan data pembayaran jika ada), alamat IP dan log akses, serta Konten yang terbukti melanggar. Zeiko juga akan bekerja sama dengan permintaan resmi dari aparat sesuai hukum yang berlaku.

## 8. Banding dan Keberatan

1. Jika Anda merasa tindakan Zeiko keliru, Anda dapat mengajukan banding ke ${C.support} paling lambat **7 hari** sejak sanksi dijatuhkan.
2. Sertakan username/email akun, nama file atau Bucket terkait, dan penjelasan atau bukti pendukung (misalnya bukti lisensi atau izin dari pemegang hak cipta).
3. Zeiko akan meninjau dan memberikan jawaban dalam waktu paling lama **5 hari kerja**.
4. Jika banding diterima, akun dan Konten akan dipulihkan sejauh masih memungkinkan secara teknis.
5. Pelanggaran Kategori A yang telah dilaporkan ke aparat penegak hukum tidak dapat diajukan banding melalui Zeiko.
6. Keputusan atas banding bersifat final.

## 9. Data Setelah Suspensi atau Penghapusan Akun

1. **Selama suspensi**, Konten tetap tersimpan, tetapi Link Publik, Bucket publik, dan akses API dinonaktifkan.
2. **Setelah akun dihapus karena pelanggaran Kategori B atau C**, Anda diberi waktu **7 hari** untuk mengunduh Konten lain yang tidak melanggar. Setelah itu seluruh data dihapus permanen dan tidak dapat dipulihkan.
3. **Setelah akun dihapus karena pelanggaran Kategori A**, tidak ada kesempatan mengunduh data. Data dapat disimpan sementara oleh Zeiko semata-mata untuk keperluan proses hukum.
4. **Penghapusan atas permintaan sendiri**: Anda dapat menghapus akun kapan saja melalui dashboard. Data dihapus permanen dalam waktu paling lama 30 hari.

**Pengembalian dana (refund).** Tidak ada pengembalian dana untuk akun berbayar yang disuspensi atau dihapus karena melanggar Syarat & Ketentuan ini. Sisa masa aktif paket dianggap hangus.

## 10. Privasi dan Akses terhadap File

1. Zeiko menghormati privasi Konten Anda dan tidak membuka isi file secara manual tanpa alasan yang sah.
2. Zeiko dapat menjalankan pemindaian otomatis (misalnya pencocokan hash dan pemindaian malware) untuk mendeteksi Konten terlarang, terutama pada file yang dibagikan secara publik.
3. Staf Zeiko hanya akan memeriksa isi file apabila ada laporan penyalahgunaan, hasil pemindaian otomatis yang mencurigakan, kebutuhan teknis untuk perbaikan atas permintaan Anda, atau permintaan resmi dari aparat penegak hukum. Zeiko juga mencatat alamat IP dan log akses untuk keperluan keamanan, yang dapat diserahkan kepada pihak berwajib sesuai Bagian 7.
4. Pengelolaan data pribadi Anda mengikuti Kebijakan Privasi Zeiko dan Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi.

## 11. Pelaporan Penyalahgunaan dan Hak Cipta

Siapa pun, termasuk yang bukan Pengguna, dapat melaporkan Konten yang melanggar ke **${C.abuse}** atau melalui formulir laporan di website Zeiko.

1. **Laporan umum**: sertakan link atau nama file/Bucket, jenis pelanggaran, dan bukti pendukung jika ada.
2. **Laporan hak cipta dan DMCA**: sertakan identitas pemegang hak atau kuasanya, bukti kepemilikan hak cipta, link Konten yang melanggar, serta pernyataan bahwa informasi yang diberikan benar. Zeiko menerima pemberitahuan takedown berformat DMCA maupun laporan berdasarkan Undang-Undang Nomor 28 Tahun 2014 tentang Hak Cipta. Konten yang dilaporkan secara sah akan segera dinonaktifkan dan diproses sesuai Bagian 6, dan Pengguna yang merasa laporan tersebut keliru dapat mengajukan keberatan (counter-notice) melalui Bagian 8.
3. Laporan yang lengkap akan ditindaklanjuti paling lambat **2x24 jam**. Laporan terkait Kategori A diprioritaskan dan ditangani secepatnya.
4. Laporan palsu atau yang dibuat dengan itikad buruk dapat mengakibatkan sanksi terhadap akun pelapor.

## 12. Tanggung Jawab

**Tanggung jawab Pengguna**

1. Anda bertanggung jawab penuh secara hukum atas seluruh Konten yang Anda unggah, simpan, dan bagikan.
2. Anda setuju untuk membebaskan Zeiko dari tuntutan pihak ketiga yang timbul akibat Konten atau tindakan Anda yang melanggar ketentuan ini atau hukum yang berlaku.

**Batasan tanggung jawab Zeiko**

1. Layanan disediakan "sebagaimana adanya". Zeiko berupaya menjaga ketersediaan dan keamanan data, tetapi tidak menjamin Layanan bebas gangguan atau bebas kesalahan.
2. Zeiko tidak bertanggung jawab atas kehilangan data, kerugian bisnis, atau kerugian tidak langsung lainnya, termasuk akibat gangguan teknis, serangan siber, atau kebocoran Kredensial dari pihak Anda.
3. Anda sangat disarankan untuk selalu memiliki cadangan (backup) data penting di tempat lain.
4. Untuk Pengguna berbayar, total tanggung jawab Zeiko dibatasi maksimal sebesar biaya yang Anda bayarkan dalam 3 bulan terakhir.

## 13. Ketentuan Lain

1. **Perubahan ketentuan.** Zeiko dapat memperbarui Syarat & Ketentuan ini sewaktu-waktu. Perubahan penting akan diumumkan melalui email atau dashboard minimal 7 hari sebelum berlaku. Tetap menggunakan Layanan setelah tanggal tersebut berarti Anda menyetujui perubahan.
2. **Hukum yang berlaku.** Syarat & Ketentuan ini tunduk pada hukum Republik Indonesia. Sengketa diselesaikan terlebih dahulu secara musyawarah, dan jika tidak tercapai kesepakatan, melalui pengadilan negeri di wilayah domisili Zeiko.
3. **Keterpisahan.** Jika ada ketentuan yang dinyatakan tidak berlaku, ketentuan lainnya tetap berlaku sepenuhnya.

**Kontak**

- Dukungan umum dan banding: ${C.support}
- Laporan penyalahgunaan dan hak cipta: ${C.abuse}
- Website: ${C.website}
`;
