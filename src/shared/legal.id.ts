// Policy pages (SPEC §14.5). DRAFTS — every page shows "DRAF, perlu review hukum" until a lawyer
// has reviewed them. Plain sections so they render without Markdown.
export interface LegalDoc {
  title: string;
  updated: string;
  sections: Array<{ h: string; p: string[] }>;
}

const CONTACT = 'abuse@zeiko.biz.id';

export const LEGAL: Record<string, LegalDoc> = {
  syarat: {
    title: 'Syarat & Ketentuan',
    updated: '2026-10-21',
    sections: [
      {
        h: 'Layanan',
        p: [
          'Zeiko adalah layanan penyimpanan file daring. Dengan membuat akun, kamu menyetujui syarat ini.',
        ],
      },
      {
        h: 'Akun',
        p: [
          'Kamu bertanggung jawab atas keamanan akun (email, passkey, dan kode masuk). Satu akun untuk satu orang.',
          'Kami dapat membekukan akun yang melanggar Kebijakan Konten atau hukum yang berlaku.',
        ],
      },
      {
        h: 'Paket & pembayaran',
        p: [
          'Paket berlaku bulanan dan diperpanjang otomatis dari Saldo Zeiko. Saldo hanya untuk layanan Zeiko dan tidak bisa ditarik.',
          'Jika pembayaran tidak masuk: 3 hari setelah jatuh tempo akun menjadi baca saja, hari ke-30 akses file dikunci, dan hari ke-37 file dihapus permanen. Bayar kapan saja sebelum itu untuk memulihkan akun.',
        ],
      },
      {
        h: 'Konten kamu',
        p: [
          'File tetap milikmu. Kami hanya memprosesnya untuk menyimpan, memindai keamanan, menampilkan pratinjau, dan membagikan sesuai perintahmu.',
        ],
      },
      {
        h: 'Batas tanggung jawab',
        p: [
          'Simpan cadangan untuk data yang sangat penting. Layanan disediakan apa adanya sejauh diizinkan hukum.',
        ],
      },
      {
        h: 'Perubahan',
        p: ['Perubahan penting diberitahukan lewat email minimal 14 hari sebelum berlaku.'],
      },
    ],
  },
  privasi: {
    title: 'Kebijakan Privasi',
    updated: '2026-10-21',
    sections: [
      {
        h: 'Data yang kami simpan',
        p: [
          'Email, nama, data paket dan pembayaran, metadata file (nama, ukuran, tanggal), serta file yang kamu unggah.',
          'Alamat IP disimpan dalam bentuk hash (garam harian), kecuali untuk keamanan jangka pendek seperti pembatasan percobaan masuk.',
        ],
      },
      {
        h: 'Untuk apa',
        p: [
          'Menjalankan layanan, penagihan, keamanan (pemindaian malware di infrastruktur kami sendiri; isi file tidak dikirim ke layanan pemindai pihak ketiga), dan menangani laporan penyalahgunaan.',
          'Tidak ada pelacak iklan pihak ketiga dan tidak ada profil perilaku. Iklan lokal memakai kota yang kamu pilih di Pengaturan (atas persetujuanmu, bisa dihapus kapan saja); kalau kosong, kami memakai perkiraan daerah dari alamat IP yang diberikan Cloudflare. Kami tidak pernah meminta izin GPS.',
          'Hitungan tayangan dan klik iklan tidak menyimpan ID pengguna.',
        ],
      },
      {
        h: 'Hak kamu (UU No. 27/2022)',
        p: [
          'Mengunduh salinan data (Pengaturan → Data & akun), memperbaiki data profil, dan menghapus akun (masa tunggu 7 hari).',
          'Invoice disimpan tanpa identitas setelah akun dihapus untuk memenuhi kewajiban pembukuan.',
        ],
      },
      {
        h: 'Penyimpanan',
        p: ['Data disimpan di infrastruktur Cloudflare (R2, D1). Log teknis disimpan 90 hari.'],
      },
      {
        h: 'Kebocoran data',
        p: [
          'Jika terjadi kegagalan pelindungan data pribadi, kami memberi tahu pengguna terdampak paling lambat 3×24 jam.',
        ],
      },
      { h: 'Kontak', p: [`Pertanyaan privasi: ${CONTACT}`] },
    ],
  },
  'kebijakan-konten': {
    title: 'Kebijakan Konten',
    updated: '2026-10-21',
    sections: [
      {
        h: 'Dilarang',
        p: [
          'Materi eksploitasi seksual anak (CSAM), terorisme, kekerasan ekstrem, malware, phishing, pelanggaran hak cipta, dan data pribadi orang lain tanpa hak.',
        ],
      },
      {
        h: 'Penindakan',
        p: [
          'Laporan ditinjau maksimal 1×24 jam, dan 4 jam untuk konten mendesak (Permenkominfo 5/2020). Tindakan dapat berupa menonaktifkan link, karantina, penghapusan, pemblokiran hash, atau pembekuan akun.',
          'Konten CSAM langsung dinonaktifkan, disimpan untuk proses hukum, dan dilaporkan ke pihak berwenang.',
        ],
      },
      {
        h: 'Melapor',
        p: ['Gunakan halaman Lapor Penyalahgunaan atau tombol "Laporkan" di halaman link share.'],
      },
    ],
  },
  'kebijakan-iklan': {
    title: 'Kebijakan Iklan',
    updated: '2026-10-24',
    sections: [
      {
        h: 'Format',
        p: [
          'Iklan lokal berupa kartu kecil yang diberi label "Iklan", tidak pernah muncul di jalur upload atau download, tanpa suara, tanpa pop-up.',
          'Jumlah iklan tidak dibatasi. Di kartu itu iklan bergantian: tiap iklan tampil beberapa detik (lihat halaman Iklan), lalu berganti ke iklan lain.',
        ],
      },
      {
        h: 'Konten yang dilarang',
        p: [
          'SARA dan politik; judi, slot, dan togel; penipuan dan phishing; apa pun yang membahayakan orang.',
          'Pinjol ilegal atau tidak terdaftar OJK; investasi atau robot trading bodong; skema ponzi/MLM; kripto spekulatif.',
          'Obat keras/terlarang dan klaim kesehatan menyesatkan; rokok, vape, dan alkohol; konten dewasa; senjata; barang palsu atau bajakan; joki tugas/ujian.',
        ],
      },
      {
        h: 'Cara memasang',
        p: [
          'Kirim email ke admin@zeiko.biz.id berisi usahamu, materi iklan, kota atau Nasional, dan tanggal tayang. Kamu perlu sudah pernah masuk ke Zeiko Drive dengan Akun Zeiko, karena statistik iklanmu ada di sana.',
          'Setiap iklan dicek manual oleh tim Zeiko, tidak otomatis. UMKM, usaha kecil, dan mahasiswa dicek lebih dulu dan tampil lebih sering dalam pergantian iklan.',
          'Setelah disetujui, kami mengirim QRIS-nya ke emailmu. Bayar dari email itu paling lambat di hari mulai tayang; yang belum dibayar sampai hari itu lewat batal dengan sendirinya.',
        ],
      },
      {
        h: 'Harga',
        p: [
          'Harga dihitung per hari: per kota, per paket beberapa kota, atau Nasional. Angkanya ada di halaman Iklan di Zeiko Drive, dan harga yang kamu bayar adalah harga saat iklanmu dimasukkan. Satu pengiklan boleh tayang di beberapa kota sekaligus.',
        ],
      },
      {
        h: 'Penghentian',
        p: [
          'Iklan yang ternyata melanggar saat tayang dihentikan. Untuk pelanggaran berat sisa hari tidak dikembalikan; untuk kasus lain sisa hari dikembalikan sebagai kredit yang dipotong dari pembayaran berikutnya.',
        ],
      },
      {
        h: 'Penargetan & data',
        p: [
          'Iklan hanya ditargetkan per kota/kabupaten atau nasional, memakai kota di Akun Zeiko penonton. Tidak ada cookie atau pelacak pihak ketiga, dan pengiklan tidak menerima data pribadi pengguna, hanya berapa kali iklannya dilihat dan diklik, per hari dan per kota.',
        ],
      },
    ],
  },
};
