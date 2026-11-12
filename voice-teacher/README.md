# Miss Ava — guru bahasa Inggris berbasis suara

Aplikasi web (mobile-first) untuk belajar bahasa Inggris **hanya dengan berbicara**, seperti menelepon guru pribadi.
Tidak ada kolom ketik dan tidak ada tombol kirim.

```bash
pip install -r voice-teacher/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python voice-teacher/server.py          # buka http://localhost:8000 di Chrome
```

Tanpa API key, `TEACHER_MOCK=1 python voice-teacher/server.py` menjalankan guru tiruan untuk mencoba alurnya.

Di ponsel, mikrofon hanya aktif lewat **HTTPS** (atau localhost). Deploy di belakang HTTPS, atau pakai tunnel
seperti `cloudflared tunnel --url http://localhost:8000`.

## Cara kerja

| Tahap | Teknologi |
|---|---|
| Mendengarkan murid | Web Speech API (`SpeechRecognition`) di browser, dengan transkrip langsung |
| Otak guru | Claude lewat `POST /api/turn`, balasan dialirkan (SSE) per kalimat |
| Suara guru | `speechSynthesis` browser, suara Inggris dan Indonesia dipilih per kalimat |
| Gelombang suara & memotong ucapan | `getUserMedia` + Web Audio (`AnalyserNode`) |

Satu giliran: **mendengarkan → memproses → guru berbicara → otomatis mendengarkan lagi**. Kalimat pertama guru
langsung diucapkan begitu selesai dibuat, tanpa menunggu seluruh balasan.

- **Guru tidak mendengar suaranya sendiri**: pengenalan suara dimatikan selama guru berbicara dan baru dinyalakan
  setelah suaranya selesai; hasil yang muncul sesaat sesudahnya dan isinya sama dengan kalimat terakhir guru dibuang.
- **Memotong ucapan guru**: bicara saja (dideteksi dari level mikrofon dengan echo cancellation) atau ketuk wajah guru.
- **Koreksi**: guru mengirim kartu berisi kalimat asli, kalimat benar, cara baca ala Indonesia dan penjelasan, mengucapkan
  kalimat yang benar, lalu meminta murid mengulang.
- **Penilaian pengulangan**: ucapan murid dikenali lalu dibandingkan kata per kata dengan kalimat target (skor 0–100,
  kata yang belum tepat ditandai, dan dibandingkan dengan percobaan sebelumnya). Ini menilai apakah ucapan *dikenali
  sebagai kata yang benar*, bukan analisis fonem.

## Pengaturan (env)

| Variabel | Default | Keterangan |
|---|---|---|
| `TEACHER_MODEL` | `claude-opus-5-5` | Untuk jeda paling singkat dan biaya paling rendah, coba `claude-haiku-5-5` |
| `TEACHER_EFFORT` | `low` | Effort rendah = balasan lebih cepat |
| `TEACHER_MOCK` | – | `1` = guru tiruan tanpa API |
| `PORT` / `HOST` | `8000` / `0.0.0.0` | |

## Tes

```bash
python voice-teacher/tests/test_teacher.py                       # parser balasan guru
TEACHER_MOCK=1 PORT=8765 python voice-teacher/server.py &         # lalu:
node voice-teacher/tests/e2e.cjs                                  # alur suara lengkap di Chromium (mesin suara tiruan)
```

## Dukungan browser

Chrome di Android dan desktop adalah target utama. Safari iOS mendukung API yang sama tetapi lebih terbatas.
Firefox belum punya `SpeechRecognition`, jadi aplikasi menampilkan pemberitahuan. Pengenalan suara Chrome butuh internet.
